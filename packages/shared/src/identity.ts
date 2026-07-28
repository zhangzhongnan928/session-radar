/**
 * Identity and dedup.
 *
 * The canonical key is `(provider, conversationId|sessionId)`. Web, desktop and
 * extension sightings of the same conversation collapse into ONE WorkItem that
 * keeps every entry point. The fingerprint fallback is only for surfaces that
 * expose no stable id, and the basis is always recorded so a wrong merge is
 * debuggable rather than mysterious.
 */
import type { MergeBasis, Provider } from './model.js';

export interface CanonicalIdentity {
  key: string;
  basis: MergeBasis;
}

/** `(provider, externalId)` — the strong key. Always prefer this. */
export function canonicalKey(provider: Provider, externalId: string): CanonicalIdentity {
  const trimmed = externalId.trim();
  if (trimmed.length === 0) {
    throw new Error('canonicalKey requires a non-empty externalId');
  }
  return { key: `${provider}:id:${trimmed}`, basis: 'canonical-id' };
}

/** Timestamps within the same bucket are treated as "the same moment". */
export const FINGERPRINT_BUCKET_MS = 5 * 60_000;

export interface FingerprintInput {
  provider: Provider;
  account?: string | undefined;
  title: string;
  /** Epoch ms; bucketed so jitter between surfaces does not split the item. */
  createdAt: number;
}

/**
 * Weak key for sources with no stable id. Never used when `canonicalKey` is
 * available. Uses a plain non-cryptographic hash on purpose: this is a local
 * grouping key, not a security primitive, and `shared` must stay dependency-free
 * and runnable inside a browser extension.
 */
export function fingerprintKey(input: FingerprintInput): CanonicalIdentity {
  const bucket = Math.floor(input.createdAt / FINGERPRINT_BUCKET_MS);
  const fields = [
    input.provider,
    input.account ?? '-',
    normalizeForFingerprint(input.title),
    String(bucket),
  ];
  // Length-prefixed rather than delimiter-joined, so no title can forge a
  // separator and collide with a different field layout.
  const material = fields.map((field) => `${field.length}:${field}`).join('');
  return { key: `${input.provider}:fp:${hash32(material)}`, basis: 'fingerprint' };
}

function normalizeForFingerprint(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** FNV-1a, 32-bit, hex. Deterministic across Node and browsers. */
export function hash32(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    // hash * 16777619 with 32-bit overflow
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
