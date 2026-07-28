/**
 * Demo harness for M0.
 *
 * Writes a believable session matrix into a SEPARATE demo store
 * (`~/.session-radar-demo`) so the real one is never touched, and so nothing here
 * can ever be mistaken for real data.
 *
 * Everything below goes through the same `Store` + `decideStatus` path a real
 * connector will use in M1/M2 — statuses are DERIVED from observations, not
 * hardcoded. That is the point: it exercises the spine rather than faking it.
 *
 *   pnpm demo seed         reset and populate the demo store
 *   pnpm demo flip         drive a running item into needs_victor (watch SSE)
 *   pnpm demo break        take a connector down (watch coverage, watch items stay)
 *   pnpm demo fix          bring it back
 *   pnpm demo show         print the current state as a table
 */
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Observation, Provider, Source, Surface } from '@session-radar/shared';
import { canonicalKey, decideStatus, deriveTitle } from '@session-radar/shared';
import { EventBus, Store, openDb } from '@session-radar/daemon';

const DEMO_HOME = join(homedir(), '.session-radar-demo');
process.env['SESSION_RADAR_HOME'] = DEMO_HOME;

const MIN = 60_000;
const now = Date.now();
const ago = (minutes: number): number => now - minutes * MIN;

const DEVICE = 'victors-mac';

const SOURCES: Record<string, Source> = {
  claudeCli: { id: 'claude-code-cli', provider: 'anthropic', surface: 'cli', device: DEVICE },
  codexCli: { id: 'codex-cli', provider: 'openai', surface: 'cli', device: DEVICE },
  claudeWeb: { id: 'claude-web', provider: 'anthropic', surface: 'extension', device: DEVICE },
  chatgptWeb: { id: 'chatgpt-web', provider: 'openai', surface: 'extension', device: DEVICE },
  claudeDesktop: { id: 'claude-desktop', provider: 'anthropic', surface: 'desktop', device: DEVICE },
};

interface DemoSession {
  externalId: string;
  provider: Provider;
  surface: Surface;
  /** The first user message. Only the first 120 chars ever become the title. */
  firstMessage: string;
  observations: Observation[];
  entryPoints: {
    source: Source;
    url?: string;
    resumeCommand?: string;
    locateHint?: string;
  }[];
  context?: { cwd?: string; repo?: string; conversationId?: string; url?: string };
  markSeen?: boolean;
}

const SESSIONS: DemoSession[] = [
  {
    externalId: 'sess-billing-perm',
    provider: 'anthropic',
    surface: 'cli',
    firstMessage:
      'Refactor the billing module so invoice generation and tax calculation stop sharing mutable state, then add regression tests for the proration edge cases we hit last quarter',
    observations: [
      { signal: 'claude_code.session_start', at: ago(35) },
      { signal: 'claude_code.post_tool_use', at: ago(3) },
      { signal: 'claude_code.notification.permission_prompt', at: ago(2) },
    ],
    entryPoints: [
      { source: SOURCES.claudeCli!, resumeCommand: 'claude --resume sess-billing-perm' },
    ],
    context: { cwd: '/Users/victor/code/billing', repo: 'billing' },
  },
  {
    externalId: 'conv-gpt-login',
    provider: 'openai',
    surface: 'extension',
    firstMessage: 'Draft the Q3 investor update covering ARR, churn and the enterprise pipeline',
    observations: [
      { signal: 'web.generating', at: ago(10) },
      { signal: 'web.blocked', at: ago(8) },
    ],
    entryPoints: [{ source: SOURCES.chatgptWeb!, url: 'https://chatgpt.com/c/conv-gpt-login' }],
    context: { conversationId: 'conv-gpt-login', url: 'https://chatgpt.com/c/conv-gpt-login' },
  },
  {
    externalId: 'sess-codex-migration',
    provider: 'openai',
    surface: 'cli',
    firstMessage: 'Migrate the auth service off the deprecated session table',
    observations: [
      { signal: 'codex.rollout_write', at: ago(7) },
      { signal: 'codex.turn_complete', at: ago(5) },
    ],
    entryPoints: [{ source: SOURCES.codexCli!, resumeCommand: 'codex resume sess-codex-migration' }],
    context: { cwd: '/Users/victor/code/auth', repo: 'auth' },
  },
  {
    externalId: 'conv-claude-schema',
    provider: 'anthropic',
    surface: 'extension',
    firstMessage: 'Review this database schema for normalization problems',
    observations: [
      { signal: 'web.generating', at: ago(14) },
      { signal: 'web.completed', at: ago(12) },
    ],
    entryPoints: [{ source: SOURCES.claudeWeb!, url: 'https://claude.ai/chat/conv-claude-schema' }],
    context: { conversationId: 'conv-claude-schema', url: 'https://claude.ai/chat/conv-claude-schema' },
  },
  {
    externalId: 'sess-dead-worker',
    provider: 'anthropic',
    surface: 'cli',
    firstMessage: 'Rewrite the ETL worker to stream instead of buffering the whole file',
    observations: [
      { signal: 'claude_code.post_tool_use', at: ago(42) },
      { signal: 'claude_code.process_dead', at: ago(40) },
    ],
    entryPoints: [{ source: SOURCES.claudeCli!, resumeCommand: 'claude --resume sess-dead-worker' }],
    context: { cwd: '/Users/victor/code/etl', repo: 'etl' },
  },
  {
    externalId: 'conv-abandoned',
    provider: 'anthropic',
    surface: 'extension',
    firstMessage: 'Explain the tradeoffs between event sourcing and a plain audit log',
    observations: [{ signal: 'web.generating', at: ago(25) }],
    entryPoints: [{ source: SOURCES.claudeWeb!, url: 'https://claude.ai/chat/conv-abandoned' }],
    context: { conversationId: 'conv-abandoned', url: 'https://claude.ai/chat/conv-abandoned' },
  },
  {
    externalId: 'sess-radar-m1',
    provider: 'anthropic',
    surface: 'cli',
    firstMessage: 'Build the Claude Code connector for session-radar M1',
    observations: [
      { signal: 'claude_code.session_start', at: ago(12) },
      { signal: 'claude_code.post_tool_use', at: now - 30_000 },
    ],
    entryPoints: [{ source: SOURCES.claudeCli!, resumeCommand: 'claude --resume sess-radar-m1' }],
    context: { cwd: '/Users/victor/code/session-radar', repo: 'session-radar' },
  },
  {
    externalId: 'sess-codex-flaky',
    provider: 'openai',
    surface: 'cli',
    firstMessage: 'Find why the checkout integration test is flaky on CI but not locally',
    observations: [{ signal: 'codex.rollout_write', at: now - 60_000 }],
    entryPoints: [{ source: SOURCES.codexCli!, resumeCommand: 'codex resume sess-codex-flaky' }],
    context: { cwd: '/Users/victor/code/storefront', repo: 'storefront' },
  },
  {
    externalId: 'sess-old-done',
    provider: 'anthropic',
    surface: 'cli',
    firstMessage: 'Add the OpenAPI spec for the payments endpoints',
    observations: [{ signal: 'claude_code.stop', at: ago(90) }],
    entryPoints: [{ source: SOURCES.claudeCli!, resumeCommand: 'claude --resume sess-old-done' }],
    context: { cwd: '/Users/victor/code/payments', repo: 'payments' },
    markSeen: true,
  },
  {
    // The dedup case: one conversation, open in the web app AND the desktop app.
    // Two entry points, ONE work item.
    externalId: 'conv-crossover',
    provider: 'anthropic',
    surface: 'extension',
    firstMessage: 'Compare our retry strategy against the AWS SDK defaults',
    observations: [{ signal: 'web.generating', at: ago(2) }],
    entryPoints: [
      { source: SOURCES.claudeWeb!, url: 'https://claude.ai/chat/conv-crossover' },
      { source: SOURCES.claudeDesktop!, locateHint: 'Claude Desktop -> Recents -> "retry strategy"' },
    ],
    context: { conversationId: 'conv-crossover', url: 'https://claude.ai/chat/conv-crossover' },
  },
];

interface DemoConnector {
  id: string;
  displayName: string;
  provider?: Provider;
  surface?: Surface;
  state: 'ok' | 'degraded' | 'down' | 'unsupported';
  lastError?: string;
  permissionState?: 'granted' | 'denied' | 'unknown' | 'not_required';
  observed: number;
  lastScanMinutesAgo?: number;
}

const CONNECTORS: DemoConnector[] = [
  {
    id: 'claude-code-cli',
    displayName: 'Claude Code CLI',
    provider: 'anthropic',
    surface: 'cli',
    state: 'ok',
    observed: 4,
    permissionState: 'granted',
    lastScanMinutesAgo: 0,
  },
  {
    id: 'codex-cli',
    displayName: 'Codex CLI',
    provider: 'openai',
    surface: 'cli',
    state: 'ok',
    observed: 2,
    permissionState: 'granted',
    lastScanMinutesAgo: 0,
  },
  {
    id: 'claude-web',
    displayName: 'claude.ai (extension)',
    provider: 'anthropic',
    surface: 'extension',
    state: 'degraded',
    lastError: 'stop-button selector not found — claude.ai markup may have changed',
    observed: 3,
    permissionState: 'granted',
    lastScanMinutesAgo: 0,
  },
  {
    id: 'chatgpt-web',
    displayName: 'chatgpt.com (extension)',
    provider: 'openai',
    surface: 'extension',
    state: 'ok',
    observed: 1,
    permissionState: 'granted',
    lastScanMinutesAgo: 0,
  },
  {
    id: 'claude-desktop',
    displayName: 'Claude Desktop',
    provider: 'anthropic',
    surface: 'desktop',
    state: 'down',
    lastError: 'EPERM reading ~/Library/Application Support/Claude — grant Full Disk Access',
    observed: 0,
    permissionState: 'denied',
    lastScanMinutesAgo: 18,
  },
  {
    id: 'chatgpt-macos',
    displayName: 'ChatGPT for macOS',
    provider: 'openai',
    surface: 'desktop',
    state: 'unsupported',
    lastError: 'no observable session state without the Accessibility API (M3 verdict pending)',
    observed: 0,
    permissionState: 'unknown',
  },
];

function openStore(): { store: Store; close(): void } {
  const opened = openDb();
  const bus = new EventBus();
  return { store: new Store(opened.db, bus), close: () => opened.db.close() };
}

function seed(): void {
  rmSync(DEMO_HOME, { recursive: true, force: true });
  const { store, close } = openStore();

  try {
    for (const connector of CONNECTORS) {
      store.registerConnector({
        id: connector.id,
        displayName: connector.displayName,
        ...(connector.provider ? { provider: connector.provider } : {}),
        ...(connector.surface ? { surface: connector.surface } : {}),
      });
      store.updateCoverage(connector.id, {
        state: connector.state,
        lastError: connector.lastError ?? null,
        observedSessionCount: connector.observed,
        ...(connector.permissionState ? { permissionState: connector.permissionState } : {}),
        lastSuccessfulScanAt:
          connector.lastScanMinutesAgo === undefined ? null : ago(connector.lastScanMinutesAgo),
      });
    }

    for (const session of SESSIONS) {
      // The status is DERIVED, exactly as a real connector would derive it.
      const decision = decideStatus({
        observations: session.observations,
        surface: session.surface,
        now,
      });
      const lastActivity = session.observations.reduce((max, o) => Math.max(max, o.at), 0);
      const identity = canonicalKey(session.provider, session.externalId);
      // Privacy boundary in action: only the first 120 chars ever become a title.
      const title = deriveTitle(session.firstMessage);

      let workItemId = '';
      for (const entry of session.entryPoints) {
        const result = store.recordSighting({
          identity,
          provider: session.provider,
          title,
          source: entry.source,
          externalId: session.externalId,
          ...(session.context ? { context: session.context } : {}),
          ...(entry.url ? { url: entry.url } : {}),
          ...(entry.resumeCommand ? { resumeCommand: entry.resumeCommand } : {}),
          ...(entry.locateHint ? { locateHint: entry.locateHint } : {}),
          at: lastActivity,
          decision,
          connectorId: entry.source.id,
        });
        workItemId = result.workItemId;
      }

      if (session.markSeen) store.setAttention(workItemId, 'seen');
    }

    show(store);
    console.log(`\nDemo store seeded at ${DEMO_HOME}`);
  } finally {
    close();
  }
}

function flip(): void {
  const { store, close } = openStore();
  try {
    const target = store
      .listWorkItems()
      .find((item) => item.status === 'running' && item.entryPoints[0]?.source.surface === 'cli');
    if (!target) {
      console.log('no running CLI item to flip — run `pnpm demo seed` first');
      return;
    }
    const decision = decideStatus({
      observations: [
        { signal: 'claude_code.post_tool_use', at: Date.now() - 30_000 },
        { signal: 'claude_code.notification.permission_prompt', at: Date.now() },
      ],
      surface: 'cli',
      now: Date.now(),
    });
    store.applyDecision(target.id, decision, { connectorId: 'claude-code-cli' });
    console.log(`flipped "${target.title.slice(0, 60)}"`);
    console.log(`  ${target.status} -> ${decision.status}  (${decision.rule})`);
    console.log(`  reason: ${decision.reason}`);
  } finally {
    close();
  }
}

function setConnector(broken: boolean): void {
  const { store, close } = openStore();
  try {
    store.updateCoverage('claude-code-cli', {
      state: broken ? 'down' : 'ok',
      lastError: broken ? 'ENOENT: ~/.claude/projects — directory is gone' : null,
      observedSessionCount: broken ? 0 : 4,
      lastSuccessfulScanAt: broken ? ago(6) : Date.now(),
    });
    console.log(
      broken
        ? 'claude-code-cli is now DOWN — note that its work items are still listed'
        : 'claude-code-cli is healthy again',
    );
  } finally {
    close();
  }
}

function show(existing?: Store): void {
  const opened = existing ? undefined : openStore();
  const store = existing ?? opened!.store;
  try {
    const items = store.listWorkItems();
    const coverage = store.listCoverage();

    const counts = {
      needs_victor: items.filter((i) => i.status === 'needs_victor').length,
      done_unseen: items.filter((i) => i.status === 'done' && i.attention === 'unseen').length,
      stale: items.filter((i) => i.status === 'stale').length,
      running: items.filter((i) => i.status === 'running').length,
    };

    console.log('');
    console.log(
      `  NEEDS VICTOR ${counts.needs_victor}   DONE unseen ${counts.done_unseen}   ` +
        `STALE ${counts.stale}   RUNNING ${counts.running}`,
    );
    console.log('');

    for (const item of items) {
      const surfaces = [...new Set(item.entryPoints.map((e) => e.source.surface))].join('+');
      const where = item.context.repo ?? item.context.conversationId ?? '-';
      const age = Math.round((Date.now() - item.lastActivityAt) / MIN);
      const seen = item.status === 'done' ? ` [${item.attention}]` : '';
      console.log(
        `  ${item.status.toUpperCase().padEnd(13)}${seen.padEnd(10)}${truncate(item.title, 46).padEnd(48)}` +
          `${surfaces.padEnd(16)}${truncate(where, 16).padEnd(18)}${age}m`,
      );
      console.log(`      ${item.currentEvidence?.rule ?? '?'} — ${item.currentEvidence ? reasonOf(item.currentEvidence.raw) : ''}`);
    }

    console.log('');
    console.log('  COVERAGE');
    for (const c of coverage) {
      const detail = c.lastError ? `  ${truncate(c.lastError, 68)}` : '';
      console.log(`  ${c.state.toUpperCase().padEnd(13)}${c.displayName.padEnd(26)}${String(c.observedSessionCount).padStart(2)} seen${detail}`);
    }
    console.log('');
  } finally {
    opened?.close();
  }
}

function reasonOf(raw: unknown): string {
  if (raw && typeof raw === 'object' && 'reason' in raw) return String((raw as { reason: unknown }).reason);
  return '';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const command = process.argv[2] ?? 'show';
switch (command) {
  case 'seed':
    seed();
    break;
  case 'flip':
    flip();
    break;
  case 'break':
    setConnector(true);
    break;
  case 'fix':
    setConnector(false);
    break;
  case 'show':
    show();
    break;
  default:
    console.log('usage: pnpm demo <seed|flip|break|fix|show>');
    process.exitCode = 1;
}
