import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TITLE_MAX_CHARS } from '@session-radar/shared';
import { StatusEngine } from '../engine.js';
import { createNullLogger } from '../logger.js';
import { ConnectorRegistry } from '../registry.js';
import type { TempStore } from '../testing.js';
import { createTempStore } from '../testing.js';
import { ClaudeCodeConnector, resumeCommand, shellQuote } from './claude-code/connector.js';
import { TranscriptDirMissingError, listTranscripts, readTranscriptMeta, titleFor } from './claude-code/transcript.js';
import { CodexConnector, codexResumeCommand } from './codex/connector.js';
import { RolloutDirMissingError, listRollouts, readRolloutMeta, sessionIdFromRolloutName } from './codex/rollout.js';
import { claudeSignalFor } from './ingest.js';

const SESSION = '4fd396ed-5473-4d2d-b60f-38c096b1337a';
const CODEX_SESSION = '019fa7ae-3778-7671-ba66-b2fd928d7156';

function jsonl(records: unknown[]): string {
  return `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

describe('Claude Code transcripts', () => {
  let ctx: TempStore;
  let projectsDir: string;

  beforeEach(() => {
    ctx = createTempStore();
    projectsDir = join(ctx.home, 'projects');
    mkdirSync(join(projectsDir, '-Users-victor-code-billing'), { recursive: true });
  });
  afterEach(() => ctx.close());

  function writeTranscript(records: unknown[], sessionId = SESSION): string {
    const path = join(projectsDir, '-Users-victor-code-billing', `${sessionId}.jsonl`);
    writeFileSync(path, jsonl(records));
    return path;
  }

  it('takes the session id from the filename and cwd from the records', async () => {
    writeTranscript([
      { type: 'user', timestamp: '2026-07-28T10:00:00.000Z', cwd: '/Users/victor/code/billing', gitBranch: 'main', version: '2.1.0', message: { role: 'user', content: 'Fix the invoice rounding bug' } },
    ]);
    const files = listTranscripts(projectsDir);
    expect(files).toHaveLength(1);
    expect(files[0]?.sessionId).toBe(SESSION);

    const meta = await readTranscriptMeta(files[0]!);
    expect(meta.cwd).toBe('/Users/victor/code/billing');
    expect(meta.gitBranch).toBe('main');
    expect(meta.version).toBe('2.1.0');
    expect(meta.firstUserMessage).toBe('Fix the invoice rounding bug');
  });

  it('prefers custom-title, which needs no message content at all', async () => {
    writeTranscript([
      { type: 'user', timestamp: '2026-07-28T10:00:00.000Z', message: { role: 'user', content: 'some long rambling prompt' } },
      { type: 'custom-title', customTitle: 'Session-radar dashboard v0', sessionId: SESSION },
    ]);
    const meta = await readTranscriptMeta(listTranscripts(projectsDir)[0]!);
    expect(titleFor(meta, 'fallback')).toBe('Session-radar dashboard v0');
  });

  it('never returns more than the title budget of message content', async () => {
    writeTranscript([
      { type: 'user', timestamp: '2026-07-28T10:00:00.000Z', message: { role: 'user', content: 'x'.repeat(9_000) } },
    ]);
    const meta = await readTranscriptMeta(listTranscripts(projectsDir)[0]!);
    expect((meta.firstUserMessage ?? '').length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });

  it('ignores tool-injected context blocks when titling', async () => {
    writeTranscript([
      { type: 'user', timestamp: '2026-07-28T10:00:00.000Z', message: { role: 'user', content: '<system-reminder>be careful</system-reminder>' } },
    ]);
    const meta = await readTranscriptMeta(listTranscripts(projectsDir)[0]!);
    expect(meta.firstUserMessage).toBeUndefined();
    expect(titleFor(meta, 'billing · abcd1234')).toBe('billing · abcd1234');
  });

  it('ignores subagent turns when looking for the first user message', async () => {
    writeTranscript([
      { type: 'user', isSidechain: true, timestamp: '2026-07-28T10:00:00.000Z', message: { role: 'user', content: 'subagent instructions' } },
      { type: 'user', timestamp: '2026-07-28T10:01:00.000Z', message: { role: 'user', content: 'the real prompt' } },
    ]);
    const meta = await readTranscriptMeta(listTranscripts(projectsDir)[0]!);
    expect(meta.firstUserMessage).toBe('the real prompt');
  });

  it('handles array content blocks', async () => {
    writeTranscript([
      { type: 'user', timestamp: '2026-07-28T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'block form prompt' }] } },
    ]);
    const meta = await readTranscriptMeta(listTranscripts(projectsDir)[0]!);
    expect(meta.firstUserMessage).toBe('block form prompt');
  });

  it('survives a corrupt line without losing the rest', async () => {
    const path = join(projectsDir, '-Users-victor-code-billing', `${SESSION}.jsonl`);
    writeFileSync(path, `not json at all\n${JSON.stringify({ type: 'user', timestamp: '2026-07-28T10:00:00.000Z', cwd: '/x', message: { role: 'user', content: 'still parsed' } })}\n`);
    const meta = await readTranscriptMeta(listTranscripts(projectsDir)[0]!);
    expect(meta.firstUserMessage).toBe('still parsed');
  });

  it('throws rather than reporting "no sessions" when the directory is gone', () => {
    expect(() => listTranscripts(join(ctx.home, 'does-not-exist'))).toThrow(TranscriptDirMissingError);
  });
});

describe('Claude Code connector', () => {
  let ctx: TempStore;
  let projectsDir: string;
  let registry: ConnectorRegistry;

  beforeEach(() => {
    ctx = createTempStore();
    projectsDir = join(ctx.home, 'projects');
    mkdirSync(join(projectsDir, '-Users-victor-code-billing'), { recursive: true });
    writeFileSync(
      join(projectsDir, '-Users-victor-code-billing', `${SESSION}.jsonl`),
      jsonl([
        { type: 'user', timestamp: new Date().toISOString(), cwd: '/Users/victor/code/billing', message: { role: 'user', content: 'Fix the rounding bug' } },
      ]),
    );
    registry = new ConnectorRegistry(ctx.store, ctx.bus, createNullLogger(), {
      defaultScanIntervalMs: 3_600_000,
      backoffStartMs: 3_600_000,
    });
  });
  afterEach(async () => {
    await registry.stopAll();
    ctx.close();
  });

  function connector(dir = projectsDir): ClaudeCodeConnector {
    return new ClaudeCodeConnector({
      engine: new StatusEngine(ctx.store),
      projectsDir: dir,
      probeProcesses: false,
      device: 'test-mac',
    });
  }

  it('turns a transcript into a running work item with a resume command', async () => {
    registry.register(connector());
    await registry.startAll();

    const items = ctx.store.listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('running');
    expect(items[0]?.title).toBe('Fix the rounding bug');
    expect(items[0]?.context.repo).toBe('billing');
    expect(items[0]?.entryPoints[0]?.resumeCommand).toContain(`claude --resume ${SESSION}`);
    expect(ctx.store.getCoverage('claude-code-cli')?.state).toBe('ok');
  });

  it('goes DOWN — and keeps its work items — when the projects directory disappears', async () => {
    registry.register(connector());
    await registry.startAll();
    expect(ctx.store.countWorkItems()).toBe(1);

    // Simulate the directory being revoked between scans.
    const gone = connector(join(ctx.home, 'revoked'));
    const registry2 = new ConnectorRegistry(ctx.store, ctx.bus, createNullLogger(), {
      failuresBeforeDown: 1,
      defaultScanIntervalMs: 3_600_000,
      backoffStartMs: 3_600_000,
    });
    // Re-register under a fresh registry pointing at the missing directory.
    ctx.store.registerConnector({ id: 'claude-code-cli', displayName: 'Claude Code CLI' });
    registry2.register(Object.assign(Object.create(Object.getPrototypeOf(gone)), gone, { id: 'claude-code-cli-2' }));
    await registry2.startAll();
    await registry2.stopAll();

    const health = ctx.store.getCoverage('claude-code-cli-2');
    expect(health?.state).toBe('down');
    expect(health?.lastError).toMatch(/transcript directory not found/i);
    // The crucial half: nothing vanished.
    expect(ctx.store.countWorkItems()).toBe(1);
  });

  it('counts sessions outside the history window instead of hiding them', async () => {
    const old = join(projectsDir, '-Users-victor-code-old', 'aaaaaaaa-0000-0000-0000-000000000000.jsonl');
    mkdirSync(join(projectsDir, '-Users-victor-code-old'), { recursive: true });
    writeFileSync(old, jsonl([{ type: 'user', timestamp: '2020-01-01T00:00:00.000Z', cwd: '/old', message: { role: 'user', content: 'ancient' } }]));
    // mtime is now, so force a tiny window instead.
    const c = new ClaudeCodeConnector({
      engine: new StatusEngine(ctx.store),
      projectsDir,
      probeProcesses: false,
      historyWindowMs: -1,
    });
    registry.register(c);
    await registry.startAll();
    const health = ctx.store.getCoverage('claude-code-cli');
    expect(health?.observedSessionCount).toBe(0);
    expect(health?.archivedSessionCount).toBe(2);
  });
});

describe('Codex rollouts', () => {
  let ctx: TempStore;
  let sessionsDir: string;

  beforeEach(() => {
    ctx = createTempStore();
    sessionsDir = join(ctx.home, 'sessions', '2026', '07', '28');
    mkdirSync(sessionsDir, { recursive: true });
  });
  afterEach(() => ctx.close());

  function writeRollout(records: unknown[]): void {
    writeFileSync(
      join(sessionsDir, `rollout-2026-07-28T17-44-00-${CODEX_SESSION}.jsonl`),
      jsonl(records),
    );
  }

  it('extracts the session id from the filename', () => {
    expect(sessionIdFromRolloutName(`rollout-2026-07-28T17-44-00-${CODEX_SESSION}.jsonl`)).toBe(CODEX_SESSION);
    expect(sessionIdFromRolloutName('notes.jsonl')).toBeUndefined();
  });

  it('reads cwd and version from session_meta', async () => {
    writeRollout([
      { timestamp: '2026-07-28T05:41:56.000Z', type: 'session_meta', payload: { id: CODEX_SESSION, cwd: '/Users/victor/code/auth', cli_version: '0.144.1', originator: 'codex_cli_rs' } },
    ]);
    const meta = await readRolloutMeta(listRollouts(join(ctx.home, 'sessions'))[0]!);
    expect(meta.cwd).toBe('/Users/victor/code/auth');
    expect(meta.cliVersion).toBe('0.144.1');
  });

  it('titles from event_msg/user_message, not the injected response_item stream', async () => {
    writeRollout([
      { timestamp: '2026-07-28T05:41:56.000Z', type: 'session_meta', payload: { cwd: '/x' } },
      { timestamp: '2026-07-28T05:41:57.000Z', type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>\nHere is a list' }] } },
      { timestamp: '2026-07-28T05:41:59.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Review the retry strategy' } },
    ]);
    const meta = await readRolloutMeta(listRollouts(join(ctx.home, 'sessions'))[0]!);
    expect(meta.firstUserMessage).toBe('Review the retry strategy');
  });

  it('rejects a platform preamble that arrives as the user message', async () => {
    writeRollout([
      { timestamp: '2026-07-28T05:41:56.000Z', type: 'session_meta', payload: { cwd: '/x' } },
      { timestamp: '2026-07-28T05:41:59.000Z', type: 'event_msg', payload: { type: 'user_message', message: '[Base]\nYou are operating inside the Buzz platform' } },
    ]);
    const meta = await readRolloutMeta(listRollouts(join(ctx.home, 'sessions'))[0]!);
    expect(meta.firstUserMessage).toBeUndefined();
  });

  it('throws rather than reporting zero when the sessions directory is gone', () => {
    expect(() => listRollouts(join(ctx.home, 'nope'))).toThrow(RolloutDirMissingError);
  });

  it('produces the verified resume syntax', () => {
    expect(codexResumeCommand(CODEX_SESSION, undefined)).toBe(`codex resume ${CODEX_SESSION}`);
    expect(codexResumeCommand(CODEX_SESSION, '/a b/c')).toBe(`cd '/a b/c' && codex resume ${CODEX_SESSION}`);
  });
});

describe('Codex connector', () => {
  let ctx: TempStore;
  let registry: ConnectorRegistry;

  beforeEach(() => {
    ctx = createTempStore();
    const dir = join(ctx.home, 'sessions', '2026', '07', '28');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-07-28T17-44-00-${CODEX_SESSION}.jsonl`),
      jsonl([
        { timestamp: new Date().toISOString(), type: 'session_meta', payload: { cwd: '/Users/victor/code/auth', cli_version: '0.144.1' } },
        { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'Migrate the auth service' } },
      ]),
    );
    registry = new ConnectorRegistry(ctx.store, ctx.bus, createNullLogger(), {
      defaultScanIntervalMs: 3_600_000,
      backoffStartMs: 3_600_000,
    });
  });
  afterEach(async () => {
    await registry.stopAll();
    ctx.close();
  });

  it('produces a running work item under the openai provider', async () => {
    registry.register(
      new CodexConnector({
        engine: new StatusEngine(ctx.store),
        sessionsDir: join(ctx.home, 'sessions'),
        probeProcesses: false,
      }),
    );
    await registry.startAll();

    const items = ctx.store.listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.provider).toBe('openai');
    expect(items[0]?.title).toBe('Migrate the auth service');
    expect(items[0]?.status).toBe('running');
    expect(items[0]?.entryPoints[0]?.resumeCommand).toContain(`codex resume ${CODEX_SESSION}`);
  });
});

describe('shell quoting', () => {
  it('survives spaces and quotes in paths', () => {
    expect(shellQuote('/Users/v/AI Session Status Dashboard')).toBe(
      `'/Users/v/AI Session Status Dashboard'`,
    );
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('embeds the cwd in the resume command so --resume lands in the right project', () => {
    expect(resumeCommand('abc', '/a b')).toBe(`cd '/a b' && claude --resume abc`);
    expect(resumeCommand('abc', undefined)).toBe('claude --resume abc');
  });
});

describe('Claude hook event mapping', () => {
  it('maps the events we install', () => {
    expect(claudeSignalFor('Stop', undefined).signal).toBe('claude_code.stop');
    expect(claudeSignalFor('PostToolUse', undefined).signal).toBe('claude_code.post_tool_use');
    expect(claudeSignalFor('PermissionRequest', undefined).signal).toBe('claude_code.permission_request');
    expect(claudeSignalFor('SessionEnd', undefined).signal).toBe('claude_code.session_end');
  });

  it('treats blocking notification types as blocking', () => {
    for (const type of ['permission_prompt', 'idle_prompt', 'agent_needs_input', 'elicitation_dialog']) {
      const mapped = claudeSignalFor('Notification', type);
      expect(mapped.signal).toContain(type);
      expect(mapped.warning).toBeUndefined();
    }
  });

  it('does NOT cry wolf on informational notifications', () => {
    const mapped = claudeSignalFor('Notification', 'auth_success');
    expect(mapped.signal).toBe('claude_code.notification.info');
    expect(mapped.warning).toBeUndefined();
  });

  it('warns loudly about an unrecognised notification type instead of guessing', () => {
    const mapped = claudeSignalFor('Notification', 'brand_new_type');
    expect(mapped.signal).toBe('claude_code.notification.info');
    expect(mapped.warning).toMatch(/unrecognised/);
  });

  it('ignores events we did not install', () => {
    expect(claudeSignalFor('PreCompact', undefined).signal).toBeUndefined();
  });
});
