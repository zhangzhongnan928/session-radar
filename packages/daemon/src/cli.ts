#!/usr/bin/env node
import { existsSync } from 'node:fs';
import type { CoverageResponse, WorkItem, WorkItemsResponse } from '@session-radar/shared';
import { DEFAULT_DAEMON_CONFIG } from '@session-radar/shared';
import { EventBus } from './bus.js';
import { ClaudeCodeConnector } from './connectors/claude-code/connector.js';
import { CodexConnector } from './connectors/codex/connector.js';
import { openDb } from './db/open.js';
import { StatusEngine } from './engine.js';
import { createNullLogger } from './logger.js';
import { dbPath } from './paths.js';
import { ConnectorRegistry } from './registry.js';
import { Store } from './store.js';
import {
  applyClaudeHooks,
  claudeSettingsPath,
  planClaudeHooks,
  removeClaudeHooks,
} from './install/claude-hooks.js';
import {
  applyCodexNotify,
  codexConfigPath,
  planCodexNotify,
  removeCodexNotify,
} from './install/codex-notify.js';

const PORT = Number.parseInt(process.env['SESSION_RADAR_PORT'] ?? '', 10) || DEFAULT_DAEMON_CONFIG.port;
const BASE = `http://127.0.0.1:${PORT}`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? 'status';
  const flags = new Set(argv.slice(1).filter((a) => a.startsWith('--')));

  switch (command) {
    case 'status':
      return status(flags.has('--json'));
    case 'scan':
      return scan(flags.has('--json'));
    case 'coverage':
      return coverage(flags.has('--json'));
    case 'install-hooks':
      return installHooks(flags.has('--apply'));
    case 'uninstall-hooks':
      return uninstallHooks(flags.has('--apply'));
    case 'doctor':
      return doctor();
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n\n`);
      printUsage();
      return 1;
  }
}

function printUsage(): void {
  process.stdout.write(`session-radar — read-only AI session radar

  status [--json]        list every work item with status, evidence and coverage
  scan [--json]          run one collection pass directly (no daemon needed)
  coverage [--json]      connector health only
  install-hooks [--apply]   dry-run by default; --apply writes (backs up first)
  uninstall-hooks [--apply] remove only session-radar's entries
  doctor                 check paths, permissions and daemon reachability

Talks to the daemon at ${BASE} when it is running, and falls back to reading
the local store directly when it is not.
`);
}

// --- reading ----------------------------------------------------------------

async function fetchJson<T>(path: string): Promise<T | undefined> {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/** Reads the store directly. Used when the daemon is not running. */
function openLocalStore(): { store: Store; close(): void } | undefined {
  if (!existsSync(dbPath())) return undefined;
  const opened = openDb();
  return { store: new Store(opened.db, new EventBus()), close: () => opened.db.close() };
}

async function status(json: boolean): Promise<number> {
  const live = await fetchJson<WorkItemsResponse>('/api/workitems');
  if (live) return renderStatus(live, json, 'daemon');

  const local = openLocalStore();
  if (!local) {
    process.stderr.write(
      `no daemon at ${BASE} and no local store at ${dbPath()}\nStart the daemon, or run: session-radar scan\n`,
    );
    return 1;
  }
  try {
    const connectors = local.store.listCoverage();
    const payload: WorkItemsResponse = {
      generatedAt: Date.now(),
      count: local.store.countWorkItems(),
      items: local.store.listWorkItems(),
      coverage: {
        generatedAt: Date.now(),
        overall: connectors.length === 0 ? 'no_connectors' : rollup(connectors),
        connectorCount: connectors.length,
        connectors,
      },
    };
    return renderStatus(payload, json, 'local store (daemon not running)');
  } finally {
    local.close();
  }
}

function rollup(connectors: CoverageResponse['connectors']): CoverageResponse['overall'] {
  if (connectors.some((c) => c.state === 'down')) return 'down';
  if (connectors.some((c) => c.state === 'degraded')) return 'degraded';
  return 'ok';
}

async function coverage(json: boolean): Promise<number> {
  const live = await fetchJson<CoverageResponse>('/api/coverage');
  if (!live) {
    process.stderr.write(`no daemon at ${BASE}\n`);
    return 1;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(live, null, 2)}\n`);
    return 0;
  }
  renderCoverage(live);
  return live.overall === 'ok' ? 0 : 1;
}

/**
 * One-shot collection without a daemon. Handy for the acceptance script and for
 * answering "what would it see right now?".
 */
async function scan(json: boolean): Promise<number> {
  const opened = openDb();
  const bus = new EventBus();
  const store = new Store(opened.db, bus);
  const engine = new StatusEngine(store);
  const registry = new ConnectorRegistry(store, bus, createNullLogger(), {
    scanTimeoutMs: 120_000,
  });

  registry.register(new ClaudeCodeConnector({ engine }));
  registry.register(new CodexConnector({ engine }));

  try {
    await registry.scanAllOnce();
    const connectors = store.listCoverage();
    const payload: WorkItemsResponse = {
      generatedAt: Date.now(),
      count: store.countWorkItems(),
      items: store.listWorkItems(),
      coverage: {
        generatedAt: Date.now(),
        overall: rollup(connectors),
        connectorCount: connectors.length,
        connectors,
      },
    };
    return renderStatus(payload, json, 'one-shot scan');
  } finally {
    await registry.stopAll();
    opened.db.close();
  }
}

function renderStatus(payload: WorkItemsResponse, json: boolean, sourceLabel: string): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  const items = payload.items;
  const counts = {
    needsVictor: items.filter((i) => i.status === 'needs_victor').length,
    doneUnseen: items.filter((i) => i.status === 'done' && i.attention === 'unseen').length,
    stale: items.filter((i) => i.status === 'stale').length,
    running: items.filter((i) => i.status === 'running').length,
  };

  process.stdout.write(
    `\n  NEEDS VICTOR ${counts.needsVictor}   DONE unseen ${counts.doneUnseen}   ` +
      `STALE ${counts.stale}   RUNNING ${counts.running}      (${sourceLabel})\n\n`,
  );

  for (const item of items) {
    process.stdout.write(`${formatItem(item)}\n`);
  }
  if (items.length === 0) process.stdout.write('  (no sessions in the history window)\n');

  process.stdout.write('\n');
  renderCoverage(payload.coverage);
  return 0;
}

function formatItem(item: WorkItem): string {
  const surfaces = [...new Set(item.entryPoints.map((e) => e.source.surface))].join('+');
  const where = item.context.repo ?? item.context.conversationId ?? '-';
  const age = relative(Date.now() - item.lastActivityAt);
  const seen = item.status === 'done' ? ` [${item.attention}]` : '';
  const reason = reasonOf(item.currentEvidence?.raw) || item.currentEvidence?.rule || '';
  const entry =
    item.entryPoints.find((e) => e.url)?.url ??
    item.entryPoints.find((e) => e.resumeCommand)?.resumeCommand ??
    item.entryPoints.find((e) => e.locateHint)?.locateHint ??
    '';

  return (
    `  ${item.status.toUpperCase().padEnd(13)}${seen.padEnd(9)}${truncate(item.title, 52).padEnd(54)}` +
    `${surfaces.padEnd(12)}${truncate(where, 18).padEnd(20)}${age}\n` +
    `      ${item.currentEvidence?.rule ?? '?'} (${item.currentEvidence?.confidence ?? '?'}) — ${reason}\n` +
    (entry ? `      ${entry}\n` : '')
  );
}

function renderCoverage(coverage: CoverageResponse): void {
  process.stdout.write(`  COVERAGE: ${coverage.overall.toUpperCase()}\n`);
  for (const c of coverage.connectors) {
    const archived = c.archivedSessionCount > 0 ? ` (+${c.archivedSessionCount} archived)` : '';
    const detail = c.lastError ? `\n        ${c.lastError}` : '';
    process.stdout.write(
      `  ${c.state.toUpperCase().padEnd(13)}${c.displayName.padEnd(24)}` +
        `${String(c.observedSessionCount).padStart(3)} sessions${archived}${detail}\n`,
    );
  }
  if (coverage.connectors.length === 0) {
    process.stdout.write('  no connectors registered — nothing is being watched\n');
  }
  process.stdout.write('\n');
}

// --- installing -------------------------------------------------------------

function installHooks(apply: boolean): number {
  const claudePlan = planClaudeHooks(PORT);
  const codexPlan = planCodexNotify(PORT);

  process.stdout.write(`\n  Claude Code — ${claudeSettingsPath()}\n`);
  for (const entry of claudePlan.entries) {
    process.stdout.write(
      `    ${entry.action === 'add' ? 'ADD    ' : 'present'}  ${entry.event}\n`,
    );
  }
  if (claudePlan.preservedEvents.length > 0) {
    process.stdout.write(
      `    your existing hooks on ${claudePlan.preservedEvents.join(', ')} are left untouched\n`,
    );
  }

  process.stdout.write(`\n  Codex — ${codexConfigPath()}\n`);
  switch (codexPlan.kind) {
    case 'add':
      process.stdout.write('    ADD      notify -> session-radar dispatcher\n');
      break;
    case 'wrap':
      process.stdout.write('    WRAP     an existing notify program is already configured:\n');
      process.stdout.write(`               ${(codexPlan.existingArgv ?? []).join(' ')}\n`);
      process.stdout.write(
        '             it will run FIRST and unchanged; session-radar is told afterwards\n',
      );
      break;
    case 'already-installed':
      process.stdout.write('    present  dispatcher already installed\n');
      break;
    case 'manual':
      process.stdout.write(`    SKIP     ${codexPlan.reason ?? 'cannot edit safely'}\n`);
      process.stdout.write(`             current line: ${codexPlan.existingLine ?? '(none)'}\n`);
      break;
  }

  if (!apply) {
    process.stdout.write('\n  Dry run. Nothing was changed. Re-run with --apply to write.\n\n');
    return 0;
  }

  process.stdout.write('\n');
  const claudeResult = applyClaudeHooks(PORT);
  if (claudeResult.added.length > 0) {
    process.stdout.write(`  installed Claude Code hooks: ${claudeResult.added.join(', ')}\n`);
    if (claudeResult.backupPath) process.stdout.write(`  backup: ${claudeResult.backupPath}\n`);
  } else {
    process.stdout.write('  Claude Code hooks already present\n');
  }

  const codexResult = applyCodexNotify(PORT);
  if (codexResult.applied) {
    process.stdout.write(`  installed Codex dispatcher: ${codexResult.dispatcherPath}\n`);
    if (codexResult.backupPath) process.stdout.write(`  backup: ${codexResult.backupPath}\n`);
  } else {
    process.stdout.write(`  Codex: ${codexResult.reason ?? codexResult.kind}\n`);
  }
  process.stdout.write('\n  Restart any running claude/codex sessions to pick the hooks up.\n\n');
  return 0;
}

function uninstallHooks(apply: boolean): number {
  if (!apply) {
    process.stdout.write('\n  Dry run. Re-run with --apply to remove session-radar hooks.\n\n');
    return 0;
  }
  const claude = removeClaudeHooks();
  const codex = removeCodexNotify();
  process.stdout.write(
    `\n  Claude Code: ${claude.removed.length > 0 ? `removed from ${claude.removed.join(', ')}` : 'nothing to remove'}\n`,
  );
  process.stdout.write(
    `  Codex: ${codex.restored ? 'original notify restored' : 'nothing to remove'}\n\n`,
  );
  return 0;
}

async function doctor(): Promise<number> {
  const health = await fetchJson<{ ok: boolean; db: { path: string; fileMode: string } }>(
    '/api/health',
  );
  const rows: [string, string][] = [
    ['daemon', health ? `up at ${BASE}` : `NOT RUNNING at ${BASE}`],
    ['database', existsSync(dbPath()) ? dbPath() : `missing (${dbPath()})`],
    ['db mode', health?.db.fileMode ?? '(unknown — daemon down)'],
    ['claude settings', existsSync(claudeSettingsPath()) ? claudeSettingsPath() : 'not found'],
    ['codex config', existsSync(codexConfigPath()) ? codexConfigPath() : 'not found'],
  ];
  const plan = planClaudeHooks(PORT);
  rows.push([
    'claude hooks',
    plan.entries.every((e) => e.action === 'already-installed')
      ? 'installed'
      : `missing ${plan.entries.filter((e) => e.action === 'add').length} of ${plan.entries.length}`,
  ]);
  const codexPlan = planCodexNotify(PORT);
  rows.push(['codex notify', codexPlan.kind]);

  process.stdout.write('\n');
  for (const [label, value] of rows) {
    process.stdout.write(`  ${label.padEnd(18)}${value}\n`);
  }
  process.stdout.write('\n');
  return health ? 0 : 1;
}

// --- helpers ----------------------------------------------------------------

function reasonOf(raw: unknown): string {
  if (raw && typeof raw === 'object' && 'reason' in raw) {
    return String((raw as { reason: unknown }).reason);
  }
  return '';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function relative(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
