import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Directory perms: owner-only. */
export const DIR_MODE = 0o700;
/** File perms: owner read/write only. Asserted by tests. */
export const FILE_MODE = 0o600;

/**
 * Everything lives under one directory so "delete my session-radar data" is a
 * single `rm -rf`. `SESSION_RADAR_HOME` exists so tests never touch the real one.
 */
export function sessionRadarHome(): string {
  const override = process.env['SESSION_RADAR_HOME'];
  if (override && override.trim().length > 0) return override;
  return join(homedir(), '.session-radar');
}

export function dbPath(): string {
  return join(sessionRadarHome(), 'db.sqlite');
}

export function ensureHome(): string {
  const home = sessionRadarHome();
  mkdirSync(home, { recursive: true, mode: DIR_MODE });
  // mkdir's mode is masked by umask, so set it explicitly after the fact.
  chmodSync(home, DIR_MODE);
  return home;
}

/** Current permission bits of a path, e.g. 0o600. */
export function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

export function formatMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
}
