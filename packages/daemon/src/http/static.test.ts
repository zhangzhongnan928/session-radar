import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempHome } from '../testing.js';
import { contentTypeFor, resolveSafe } from './static.js';

describe('resolveSafe — path traversal', () => {
  let home: ReturnType<typeof createTempHome>;
  let root: string;

  beforeEach(() => {
    home = createTempHome();
    root = join(home.home, 'dist');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<html></html>');
    // A sibling directory whose name shares a prefix with the root — the classic
    // way a substring containment check gets bypassed.
    mkdirSync(join(home.home, 'dist-evil'), { recursive: true });
    writeFileSync(join(home.home, 'dist-evil', 'secret.txt'), 'secret');
  });
  afterEach(() => home.restore());

  it('resolves a normal path inside the root', () => {
    expect(resolveSafe(root, '/index.html')).toBe(join(root, 'index.html'));
    expect(resolveSafe(root, '/assets/app.js')).toBe(join(root, 'assets', 'app.js'));
  });

  /**
   * The property that matters is "never resolves outside root", not any
   * particular return value. On an absolute request path `normalize` already
   * collapses leading `..`, so these land on a non-existent path INSIDE root and
   * 404 — safe, just not rejected outright.
   */
  function neverEscapes(urlPath: string): void {
    const resolved = resolveSafe(root, urlPath);
    if (resolved === undefined) return; // rejected outright is also fine
    // Containment is the property. A resolved path may still *mention*
    // `dist-evil` — as `<root>/dist-evil/...`, which is inside root and simply
    // does not exist. What must never happen is resolving to the real file.
    expect(resolved.startsWith(root + '/') || resolved === root).toBe(true);
    expect(resolved).not.toBe(join(home.home, 'dist-evil', 'secret.txt'));
    expect(resolved).not.toBe('/etc/passwd');
    expect(existsSync(resolved)).toBe(false);
  }

  it('cannot escape via ..', () => {
    neverEscapes('/assets/../../dist-evil/secret.txt');
    neverEscapes('/../dist-evil/secret.txt');
    neverEscapes('/../../../../etc/passwd');
  });

  it('cannot escape via percent-encoded traversal', () => {
    neverEscapes('/assets/%2e%2e/%2e%2e/dist-evil/secret.txt');
    neverEscapes('/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
  });

  it('is not fooled by a sibling directory sharing the root prefix', () => {
    // `<home>/dist-evil` starts with `<home>/dist`, so a substring containment
    // check would pass here where a path-boundary check must not.
    neverEscapes('/../dist-evil/secret.txt');
  });

  it('REJECTS a relative path, where the containment check is the only guard', () => {
    // Without a leading slash, `normalize` keeps the `..`, so this is the input
    // that actually exercises the boundary check rather than normalisation.
    expect(resolveSafe(root, '../dist-evil/secret.txt')).toBeUndefined();
  });

  it('rejects null bytes', () => {
    expect(resolveSafe(root, '/index.html\0.png')).toBeUndefined();
  });

  it('rejects malformed percent-encoding rather than guessing', () => {
    expect(resolveSafe(root, '/%zz')).toBeUndefined();
  });

  it('leading .. on an absolute path cannot climb out', () => {
    // `normalize` strips these, and the containment check is the backstop.
    const resolved = resolveSafe(root, '/../../../../etc/passwd');
    expect(resolved).toBe(join(root, 'etc', 'passwd'));
  });
});

describe('contentTypeFor', () => {
  it('types the assets the bundle actually emits', () => {
    expect(contentTypeFor('/index.html')).toContain('text/html');
    expect(contentTypeFor('/assets/app.js')).toContain('text/javascript');
    expect(contentTypeFor('/assets/app.css')).toContain('text/css');
    expect(contentTypeFor('/assets/app.js.map')).toContain('application/json');
  });

  it('falls back to octet-stream rather than guessing', () => {
    expect(contentTypeFor('/thing.unknown')).toBe('application/octet-stream');
  });
});
