import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClassicLevel } from 'classic-level';

/**
 * Chromium Local Storage encodes strings with a one-byte tag:
 *   0 = UTF-16LE, 1 = UTF-8.
 */
export function decodeChromiumString(value: Buffer): string | undefined {
  if (value.length === 0) return undefined;
  if (value[0] === 0) {
    if ((value.length - 1) % 2 !== 0) return undefined;
    return value.subarray(1).toString('utf16le');
  }
  if (value[0] === 1) return value.subarray(1).toString('utf8');
  return undefined;
}

/**
 * A Local Storage row key is `<origin>\0<encoded storage key>`.
 * Ignore Chromium bookkeeping rows that do not have that shape.
 */
export function chromiumStorageKeyName(key: Buffer): string | undefined {
  const separator = key.indexOf(0);
  if (separator < 0 || separator === key.length - 1) return undefined;
  return decodeChromiumString(key.subarray(separator + 1));
}

export interface ChromiumLocalStorageRecord {
  key: string;
  /** Encoded Chromium string. Decode only inside the connector's schema boundary. */
  value: Buffer;
}

/**
 * Read selected Local Storage keys from a private copy of Chromium's LevelDB.
 *
 * The source app keeps its live database locked. Opening only a temporary copy
 * avoids contention and confines any LevelDB recovery writes to disposable data.
 */
export async function readChromiumLocalStorageRecords(
  levelDbPath: string,
  wantedKeys: ReadonlySet<string>,
): Promise<ChromiumLocalStorageRecord[]> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'session-radar-chromium-storage-'));
  const copyPath = join(tempRoot, 'leveldb');
  let db: ClassicLevel<Buffer, Buffer> | undefined;
  const records: ChromiumLocalStorageRecord[] = [];

  try {
    cpSync(levelDbPath, copyPath, { recursive: true });
    db = new ClassicLevel<Buffer, Buffer>(copyPath, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });
    await db.open();

    for await (const [encodedKey, encodedValue] of db.iterator()) {
      const key = chromiumStorageKeyName(encodedKey);
      if (!key || !wantedKeys.has(key)) continue;
      records.push({ key, value: Buffer.from(encodedValue) });
    }
  } finally {
    try {
      if (db?.status === 'open') await db.close();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  return records;
}
