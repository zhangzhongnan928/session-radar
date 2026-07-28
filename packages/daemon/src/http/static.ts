import { createReadStream, existsSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

/**
 * Static file serving for the dashboard bundle.
 *
 * Tiny on purpose: the daemon serves exactly one built SPA from one directory,
 * on loopback. The only thing worth being careful about is path traversal, which
 * `resolveSafe` handles by resolving and then proving containment rather than by
 * pattern-matching `..` out of the request.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolves a URL path inside `root`, or undefined if it would escape.
 * Returns the resolved absolute path; existence is the caller's problem.
 */
export function resolveSafe(root: string, urlPath: string): string | undefined {
  const decoded = safeDecode(urlPath);
  if (decoded === undefined) return undefined;
  if (decoded.includes('\0')) return undefined;

  const rootResolved = resolve(root);
  const candidate = resolve(join(rootResolved, normalize(decoded)));
  // Containment check, not a substring check: `/root-evil` must not match `/root`.
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) return undefined;
  return candidate;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export interface StaticResult {
  served: boolean;
}

/**
 * Serves `urlPath` from `root`. Unknown paths fall back to index.html so the SPA
 * can own its own routing; a missing bundle returns a message that says how to
 * build it rather than a bare 404.
 */
export function serveStatic(root: string, urlPath: string, res: ServerResponse): StaticResult {
  if (!existsSync(root)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      'The dashboard has not been built yet.\n\nRun:  pnpm --filter @session-radar/dashboard build\n',
    );
    return { served: true };
  }

  const resolved = resolveSafe(root, urlPath === '/' ? '/index.html' : urlPath);
  if (resolved === undefined) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden path\n');
    return { served: true };
  }

  const target =
    existsSync(resolved) && statSync(resolved).isFile() ? resolved : join(resolve(root), 'index.html');

  if (!existsSync(target)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
    return { served: true };
  }

  const isHtml = target.endsWith('.html');
  res.writeHead(200, {
    'Content-Type': contentTypeFor(target),
    // The HTML shell must never be cached, or a rebuilt dashboard keeps serving
    // stale asset references. Hashed assets are safe to cache hard.
    'Cache-Control': isHtml ? 'no-store' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(target).pipe(res);
  return { served: true };
}
