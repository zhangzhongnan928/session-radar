import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { checkRequest, defaultAllowedOrigins, hostnameOf } from './security.js';

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const options = { allowedOrigins: defaultAllowedOrigins('127.0.0.1', 4747) };

describe('hostnameOf', () => {
  it('strips the port', () => {
    expect(hostnameOf('127.0.0.1:4747')).toBe('127.0.0.1');
  });

  it('handles a bare hostname', () => {
    expect(hostnameOf('localhost')).toBe('localhost');
  });

  it('handles IPv6 literals', () => {
    expect(hostnameOf('[::1]:4747')).toBe('[::1]');
    expect(hostnameOf('[::1]')).toBe('[::1]');
  });

  it('returns undefined for a missing or malformed header', () => {
    expect(hostnameOf(undefined)).toBeUndefined();
    expect(hostnameOf('[::1')).toBeUndefined();
  });
});

describe('checkRequest', () => {
  it('accepts loopback hosts', () => {
    for (const host of ['127.0.0.1:4747', 'localhost:4747', '[::1]:4747']) {
      expect(checkRequest(req({ host }), options).ok).toBe(true);
    }
  });

  it('rejects a rebound hostname that resolves to loopback', () => {
    const verdict = checkRequest(req({ host: 'radar.evil.example:4747' }), options);
    expect(verdict).toMatchObject({ ok: false, status: 403, error: 'forbidden_host' });
  });

  it('rejects a missing Host header rather than defaulting to allow', () => {
    expect(checkRequest(req({}), options).ok).toBe(false);
  });

  it('rejects an unlisted origin', () => {
    const verdict = checkRequest(
      req({ host: '127.0.0.1:4747', origin: 'https://evil.example' }),
      options,
    );
    expect(verdict).toMatchObject({ ok: false, error: 'forbidden_origin' });
  });

  it('echoes an allowed origin so CORS can be granted narrowly', () => {
    const verdict = checkRequest(
      req({ host: '127.0.0.1:4747', origin: 'http://127.0.0.1:4747' }),
      options,
    );
    expect(verdict).toEqual({ ok: true, allowOrigin: 'http://127.0.0.1:4747' });
  });

  it('treats an opaque null origin as no origin rather than allowing it by name', () => {
    const verdict = checkRequest(req({ host: '127.0.0.1:4747', origin: 'null' }), options);
    expect(verdict).toEqual({ ok: true, allowOrigin: undefined });
  });

  it('allows an extension origin only when explicitly listed', () => {
    const extension = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    expect(checkRequest(req({ host: '127.0.0.1:4747', origin: extension }), options).ok).toBe(false);
    expect(
      checkRequest(req({ host: '127.0.0.1:4747', origin: extension }), {
        allowedOrigins: [...options.allowedOrigins, extension],
      }).ok,
    ).toBe(true);
  });
});
