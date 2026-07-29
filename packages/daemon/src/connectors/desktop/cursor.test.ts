import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalKey } from '@session-radar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StatusEngine } from '../../engine.js';
import { createNullLogger } from '../../logger.js';
import { ConnectorRegistry } from '../../registry.js';
import type { TempStore } from '../../testing.js';
import { createTempStore } from '../../testing.js';
import {
  CURSOR_HEADERS_KEY,
  CursorConnector,
  listCursorAgentTranscripts,
  readCursorComposerInventory,
} from './cursor.js';

const NOW = 1_800_000_000_000;
const SESSION_RUNNING = '019fb000-1111-7000-8000-000000000101';
const SESSION_BLOCKED = '019fb000-1111-7000-8000-000000000102';
const SESSION_DONE = '019fb000-1111-7000-8000-000000000103';
const SESSION_UNKNOWN = '019fb000-1111-7000-8000-000000000104';

function createCursorDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
  `);
  db.close();
}

function writeHeaders(path: string, headers: unknown[]): void {
  const db = new Database(path);
  db.prepare(
    `INSERT INTO ItemTable (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(CURSOR_HEADERS_KEY, JSON.stringify({ allComposers: headers }));
  db.close();
}

function writeComposer(path: string, id: string, document: unknown): void {
  const db = new Database(path);
  db.prepare(
    `INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(`composerData:${id}`, JSON.stringify(document));
  db.close();
}

describe('Cursor metadata projection', () => {
  let ctx: TempStore;
  let databasePath: string;

  beforeEach(() => {
    ctx = createTempStore();
    databasePath = join(ctx.home, 'state.vscdb');
    createCursorDb(databasePath);
  });
  afterEach(() => ctx.close());

  it('materialises only allowlisted metadata and never conversation bodies', () => {
    writeHeaders(databasePath, [
      {
        composerId: SESSION_RUNNING,
        name: 'Safe source title',
        lastUpdatedAt: NOW,
        hasBlockingPendingActions: false,
      },
    ]);
    writeComposer(databasePath, SESSION_RUNNING, {
      composerId: SESSION_RUNNING,
      name: 'Safe source title',
      createdAt: NOW - 1_000,
      lastUpdatedAt: NOW,
      status: 'generating',
      generatingBubbleIds: ['bubble-1'],
      workspaceIdentifier: {
        uri: { fsPath: '/Users/test/code/radar' },
      },
      conversation: [{ text: 'SECRET PROMPT BODY MUST NEVER ESCAPE' }],
      conversationState: 'SECRET SERIALIZED STATE MUST NEVER ESCAPE',
      richText: 'SECRET RICH TEXT MUST NEVER ESCAPE',
      text: 'SECRET TEXT MUST NEVER ESCAPE',
      encryptionKey: 'SECRET KEY MUST NEVER ESCAPE',
    });

    const result = readCursorComposerInventory(databasePath);
    expect(result.composers).toHaveLength(1);
    expect(result.composers[0]).toMatchObject({
      composerId: SESSION_RUNNING,
      name: 'Safe source title',
      status: 'generating',
      generatingBubbleCount: 1,
      currentHeader: true,
      workspacePath: '/Users/test/code/radar',
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('reports non-JSON history without trying to decode it', () => {
    writeHeaders(databasePath, []);
    const db = new Database(databasePath);
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      `composerData:${SESSION_UNKNOWN}`,
      Buffer.from([0, 1, 2, 3]),
    );
    db.close();

    const result = readCursorComposerInventory(databasePath);
    expect(result.historyRecordCount).toBe(1);
    expect(result.validHistoryRecordCount).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/unrecognised encoding/i);
  });

  it('enumerates Cursor Agent CLI transcript filenames without reading bodies', () => {
    const projects = join(ctx.home, '.cursor', 'projects');
    const sessionDirectory = join(
      projects,
      'project-one',
      'agent-transcripts',
      SESSION_RUNNING,
    );
    const subagents = join(sessionDirectory, 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(sessionDirectory, `${SESSION_RUNNING}.jsonl`),
      '{"prompt":"SECRET CURSOR CLI BODY"}\n',
    );
    writeFileSync(
      join(subagents, `${SESSION_BLOCKED}.jsonl`),
      '{"response":"SECRET SUBAGENT BODY"}\n',
    );

    const result = listCursorAgentTranscripts(projects);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      externalId: SESSION_RUNNING,
    });
    expect(result.sessions[0]?.sizeBytes).toBeGreaterThan(0);
    expect(result.nestedSubagentCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});

describe('Cursor connector lifecycle', () => {
  let ctx: TempStore;
  let registry: ConnectorRegistry;
  let databasePath: string;
  let appPath: string;
  let cursorAgentProjectsDir: string;
  let clock: number;

  beforeEach(() => {
    ctx = createTempStore();
    databasePath = join(ctx.home, 'state.vscdb');
    appPath = join(ctx.home, 'Cursor.app');
    cursorAgentProjectsDir = join(ctx.home, '.cursor', 'projects');
    mkdirSync(appPath, { recursive: true });
    createCursorDb(databasePath);
    clock = NOW;
    registry = new ConnectorRegistry(ctx.store, ctx.bus, createNullLogger(), {
      defaultScanIntervalMs: 3_600_000,
      backoffStartMs: 3_600_000,
    });
  });
  afterEach(async () => {
    await registry.stopAll();
    ctx.close();
  });

  function connector(): CursorConnector {
    return new CursorConnector({
      engine: new StatusEngine(ctx.store, () => clock),
      databasePath,
      appPath,
      cursorAgentProjectsDir,
      probeProcesses: false,
      now: () => clock,
      device: 'test-mac',
    });
  }

  it('maps current lifecycle fields and keeps a return path for every row', async () => {
    writeHeaders(databasePath, [
      {
        composerId: SESSION_RUNNING,
        name: 'Run the migration',
        lastUpdatedAt: NOW,
        hasBlockingPendingActions: false,
      },
      {
        composerId: SESSION_BLOCKED,
        name: 'Approve the plan',
        lastUpdatedAt: NOW - 2_000,
        hasBlockingPendingActions: true,
      },
      {
        composerId: SESSION_UNKNOWN,
        subtitle: 'Background agent',
        lastUpdatedAt: NOW - 3_000,
        hasBlockingPendingActions: false,
        createdFromBackgroundAgent: { bcId: 'bc_agent-1234' },
      },
    ]);
    writeComposer(databasePath, SESSION_RUNNING, {
      composerId: SESSION_RUNNING,
      name: 'Run the migration',
      createdAt: NOW - 60_000,
      lastUpdatedAt: NOW,
      status: 'generating',
      generatingBubbleIds: [],
      workspaceIdentifier: { uri: { fsPath: '/code/radar' } },
    });
    writeComposer(databasePath, SESSION_BLOCKED, {
      composerId: SESSION_BLOCKED,
      name: 'Approve the plan',
      createdAt: NOW - 60_000,
      lastUpdatedAt: NOW - 2_000,
      status: 'none',
    });
    writeComposer(databasePath, SESSION_DONE, {
      composerId: SESSION_DONE,
      name: 'Finished composer',
      createdAt: NOW - 120_000,
      lastUpdatedAt: NOW - 5_000,
      status: 'completed',
      fullConversationHeadersOnly: [{}],
    });
    writeComposer(databasePath, SESSION_UNKNOWN, {
      composerId: SESSION_UNKNOWN,
      subtitle: 'Background agent',
      createdAt: NOW - 60_000,
      lastUpdatedAt: NOW - 3_000,
      status: 'none',
    });

    registry.register(connector());
    await registry.startAll();

    const byKey = new Map(
      ctx.store.listWorkItems().map((item) => [item.canonicalKey, item]),
    );
    expect(byKey.get(canonicalKey('cursor', SESSION_RUNNING).key)).toMatchObject({
      provider: 'cursor',
      status: 'running',
      title: 'Run the migration',
      context: { cwd: '/code/radar', repo: 'radar' },
    });
    expect(byKey.get(canonicalKey('cursor', SESSION_BLOCKED).key)?.status).toBe(
      'needs_victor',
    );
    expect(byKey.get(canonicalKey('cursor', SESSION_DONE).key)?.status).toBe(
      'done',
    );
    expect(byKey.get(canonicalKey('cursor', SESSION_UNKNOWN).key)).toMatchObject({
      status: 'stale',
      title: 'Background agent',
    });
    expect(
      byKey.get(canonicalKey('cursor', SESSION_UNKNOWN).key)?.entryPoints[0]?.url,
    ).toBe(
      'cursor://anysphere.cursor-deeplink/background-agent?bcId=bc_agent-1234',
    );
    for (const item of byKey.values()) {
      const entry = item.entryPoints[0];
      expect(entry?.url || entry?.locateHint).toBeTruthy();
    }
  });

  it('adds a verified Cursor Agent CLI resume path without changing desktop lifecycle', async () => {
    const sessionDirectory = join(
      cursorAgentProjectsDir,
      'project-one',
      'agent-transcripts',
      SESSION_DONE,
    );
    mkdirSync(sessionDirectory, { recursive: true });
    writeFileSync(
      join(sessionDirectory, `${SESSION_DONE}.jsonl`),
      '{"prompt":"SECRET CURSOR CLI BODY"}\n',
    );
    writeHeaders(databasePath, []);
    writeComposer(databasePath, SESSION_DONE, {
      composerId: SESSION_DONE,
      name: 'Finished in Cursor Agent',
      createdAt: NOW - 120_000,
      lastUpdatedAt: NOW - 5_000,
      status: 'completed',
      fullConversationHeadersOnly: [{}],
      conversation: [{ text: 'SECRET DESKTOP BODY' }],
    });

    registry.register(connector());
    await registry.startAll();

    const item = ctx.store.getWorkItemByCanonicalKey(
      canonicalKey('cursor', SESSION_DONE).key,
    );
    expect(item?.status).toBe('done');
    expect(
      item?.entryPoints.find(
        (entry) => entry.source.id === 'cursor-agent-cli',
      ),
    ).toMatchObject({
      resumeCommand: `cursor-agent --resume ${SESSION_DONE}`,
      source: { surface: 'cli', provider: 'cursor' },
    });
    expect(
      JSON.stringify(
        ctx.store.listObservations(
          canonicalKey('cursor', SESSION_DONE).key,
        ),
      ),
    ).not.toContain('SECRET');
  });

  it('clears a persisted pending decision when Cursor resumes', async () => {
    writeHeaders(databasePath, [
      {
        composerId: SESSION_BLOCKED,
        name: 'Resume after approval',
        lastUpdatedAt: clock,
        hasBlockingPendingActions: true,
      },
    ]);
    writeComposer(databasePath, SESSION_BLOCKED, {
      composerId: SESSION_BLOCKED,
      name: 'Resume after approval',
      createdAt: clock - 1_000,
      lastUpdatedAt: clock,
      status: 'none',
    });
    registry.register(connector());
    await registry.startAll();
    expect(
      ctx.store.getWorkItemByCanonicalKey(
        canonicalKey('cursor', SESSION_BLOCKED).key,
      )?.status,
    ).toBe('needs_victor');

    clock += 1_000;
    writeHeaders(databasePath, [
      {
        composerId: SESSION_BLOCKED,
        name: 'Resume after approval',
        lastUpdatedAt: clock,
        hasBlockingPendingActions: false,
      },
    ]);
    writeComposer(databasePath, SESSION_BLOCKED, {
      composerId: SESSION_BLOCKED,
      name: 'Resume after approval',
      createdAt: NOW - 1_000,
      lastUpdatedAt: clock,
      status: 'generating',
    });
    await registry.scanAllOnce();

    expect(
      ctx.store.getWorkItemByCanonicalKey(
        canonicalKey('cursor', SESSION_BLOCKED).key,
      )?.status,
    ).toBe('running');
    expect(
      ctx.store
        .listObservations(canonicalKey('cursor', SESSION_BLOCKED).key)
        .map((observation) => observation.signal),
    ).toContain('cursor.agent_resumed');
  });
});
