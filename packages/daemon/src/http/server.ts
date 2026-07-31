import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  CoverageResponse,
  EvidenceResponse,
  HealthResponse,
  TaskAnalysisResponse,
  WorkItemsResponse,
} from '@session-radar/shared';
import {
  DEFAULT_HISTORY_WINDOW_MS,
  hookIngestSchema,
  rollupCoverage,
  taskAnalysisRequestSchema,
} from '@session-radar/shared';
import type { EventBus, BusEnvelope } from '../bus.js';
import type { TaskAnalysis } from '../analysis/service.js';
import type { HookIngest } from '../connectors/ingest.js';
import type { WebIngest } from '../connectors/web/ingest.js';
import type { Logger } from '../logger.js';
import type { ConnectorRegistry } from '../registry.js';
import type { Store } from '../store.js';
import { DAEMON_VERSION } from '../version.js';
import { Router } from './router.js';
import { checkRequest, defaultAllowedOrigins } from './security.js';
import { serveStatic } from './static.js';

export interface ApiServerOptions {
  store: Store;
  bus: EventBus;
  registry: ConnectorRegistry;
  logger: Logger;
  host: string;
  port: number;
  /** Extra origins (the M2 extension). Loopback origins are always allowed. */
  allowedOrigins?: string[];
  /** Absent until at least one collector is registered. */
  ingest?: HookIngest;
  /** Absent when the web surfaces are not registered. */
  webIngest?: WebIngest;
  /** Explicit per-item source-result reader. It must never persist raw content. */
  taskAnalysis: TaskAnalysis;
  db: { path: string; journalMode: string; fileMode: string; schemaVersion: number };
  /** Directory holding the built dashboard. Absent disables static serving. */
  dashboardDir?: string;
}

/** Hook payloads are tiny; anything larger is a bug or an attack. */
const MAX_BODY_BYTES = 256 * 1024;
/**
 * Two capped 1,000-row metadata-only account inventories can share a Claude
 * heartbeat. This exception applies only to the pinned-extension route, not CLI
 * hook ingestion.
 */
const MAX_WEB_BODY_BYTES = 2 * 1024 * 1024;

/** Heartbeat comment so proxies and sleeping laptops do not silently kill the stream. */
const SSE_KEEPALIVE_MS = 15_000;

export class ApiServer {
  private readonly server: Server;
  private readonly router = new Router();
  private readonly startedAt = Date.now();
  private readonly sseClients = new Set<ServerResponse>();
  private readonly extraOrigins: string[];
  private boundPort: number | undefined;

  constructor(private readonly options: ApiServerOptions) {
    this.extraOrigins = options.allowedOrigins ?? [];
    this.registerRoutes();
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  /**
   * Computed from the port we actually bound to, not the one we asked for —
   * with port 0 the OS picks, and a stale allowlist would 403 the dashboard.
   */
  private get allowedOrigins(): string[] {
    return [
      ...defaultAllowedOrigins(this.options.host, this.boundPort ?? this.options.port),
      ...this.extraOrigins,
    ];
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        if (error.code === 'EADDRINUSE') {
          reject(
            new Error(
              `port ${this.options.port} is already in use — another session-radar daemon is probably running`,
            ),
          );
          return;
        }
        reject(error);
      };
      this.server.once('error', onError);
      // Loopback only. Never 0.0.0.0: this API has no authentication by design.
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    this.boundPort = this.address().port;
    return this.boundPort;
  }

  address(): AddressInfo {
    const addr = this.server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('server is not listening on a TCP port');
    }
    return addr;
  }

  async close(): Promise<void> {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    const closed = new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    // `server.close()` alone waits for every idle keep-alive socket to time out
    // on its own — several seconds per client. Shutdown must not be at the mercy
    // of a browser tab that is holding a pooled connection open.
    this.server.closeAllConnections();
    await closed;
  }

  private registerRoutes(): void {
    this.router.get('/api/health', (_req, res) => {
      const body: HealthResponse = {
        ok: true,
        version: DAEMON_VERSION,
        startedAt: this.startedAt,
        uptimeMs: Date.now() - this.startedAt,
        db: {
          path: this.options.db.path,
          journalMode: this.options.db.journalMode,
          fileMode: this.options.db.fileMode,
          schemaVersion: this.options.db.schemaVersion,
        },
        connectorCount: this.options.registry.size,
      };
      sendJson(res, 200, body);
    });

    this.router.get('/api/coverage', (_req, res) => {
      sendJson(res, 200, this.coverageResponse());
    });

    this.router.get('/api/workitems', (_req, res, match) => {
      const history = match.query.get('history') ?? 'recent';
      if (history !== 'recent' && history !== 'all') {
        sendJson(res, 400, {
          error: 'bad_request',
          detail: 'history must be "recent" or "all"',
        });
        return;
      }
      const items = this.options.store.listWorkItems(
        history === 'all' ? undefined : Date.now() - DEFAULT_HISTORY_WINDOW_MS,
      );
      const body: WorkItemsResponse = {
        generatedAt: Date.now(),
        count: items.length,
        items,
        // Bundled so a single fetch can never render a confident-looking empty list
        // while a connector is down.
        coverage: this.coverageResponse(),
      };
      sendJson(res, 200, body);
    });

    this.router.get('/api/workitems/:id', (_req, res, match) => {
      const item = this.options.store.getWorkItem(match.params['id'] ?? '');
      if (!item) {
        sendJson(res, 404, { error: 'not_found', detail: 'no such work item' });
        return;
      }
      sendJson(res, 200, item);
    });

    this.router.get('/api/workitems/:id/evidence', (_req, res, match) => {
      const id = match.params['id'] ?? '';
      const item = this.options.store.getWorkItem(id);
      if (!item) {
        sendJson(res, 404, { error: 'not_found', detail: 'no such work item' });
        return;
      }
      const body: EvidenceResponse = {
        workItemId: id,
        evidence: this.options.store.listEvidence(id),
        transitions: this.options.store.listTransitions(id),
      };
      sendJson(res, 200, body);
    });

    /** Explicit per-task analysis. The literal `authorize: true` is mandatory. */
    this.router.post('/api/workitems/:id/analyze', async (req, res, match) => {
      const id = match.params['id'] ?? '';
      const item = this.options.store.getWorkItem(id);
      if (!item) {
        sendJson(res, 404, { error: 'not_found', detail: 'no such work item' });
        return;
      }

      const parsed = taskAnalysisRequestSchema.safeParse(await readJsonBody(req));
      if (!parsed.success) {
        sendJson(res, 400, {
          error: 'bad_request',
          detail: parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; '),
        });
        return;
      }

      const body: TaskAnalysisResponse = await this.options.taskAnalysis.analyze(
        item,
        parsed.data.requestedFields,
      );
      sendJson(res, 200, body);
    });

    this.router.get('/api/events', (req, res) => {
      this.openEventStream(req, res);
    });

    // Dashboard-local acknowledgement. Writes nothing to any source.
    this.router.post('/api/workitems/:id/seen', async (req, res, match) => {
      const body = await readJsonBody(req);
      const attention =
        typeof body === 'object' && body !== null && (body as { attention?: unknown }).attention === 'unseen'
          ? 'unseen'
          : 'seen';
      const ok = this.options.store.setAttention(match.params['id'] ?? '', attention);
      if (!ok) {
        sendJson(res, 404, { error: 'not_found', detail: 'no such work item' });
        return;
      }
      sendJson(res, 200, { ok: true, attention });
    });

    // Hook shim endpoint. This is the ONLY write path into the daemon, and it
    // still writes nothing back to any source.
    this.router.post('/api/hooks', async (req, res) => {
      const ingest = this.options.ingest;
      if (!ingest) {
        sendJson(res, 503, { error: 'ingest_unavailable', detail: 'no connectors registered' });
        return;
      }
      const body = await readJsonBody(req);
      const parsed = hookIngestSchema.safeParse(body);
      if (!parsed.success) {
        sendJson(res, 400, {
          error: 'bad_request',
          detail: parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
        });
        return;
      }
      const result = ingest.handle(
        parsed.data.connector,
        parsed.data.payload,
        parsed.data.at ?? Date.now(),
      );
      sendJson(res, result.accepted ? 202 : 422, result);
    });

    // Raw endpoints: first-party HTTP hooks and the Codex dispatcher POST their
    // payload verbatim, with no envelope to wrap it in.
    this.router.post('/api/hooks/claude-code', async (req, res) => {
      await this.ingestRaw(req, res, 'claude-code-cli');
    });
    this.router.post('/api/hooks/codex', async (req, res) => {
      await this.ingestRaw(req, res, 'codex-cli');
    });
    this.router.post('/api/hooks/grok-build', async (req, res) => {
      await this.ingestRaw(req, res, 'grok-build-cli');
    });

    // The browser extension's service worker posts here. Its origin is checked
    // by the shared allowlist before this handler is ever reached.
    this.router.post('/api/hooks/web', async (req, res) => {
      const webIngest = this.options.webIngest;
      if (!webIngest) {
        sendJson(res, 503, { error: 'ingest_unavailable', detail: 'web surfaces not registered' });
        return;
      }
      const body = await readJsonBody(req, MAX_WEB_BODY_BYTES);
      if (body === undefined) {
        sendJson(res, 400, { error: 'bad_request', detail: 'body must be JSON' });
        return;
      }
      const result = webIngest.handle(body, Date.now());
      sendJson(res, result.accepted ? 202 : 422, result);
    });
  }

  private async ingestRaw(
    req: IncomingMessage,
    res: ServerResponse,
    connector: string,
  ): Promise<void> {
    const ingest = this.options.ingest;
    if (!ingest) {
      sendJson(res, 503, { error: 'ingest_unavailable', detail: 'no collectors registered' });
      return;
    }
    const body = await readJsonBody(req);
    if (body === undefined) {
      sendJson(res, 400, { error: 'bad_request', detail: 'body must be JSON' });
      return;
    }
    const result = ingest.handle(connector, body, Date.now());
    sendJson(res, result.accepted ? 202 : 422, result);
  }

  private coverageResponse(): CoverageResponse {
    const connectors = this.options.store.listCoverage();
    return {
      generatedAt: Date.now(),
      overall: rollupCoverage(connectors),
      connectorCount: connectors.length,
      connectors,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const verdict = checkRequest(req, { allowedOrigins: this.allowedOrigins });
    if (!verdict.ok) {
      this.options.logger.warn('request rejected', {
        error: verdict.error,
        host: req.headers.host,
        origin: req.headers.origin,
      });
      sendJson(res, verdict.status, { error: verdict.error, detail: verdict.detail });
      return;
    }
    if (verdict.allowOrigin) {
      res.setHeader('Access-Control-Allow-Origin', verdict.allowOrigin);
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const resolved = this.router.resolve(req.method ?? 'GET', url.pathname, url.searchParams);

    if ('error' in resolved) {
      // Anything that is not an API route belongs to the dashboard SPA.
      if (
        resolved.error === 'not_found' &&
        !url.pathname.startsWith('/api/') &&
        this.options.dashboardDir &&
        (req.method === 'GET' || req.method === 'HEAD')
      ) {
        serveStatic(this.options.dashboardDir, url.pathname, res);
        return;
      }
      const status = resolved.error === 'not_found' ? 404 : 405;
      sendJson(res, status, { error: resolved.error, detail: `${req.method} ${url.pathname}` });
      return;
    }

    try {
      await resolved.handler(req, res, resolved.match);
    } catch (error) {
      // A handler bug must not take the daemon down or leave a hung socket.
      this.options.logger.error('request handler threw', {
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error', detail: 'see daemon logs' });
      } else {
        res.end();
      }
    }
  }

  private openEventStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    // The snapshot goes out first so a client that connects late is never left
    // rendering an empty screen while waiting for the next change.
    writeSse(res, {
      event: 'hello',
      at: Date.now(),
      data: {
        version: DAEMON_VERSION,
        coverage: this.coverageResponse(),
        workItemCount: this.options.store.countWorkItems(),
      },
    });

    this.sseClients.add(res);

    const unsubscribe = this.options.bus.subscribe((envelope) => {
      writeSse(res, envelope);
    });

    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, SSE_KEEPALIVE_MS);
    keepalive.unref?.();

    const cleanup = (): void => {
      clearInterval(keepalive);
      unsubscribe();
      this.sseClients.delete(res);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  get eventClientCount(): number {
    return this.sseClients.size;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function writeSse(res: ServerResponse, envelope: BusEnvelope): void {
  if (res.writableEnded) return;
  res.write(`event: ${envelope.event}\n`);
  res.write(`data: ${JSON.stringify({ at: envelope.at, data: envelope.data })}\n\n`);
}
