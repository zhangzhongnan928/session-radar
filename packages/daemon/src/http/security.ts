import type { IncomingMessage } from 'node:http';
import { extensionOrigin } from '@session-radar/shared';

/**
 * Hostnames that may appear in the Host header.
 *
 * This blocks DNS rebinding: a hostile page can point `evil.example` at 127.0.0.1
 * and have the browser issue same-origin requests to the daemon. Binding to
 * loopback does not stop that; checking the Host header does.
 */
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface SecurityOptions {
  /**
   * Origins allowed to make cross-origin requests. The dashboard is same-origin;
   * the M2 browser extension adds `chrome-extension://<id>` here.
   */
  allowedOrigins: string[];
}

export type SecurityVerdict =
  | { ok: true; allowOrigin: string | undefined }
  | { ok: false; status: number; error: string; detail: string };

export function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  // IPv6 literals arrive as [::1]:4747.
  if (hostHeader.startsWith('[')) {
    const close = hostHeader.indexOf(']');
    return close === -1 ? undefined : hostHeader.slice(0, close + 1);
  }
  const colon = hostHeader.lastIndexOf(':');
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
}

export function checkRequest(req: IncomingMessage, options: SecurityOptions): SecurityVerdict {
  const hostname = hostnameOf(req.headers.host);
  if (hostname === undefined || !ALLOWED_HOSTNAMES.has(hostname)) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden_host',
      detail: `session-radar only answers to loopback hosts, got ${String(req.headers.host)}`,
    };
  }

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
    if (!options.allowedOrigins.includes(origin)) {
      return {
        ok: false,
        status: 403,
        error: 'forbidden_origin',
        detail: `origin ${origin} is not allowed`,
      };
    }
    return { ok: true, allowOrigin: origin };
  }

  // No Origin header: a curl, the CLI, or a same-origin navigation.
  return { ok: true, allowOrigin: undefined };
}

export function defaultAllowedOrigins(host: string, port: number): string[] {
  const hostForUrl = host === '::1' ? '[::1]' : host;
  return [
    `http://${hostForUrl}:${port}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    // Exactly one extension, pinned by the public key in its manifest. Any other
    // extension — including a hostile one the user installed by mistake — is
    // rejected, which is why the manifest carries a fixed key at all.
    extensionOrigin(),
    ...extensionOriginsFromEnv(),
  ];
}

/**
 * `SESSION_RADAR_EXTENSION_IDS=abc,def` allows additional extension ids, for
 * developing against an unpacked build with a different key.
 */
export function extensionOriginsFromEnv(): string[] {
  const raw = process.env['SESSION_RADAR_EXTENSION_IDS'];
  if (!raw) return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^[a-p]{32}$/.test(id))
    .map((id) => extensionOrigin(id));
}
