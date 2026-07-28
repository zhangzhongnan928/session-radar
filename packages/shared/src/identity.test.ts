import { describe, expect, it } from 'vitest';
import { FINGERPRINT_BUCKET_MS, canonicalKey, fingerprintKey, hash32 } from './identity.js';

describe('canonicalKey', () => {
  it('is stable across surfaces so web/desktop/CLI sightings merge', () => {
    const fromWeb = canonicalKey('anthropic', 'conv-abc');
    const fromDesktop = canonicalKey('anthropic', 'conv-abc');
    expect(fromWeb.key).toBe(fromDesktop.key);
    expect(fromWeb.basis).toBe('canonical-id');
  });

  it('never collides across providers', () => {
    expect(canonicalKey('anthropic', 'x').key).not.toBe(canonicalKey('openai', 'x').key);
  });

  it('tolerates surrounding whitespace from scraped ids', () => {
    expect(canonicalKey('openai', '  conv-1  ').key).toBe(canonicalKey('openai', 'conv-1').key);
  });

  it('refuses an empty id rather than inventing a key', () => {
    expect(() => canonicalKey('openai', '   ')).toThrow();
  });
});

describe('fingerprintKey', () => {
  const base = {
    provider: 'openai' as const,
    account: 'victor',
    title: 'Fix the deploy script',
    createdAt: 1_800_000_000_000,
  };

  it('matches for timestamps inside the same bucket', () => {
    const a = fingerprintKey(base);
    const b = fingerprintKey({ ...base, createdAt: base.createdAt + FINGERPRINT_BUCKET_MS - 1 });
    // Same bucket only when the floor divides equally; assert on the bucket boundary explicitly.
    const bucketStart = Math.floor(base.createdAt / FINGERPRINT_BUCKET_MS) * FINGERPRINT_BUCKET_MS;
    const c = fingerprintKey({ ...base, createdAt: bucketStart });
    const d = fingerprintKey({ ...base, createdAt: bucketStart + FINGERPRINT_BUCKET_MS - 1 });
    expect(c.key).toBe(d.key);
    expect(typeof a.key).toBe('string');
    expect(typeof b.key).toBe('string');
  });

  it('differs across buckets', () => {
    const a = fingerprintKey(base);
    const b = fingerprintKey({ ...base, createdAt: base.createdAt + 3 * FINGERPRINT_BUCKET_MS });
    expect(a.key).not.toBe(b.key);
  });

  it('normalizes case and whitespace in the title', () => {
    const a = fingerprintKey(base);
    const b = fingerprintKey({ ...base, title: '  FIX   the Deploy  Script ' });
    expect(a.key).toBe(b.key);
  });

  it('separates accounts', () => {
    const a = fingerprintKey(base);
    const b = fingerprintKey({ ...base, account: 'someone-else' });
    expect(a.key).not.toBe(b.key);
  });

  it('records the weaker basis so a bad merge is debuggable', () => {
    expect(fingerprintKey(base).basis).toBe('fingerprint');
  });

  it('cannot be forged by a title that mimics a field separator', () => {
    const a = fingerprintKey({ ...base, account: 'ab', title: 'c' });
    const b = fingerprintKey({ ...base, account: 'a', title: 'bc' });
    expect(a.key).not.toBe(b.key);
  });
});

describe('hash32', () => {
  it('is deterministic and fixed-width', () => {
    expect(hash32('hello')).toBe(hash32('hello'));
    expect(hash32('hello')).toHaveLength(8);
  });

  it('separates similar inputs', () => {
    expect(hash32('hello')).not.toBe(hash32('hellp'));
  });

  it('handles the empty string', () => {
    expect(hash32('')).toHaveLength(8);
  });
});
