import { open } from 'node:fs/promises';

export const DEFAULT_ANALYSIS_TAIL_BYTES = 512 * 1024;
const READ_CHUNK_BYTES = 8 * 1024;

export interface TailRecordSearch<T> {
  value?: T;
  bytesRead: number;
  sourceSizeBytes: number;
}

/**
 * Searches JSONL records newest-first without ever reading the entire file.
 *
 * The one-byte exclusion is deliberate. Even a tiny transcript keeps a hard
 * distinction between "bounded tail" and "full conversation", and a record
 * cut by that boundary is simply ignored. Real Codex/Claude files have metadata
 * before the final assistant record, so the useful terminal record remains
 * independently parseable.
 */
export async function findNewestJsonRecord<T>(
  path: string,
  sourceSizeBytes: number,
  match: (record: Record<string, unknown>) => T | undefined,
  maxBytes = DEFAULT_ANALYSIS_TAIL_BYTES,
): Promise<TailRecordSearch<T>> {
  const readBudget = Math.min(maxBytes, Math.max(0, sourceSizeBytes - 1));
  if (readBudget === 0) {
    return { bytesRead: 0, sourceSizeBytes };
  }

  const handle = await open(path, 'r');
  let position = sourceSizeBytes;
  let bytesRead = 0;
  let pending = Buffer.alloc(0);

  try {
    while (position > 0 && bytesRead < readBudget) {
      const length = Math.min(READ_CHUNK_BYTES, position, readBudget - bytesRead);
      position -= length;
      const chunk = Buffer.alloc(length);
      const read = await handle.read(chunk, 0, length, position);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;

      const combined = Buffer.concat([chunk.subarray(0, read.bytesRead), pending]);
      let lineEnd = combined.length;
      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] !== 0x0a) continue;
        const line = combined.subarray(index + 1, lineEnd);
        lineEnd = index;
        const parsed = parseJsonObject(line);
        if (!parsed) continue;
        const value = match(parsed);
        if (value !== undefined) {
          return { value, bytesRead, sourceSizeBytes };
        }
      }

      // Bytes before the earliest newline belong to a record cut across the
      // next chunk boundary. The total remains bounded by readBudget.
      pending = Buffer.from(combined.subarray(0, lineEnd));
    }
  } finally {
    pending.fill(0);
    await handle.close();
  }

  return { bytesRead, sourceSizeBytes };
}

function parseJsonObject(line: Buffer): Record<string, unknown> | undefined {
  if (line.length === 0) return undefined;
  try {
    const value = JSON.parse(line.toString('utf8')) as unknown;
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    // A malformed or actively-appending record must not widen the read.
    return undefined;
  }
}
