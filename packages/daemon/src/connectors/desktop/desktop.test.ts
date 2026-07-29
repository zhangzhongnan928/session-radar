import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalKey } from '@session-radar/shared';
import { StatusEngine } from '../../engine.js';
import { createNullLogger } from '../../logger.js';
import { ConnectorRegistry } from '../../registry.js';
import type { TempStore } from '../../testing.js';
import { createTempStore } from '../../testing.js';
import {
  CLAUDE_CODE_DESKTOP_CONNECTOR_ID,
  ClaudeCodeDesktopConnector,
  listClaudeDesktopSessionFiles,
  readClaudeDesktopSession,
} from './claude-code.js';

const CLI_SESSION = '944d73d6-1111-4222-8333-123456789abc';
const DESKTOP_SESSION = 'local_434a87c1-1111-4222-8333-abcdef123456';

describe('Claude Code Desktop', () => {
  let ctx: TempStore;
  let registry: ConnectorRegistry;
  let appPath: string;
  let sessionsDir: string;

  beforeEach(() => {
    ctx = createTempStore();
    appPath = join(ctx.home, 'Claude.app');
    sessionsDir = join(ctx.home, 'claude-code-sessions');
    mkdirSync(appPath, { recursive: true });
    mkdirSync(join(sessionsDir, 'account-1', 'workspace-1'), { recursive: true });
    registry = new ConnectorRegistry(ctx.store, ctx.bus, createNullLogger(), {
      defaultScanIntervalMs: 3_600_000,
      backoffStartMs: 3_600_000,
    });
  });

  afterEach(async () => {
    await registry.stopAll();
    ctx.close();
  });

  function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sessionId: DESKTOP_SESSION,
      cliSessionId: CLI_SESSION,
      title: 'Build the session radar',
      cwd: '/Users/victor/code/session-radar',
      createdAt: Date.now() - 60_000,
      lastActivityAt: Date.now(),
      completedTurns: 3,
      isArchived: false,
      model: 'claude-fable-5',
      permissionMode: 'auto',
      ...overrides,
    };
  }

  function writeMetadata(value = metadata(), name = `${DESKTOP_SESSION}.json`): string {
    const path = join(sessionsDir, 'account-1', 'workspace-1', name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  function connector(overrides: Partial<ConstructorParameters<typeof ClaudeCodeDesktopConnector>[0]> = {}) {
    return new ClaudeCodeDesktopConnector({
      engine: new StatusEngine(ctx.store),
      appPath,
      sessionsDir,
      checkHooks: false,
      device: 'test-mac',
      ...overrides,
    });
  }

  it('discovers a metadata-only Desktop session with a way back to it', async () => {
    writeMetadata();
    registry.register(connector());
    await registry.startAll();

    const items = ctx.store.listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Build the session radar');
    expect(items[0]?.status).toBe('running');
    expect(items[0]?.context.repo).toBe('session-radar');
    expect(items[0]?.entryPoints[0]).toMatchObject({
      externalId: DESKTOP_SESSION,
      source: { id: CLAUDE_CODE_DESKTOP_CONNECTOR_ID, surface: 'desktop' },
    });
    expect(items[0]?.entryPoints[0]?.locateHint).toContain('Claude Desktop → Code');
    expect(ctx.store.getCoverage(CLAUDE_CODE_DESKTOP_CONNECTOR_ID)?.state).toBe('ok');
  });

  it('joins to an existing CLI item by cliSessionId instead of duplicating it', async () => {
    const engine = new StatusEngine(ctx.store);
    engine.observe({
      identity: canonicalKey('anthropic', CLI_SESSION),
      provider: 'anthropic',
      surface: 'cli',
      title: 'CLI title',
      source: {
        id: 'claude-code-cli',
        provider: 'anthropic',
        surface: 'cli',
        device: 'test-mac',
      },
      externalId: CLI_SESSION,
      observations: [
        {
          signal: 'claude_code.transcript_write',
          at: Date.now() - 1_000,
          connectorId: 'claude-code-cli',
        },
      ],
      connectorId: 'claude-code-cli',
    });
    writeMetadata();

    registry.register(connector({ engine }));
    await registry.startAll();

    const items = ctx.store.listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.canonicalKey).toBe(canonicalKey('anthropic', CLI_SESSION).key);
    expect(items[0]?.entryPoints.map((entry) => entry.source.surface).sort()).toEqual([
      'cli',
      'desktop',
    ]);
  });

  it('validates the observed schema while ignoring unrelated private fields', () => {
    const path = writeMetadata({
      ...metadata(),
      promptSuggestion: 'this field must never be persisted',
      enabledMcpTools: { private: true },
    });
    const file = listClaudeDesktopSessionFiles(sessionsDir).find((entry) => entry.path === path);
    expect(file).toBeDefined();
    const parsed = readClaudeDesktopSession(file!);
    expect(parsed.cliSessionId).toBe(CLI_SESSION);
    expect('promptSuggestion' in parsed).toBe(false);
    expect('enabledMcpTools' in parsed).toBe(false);
  });

  it('degrades loudly when one metadata file has an unknown required shape', async () => {
    writeMetadata({ title: 'missing ids' });
    registry.register(connector());
    await registry.startAll();

    const health = ctx.store.getCoverage(CLAUDE_CODE_DESKTOP_CONNECTOR_ID);
    expect(health?.state).toBe('degraded');
    expect(health?.lastError).toMatch(/unrecognised schema/);
    expect(health?.observedSessionCount).toBe(0);
  });

  it('shows inventory but degrades live coverage when shared hooks are absent', async () => {
    writeMetadata();
    const settingsPath = join(ctx.home, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
    registry.register(connector({ checkHooks: true, settingsPath }));
    await registry.startAll();

    const health = ctx.store.getCoverage(CLAUDE_CODE_DESKTOP_CONNECTOR_ID);
    expect(health?.state).toBe('degraded');
    expect(health?.lastError).toMatch(/live running\/blocked\/done state is incomplete/);
  });

  it('backfills archived sessions without returning them to recent triage', async () => {
    writeMetadata(metadata({ isArchived: true }));
    registry.register(connector());
    await registry.startAll();

    const health = ctx.store.getCoverage(CLAUDE_CODE_DESKTOP_CONNECTOR_ID);
    expect(health?.observedSessionCount).toBe(0);
    expect(health?.archivedSessionCount).toBe(1);
    expect(ctx.store.listWorkItems()).toHaveLength(1);
    expect(ctx.store.listWorkItems(Date.now() - 7 * 24 * 60 * 60_000)).toHaveLength(0);
    expect(ctx.store.listWorkItems()[0]?.entryPoints[0]?.archived).toBe(true);
  });
});
