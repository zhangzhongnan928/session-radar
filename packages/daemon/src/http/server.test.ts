import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CoverageResponse,
  HealthResponse,
  TaskAnalysisResponse,
  WorkItemsResponse,
} from '@session-radar/shared';
import { canonicalKey, DEFAULT_HISTORY_WINDOW_MS } from '@session-radar/shared';
import type { Daemon } from '../daemon.js';
import { startDaemon } from '../daemon.js';
import { createNullLogger } from '../logger.js';
import type { Connector, ConnectorScanResult } from '../registry.js';
import { createTempHome, decisionFixture } from '../testing.js';

const AT = 1_800_000_000_000;

describe('HTTP API — zero connectors (the M0 acceptance gate)', () => {
  let home: ReturnType<typeof createTempHome>;
  let daemon: Daemon;

  beforeEach(async () => {
    home = createTempHome();
    daemon = await startDaemon({ port: 0, logger: createNullLogger(), withoutDefaultConnectors: true });
  });

  afterEach(async () => {
    await daemon.stop();
    home.restore();
  });

  it('serves coverage with an empty registry instead of crashing', async () => {
    const res = await fetch(`${daemon.baseUrl}/api/coverage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CoverageResponse;
    expect(body.connectors).toEqual([]);
    expect(body.connectorCount).toBe(0);
    // Not "ok" — zero connectors means we are watching nothing, and it must say so.
    expect(body.overall).toBe('no_connectors');
    expect(body.generatedAt).toBeGreaterThan(0);
  });

  it('serves an empty work item list alongside the coverage verdict', async () => {
    const res = await fetch(`${daemon.baseUrl}/api/workitems`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkItemsResponse;
    expect(body.items).toEqual([]);
    expect(body.count).toBe(0);
    // The empty list is never served bare: coverage rides along so a client
    // cannot render "all clear" while the radar is blind.
    expect(body.coverage.overall).toBe('no_connectors');
  });

  it('reports health including db mode and journal mode', async () => {
    const res = await fetch(`${daemon.baseUrl}/api/health`);
    const body = (await res.json()) as HealthResponse;
    expect(body.ok).toBe(true);
    expect(body.db.fileMode).toBe('0600');
    expect(body.db.journalMode.toLowerCase()).toBe('wal');
    expect(body.db.schemaVersion).toBeGreaterThan(0);
    expect(body.connectorCount).toBe(0);
  });

  it('404s unknown paths and 405s wrong methods', async () => {
    expect((await fetch(`${daemon.baseUrl}/api/nope`)).status).toBe(404);
    expect((await fetch(`${daemon.baseUrl}/api/coverage`, { method: 'POST' })).status).toBe(405);
  });

  it('404s an unknown work item and its evidence', async () => {
    expect((await fetch(`${daemon.baseUrl}/api/workitems/wi_nope`)).status).toBe(404);
    expect((await fetch(`${daemon.baseUrl}/api/workitems/wi_nope/evidence`)).status).toBe(404);
    expect(
      (
        await fetch(`${daemon.baseUrl}/api/workitems/wi_nope/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            authorize: true,
            requestedFields: ['final_conclusion'],
          }),
        })
      ).status,
    ).toBe(404);
  });

  it('allows two capped metadata inventories beyond the old 1 MiB web limit', async () => {
    const res = await fetch(`${daemon.baseUrl}/api/hooks/web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site: 'claude-web',
        padding: 'x'.repeat(1_100 * 1024),
      }),
    });
    // The intentionally incomplete schema is rejected by WebIngest, proving the
    // route read the >1 MiB body instead of failing at either generic/old cap.
    expect(res.status).toBe(422);
    expect((await res.json()).warning).toMatch(/unparseable/);
  });
});

describe('HTTP API — with data', () => {
  let home: ReturnType<typeof createTempHome>;
  let daemon: Daemon;

  const connector: Connector = {
    id: 'claude-code-cli',
    displayName: 'Claude Code CLI',
    provider: 'anthropic',
    surface: 'cli',
    scanIntervalMs: 3_600_000,
    scan: (): ConnectorScanResult => ({ observedSessionCount: 1 }),
  };

  beforeEach(async () => {
    home = createTempHome();
    daemon = await startDaemon({
      port: 0,
      logger: createNullLogger(),
      connectors: [connector],
    });
    daemon.store.recordSighting({
      identity: canonicalKey('anthropic', 'sess-1'),
      provider: 'anthropic',
      title: 'Refactor billing',
      source: { id: 'claude-code-cli', provider: 'anthropic', surface: 'cli', device: 'mac' },
      externalId: 'sess-1',
      context: { cwd: '/Users/victor/code/billing', repo: 'billing' },
      resumeCommand: 'claude --resume sess-1',
      at: AT,
      decision: decisionFixture(),
      connectorId: 'claude-code-cli',
    });
  });

  afterEach(async () => {
    await daemon.stop();
    home.restore();
  });

  it('lists the work item with its entry points and current evidence', async () => {
    const body = (await (await fetch(`${daemon.baseUrl}/api/workitems`)).json()) as WorkItemsResponse;
    expect(body.count).toBe(1);
    const item = body.items[0];
    expect(item?.title).toBe('Refactor billing');
    expect(item?.status).toBe('running');
    expect(item?.entryPoints[0]?.resumeCommand).toBe('claude --resume sess-1');
    expect(item?.currentEvidence?.rule).toBe('running.live-activity');
    expect(body.coverage.overall).toBe('ok');
  });

  it('keeps seven-day triage as the default and exposes all indexed history on demand', async () => {
    const oldAt = Date.now() - DEFAULT_HISTORY_WINDOW_MS - 60_000;
    daemon.store.recordSighting({
      identity: canonicalKey('anthropic', 'sess-old'),
      provider: 'anthropic',
      title: 'Older indexed session',
      source: { id: 'claude-code-cli', provider: 'anthropic', surface: 'cli', device: 'mac' },
      externalId: 'sess-old',
      context: { cwd: '/Users/victor/code/archive', repo: 'archive' },
      resumeCommand: 'claude --resume sess-old',
      at: oldAt,
      decision: decisionFixture({
        status: 'stale',
        rule: 'stale.no-progress',
        evaluatedAt: oldAt,
        basisAt: oldAt,
      }),
      connectorId: 'claude-code-cli',
    });

    const recent = (await (
      await fetch(`${daemon.baseUrl}/api/workitems`)
    ).json()) as WorkItemsResponse;
    expect(recent.items.map((item) => item.canonicalKey)).not.toContain(
      canonicalKey('anthropic', 'sess-old').key,
    );
    expect(recent.count).toBe(1);

    const all = (await (
      await fetch(`${daemon.baseUrl}/api/workitems?history=all`)
    ).json()) as WorkItemsResponse;
    expect(all.count).toBe(2);
    expect(all.items.map((item) => item.canonicalKey)).toContain(
      canonicalKey('anthropic', 'sess-old').key,
    );
  });

  it('rejects an unknown history scope instead of silently serving the wrong slice', async () => {
    const res = await fetch(`${daemon.baseUrl}/api/workitems?history=forever`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'bad_request',
      detail: 'history must be "recent" or "all"',
    });
  });

  it('makes every status traceable through /evidence', async () => {
    const list = (await (await fetch(`${daemon.baseUrl}/api/workitems`)).json()) as WorkItemsResponse;
    const id = list.items[0]?.id ?? '';
    const res = await fetch(`${daemon.baseUrl}/api/workitems/${id}/evidence`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      evidence: { rule: string; confidence: string; signal: string }[];
      transitions: { from: string | null; to: string }[];
    };
    expect(body.evidence[0]?.rule).toBe('running.live-activity');
    expect(body.evidence[0]?.confidence).toBe('high');
    expect(body.evidence[0]?.signal).toBe('claude_code.post_tool_use');
    expect(body.transitions[0]).toMatchObject({ from: null, to: 'running' });
  });

  it('keeps task analysis explicit, bounded, and honest when no source adapter exists', async () => {
    const list = (await (await fetch(`${daemon.baseUrl}/api/workitems`)).json()) as WorkItemsResponse;
    const id = list.items[0]?.id ?? '';

    const notAuthorised = await fetch(`${daemon.baseUrl}/api/workitems/${id}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authorize: false,
        requestedFields: ['final_conclusion'],
      }),
    });
    expect(notAuthorised.status).toBe(400);

    const res = await fetch(`${daemon.baseUrl}/api/workitems/${id}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authorize: true,
        requestedFields: [
          'final_conclusion',
          'unresolved_items',
          'code_change_summary',
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskAnalysisResponse;
    expect(body).toMatchObject({
      workItemId: id,
      status: 'unavailable',
      accessedFields: [],
      result: null,
      privacy: {
        fullConversationRead: false,
        fullConversationStored: false,
      },
    });
    expect(body.evidence[0]?.claim).toMatch(/no authorised source adapter/i);
    expect(body.uncertainties[0]).toMatch(/unknown/i);
  });

  it('reports a live connector as ok in coverage', async () => {
    const body = (await (await fetch(`${daemon.baseUrl}/api/coverage`)).json()) as CoverageResponse;
    expect(body.connectorCount).toBe(1);
    expect(body.connectors[0]).toMatchObject({
      connectorId: 'claude-code-cli',
      displayName: 'Claude Code CLI',
      state: 'ok',
      observedSessionCount: 1,
    });
    expect(body.overall).toBe('ok');
  });

  it('accepts Grok Build’s raw HTTP-hook envelope on its dedicated route', async () => {
    const res = await fetch(`${daemon.baseUrl}/api/hooks/grok-build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'grok-session-1',
        hookEventName: 'notification',
        notificationType: 'permission_prompt',
        cwd: '/Users/victor/code/grok-project',
        timestamp: new Date().toISOString(),
        message: 'content stripped at the ingest boundary',
      }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      accepted: true,
      signal: 'grok.permission_prompt',
      status: 'needs_victor',
    });
    const grok = daemon.store.getWorkItemByCanonicalKey(
      canonicalKey('xai', 'grok-session-1').key,
    );
    expect(grok?.provider).toBe('xai');
    expect(JSON.stringify(daemon.store.listEvidence(grok!.id))).not.toContain(
      'content stripped',
    );
  });

  it('keeps work items visible when a connector goes down — never a clean empty state', async () => {
    daemon.store.updateCoverage('claude-code-cli', {
      state: 'down',
      lastError: 'ENOENT: ~/.claude/projects',
    });

    const body = (await (await fetch(`${daemon.baseUrl}/api/workitems`)).json()) as WorkItemsResponse;
    expect(body.count).toBe(1);
    expect(body.coverage.overall).toBe('down');
    expect(body.coverage.connectors[0]?.lastError).toMatch(/ENOENT/);
  });
});

describe('HTTP API — loopback hardening', () => {
  let home: ReturnType<typeof createTempHome>;
  let daemon: Daemon;

  beforeEach(async () => {
    home = createTempHome();
    daemon = await startDaemon({
      port: 0,
      logger: createNullLogger(),
      withoutDefaultConnectors: true,
      allowedOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'],
    });
  });

  afterEach(async () => {
    await daemon.stop();
    home.restore();
  });

  // `fetch` silently drops a caller-supplied Host header, so this one goes out
  // over raw http to actually exercise the rebinding guard.
  it('rejects a rebound hostname pointing at loopback', async () => {
    const res = await rawGet(daemon.port, '/api/coverage', { Host: 'evil.example.com' });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toBe('forbidden_host');
  });

  it('still accepts a plain loopback Host over raw http', async () => {
    const res = await rawGet(daemon.port, '/api/coverage', { Host: `127.0.0.1:${daemon.port}` });
    expect(res.status).toBe(200);
  });

  it('rejects a cross-origin page', async () => {
    const res = await fetch(`${daemon.baseUrl}/api/coverage`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden_origin');
  });

  it('allows the explicitly allowlisted extension origin', async () => {
    const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const res = await fetch(`${daemon.baseUrl}/api/coverage`, { headers: { Origin: origin } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
  });

  it('allows the same-origin dashboard', async () => {
    const res = await fetch(`${daemon.baseUrl}/api/coverage`, {
      headers: { Origin: `http://127.0.0.1:${daemon.port}` },
    });
    expect(res.status).toBe(200);
  });

  it('allows an originless request such as curl', async () => {
    expect((await fetch(`${daemon.baseUrl}/api/coverage`)).status).toBe(200);
  });

  it('binds to loopback only', () => {
    expect(daemon.server.address().address).toBe('127.0.0.1');
  });

  it('refuses to start a second daemon on the same port', async () => {
    await expect(
      startDaemon({ port: daemon.port, logger: createNullLogger(), withoutDefaultConnectors: true }),
    ).rejects.toThrow(/already in use/);
  });
});

describe('HTTP API — SSE', () => {
  let home: ReturnType<typeof createTempHome>;
  let daemon: Daemon;

  beforeEach(async () => {
    home = createTempHome();
    daemon = await startDaemon({ port: 0, logger: createNullLogger(), withoutDefaultConnectors: true });
  });

  afterEach(async () => {
    await daemon.stop();
    home.restore();
  });

  it('opens with a hello snapshot then streams live changes', async () => {
    const controller = new AbortController();
    const res = await fetch(`${daemon.baseUrl}/api/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();

    const first = await reader!.read();
    const opening = decoder.decode(first.value);
    expect(opening).toContain('event: hello');

    daemon.store.registerConnector({ id: 'c1', displayName: 'C1' });

    let seen = opening;
    while (!seen.includes('coverage.changed')) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      seen += decoder.decode(chunk.value);
    }
    expect(seen).toContain('event: coverage.changed');

    controller.abort();
  });

  it('shuts down promptly even with clients holding connections open', async () => {
    const home2 = createTempHome();
    const other = await startDaemon({ port: 0, logger: createNullLogger(), withoutDefaultConnectors: true });
    // A normal request leaves a pooled keep-alive socket behind, and an SSE
    // stream leaves a long-lived one. Neither may delay shutdown.
    await fetch(`${other.baseUrl}/api/coverage`);
    const controller = new AbortController();
    const stream = await fetch(`${other.baseUrl}/api/events`, { signal: controller.signal });
    await stream.body?.getReader().read();

    const started = Date.now();
    await other.stop();
    const elapsed = Date.now() - started;
    controller.abort();
    home2.restore();

    expect(elapsed).toBeLessThan(1_000);
  });

  it('drops the subscription when a client disconnects', async () => {
    const controller = new AbortController();
    const res = await fetch(`${daemon.baseUrl}/api/events`, { signal: controller.signal });
    await res.body?.getReader().read();
    expect(daemon.server.eventClientCount).toBe(1);

    controller.abort();
    await waitFor(() => daemon.server.eventClientCount === 0);
    expect(daemon.bus.subscriberCount).toBe(0);
  });
});

function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not met before timeout');
}
