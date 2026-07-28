import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunningProcess {
  pid: number;
  /** Full command line. */
  command: string;
  /** Working directory, when we could resolve it. */
  cwd?: string;
}

/**
 * Lists processes whose command matches `pattern`.
 *
 * `ps` is used rather than a native dependency: it is always present on macOS,
 * needs no permissions, and cannot crash the daemon.
 */
export async function listProcesses(pattern: RegExp): Promise<RunningProcess[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], {
    maxBuffer: 8 * 1024 * 1024,
  });

  const processes: RunningProcess[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const space = trimmed.indexOf(' ');
    if (space === -1) continue;
    const pid = Number.parseInt(trimmed.slice(0, space), 10);
    if (Number.isNaN(pid)) continue;
    const command = trimmed.slice(space + 1);
    if (!pattern.test(command)) continue;
    processes.push({ pid, command });
  }
  return processes;
}

/**
 * Resolves a process's working directory via `lsof`.
 *
 * Best-effort: `lsof` is slow and can be blocked, so failures resolve to
 * undefined rather than throwing. cwd association is a nice-to-have — the
 * session id from the transcript is the real identity.
 */
export async function processCwd(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
    });
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n')) return line.slice(1).trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Matches the `claude` CLI without matching this daemon or an editor. */
export const CLAUDE_PROCESS_PATTERN = /(^|\/)claude(\s|$)/;
/** Matches the `codex` CLI. */
export const CODEX_PROCESS_PATTERN = /(^|\/)codex(\s|$)/;

export interface LivenessSnapshot {
  /** cwds that currently host a matching process. */
  cwds: Set<string>;
  count: number;
  /** True when cwd resolution was skipped or failed for every process. */
  cwdResolutionDegraded: boolean;
}

/**
 * Which working directories currently host a live CLI process.
 *
 * Association is by cwd because neither CLI exposes its session id in argv.
 * That is imprecise when two sessions share a directory, so liveness is only
 * ever used as a *qualifier* — it can mark a session dead, it can never mark one
 * as making progress. See the status engine notes.
 */
export async function livenessByCwd(
  pattern: RegExp,
  options: { resolveCwd?: boolean; limit?: number } = {},
): Promise<LivenessSnapshot> {
  const processes = await listProcesses(pattern);
  const cwds = new Set<string>();
  let resolved = 0;

  if (options.resolveCwd !== false) {
    // lsof is the expensive part; cap it so a machine with many processes cannot
    // make a scan take longer than the scan interval.
    const limit = options.limit ?? 24;
    const targets = processes.slice(0, limit);
    const results = await Promise.all(targets.map((p) => processCwd(p.pid)));
    for (const cwd of results) {
      if (cwd) {
        cwds.add(cwd);
        resolved += 1;
      }
    }
  }

  return {
    cwds,
    count: processes.length,
    cwdResolutionDegraded: processes.length > 0 && resolved === 0,
  };
}
