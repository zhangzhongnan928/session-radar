import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalKey } from '@session-radar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StatusEngine } from '../../engine.js';
import { createNullLogger } from '../../logger.js';
import { ConnectorRegistry } from '../../registry.js';
import type { TempStore } from '../../testing.js';
import { createTempStore } from '../../testing.js';
import { ChatGptAtlasConnector } from './chatgpt-atlas.js';
import { ClineConnector } from './cline.js';
import { AugmentConnector } from './augment.js';
import { VsCodeCopilotConnector } from './vscode.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;
const ATLAS_SESSION = '690b5d32-4704-8330-a6b0-08877516c368';
const VSCODE_SESSION = '4ee70e54-483e-41ba-b8e7-7452f8f97870';
const CLINE_TASK = '1799990000000';

describe('additional installed-interface inventories', () => {
  let ctx: TempStore;
  let registry: ConnectorRegistry;

  beforeEach(() => {
    ctx = createTempStore();
    registry = new ConnectorRegistry(ctx.store, ctx.bus, createNullLogger(), {
      defaultScanIntervalMs: 3_600_000,
      backoffStartMs: 3_600_000,
    });
  });
  afterEach(async () => {
    await registry.stopAll();
    ctx.close();
  });

  it('indexes Atlas filenames without opening .data conversation bodies', async () => {
    const supportDir = join(ctx.home, 'com.openai.atlas');
    const accountDir = join(
      supportDir,
      'conversations-v3-cadc8726-9c46-4f40-a498-06ef750cd66d',
    );
    const appPath = join(ctx.home, 'ChatGPT Atlas.app');
    mkdirSync(accountDir, { recursive: true });
    mkdirSync(appPath, { recursive: true });
    const file = join(accountDir, `${ATLAS_SESSION}.data`);
    writeFileSync(file, Buffer.from('SECRET ATLAS BODY MUST NEVER ESCAPE'));
    utimesSync(file, new Date(NOW - DAY), new Date(NOW - DAY));

    registry.register(
      new ChatGptAtlasConnector({
        engine: new StatusEngine(ctx.store, () => NOW),
        supportDir,
        appPath,
        now: () => NOW,
        device: 'test-mac',
      }),
    );
    await registry.startAll();

    const key = canonicalKey('openai', ATLAS_SESSION).key;
    expect(ctx.store.getWorkItemByCanonicalKey(key)).toMatchObject({
      provider: 'openai',
      status: 'stale',
      title: 'ChatGPT Atlas · 7516c368',
    });
    expect(ctx.store.getWorkItemByCanonicalKey(key)?.entryPoints[0]?.locateHint).toContain(
      'ChatGPT Atlas → conversation history',
    );
    expect(JSON.stringify(ctx.store.listObservations(key))).not.toContain('SECRET');
  });

  it('indexes VS Code chat filenames and a separately allowlisted workspace path', async () => {
    const storageRoot = join(ctx.home, 'workspaceStorage');
    const workspaceId = '5a53f31231b13d5ac567c22571174532';
    const workspaceDir = join(storageRoot, workspaceId);
    const chatDir = join(workspaceDir, 'chatSessions');
    const appPath = join(ctx.home, 'Visual Studio Code.app');
    const repoPath = join(ctx.home, 'code', 'radar');
    mkdirSync(chatDir, { recursive: true });
    mkdirSync(appPath, { recursive: true });
    writeFileSync(
      join(workspaceDir, 'workspace.json'),
      JSON.stringify({ folder: pathToFileURL(repoPath).href }),
    );
    const file = join(chatDir, `${VSCODE_SESSION}.json`);
    writeFileSync(file, '{"requests":[{"message":"SECRET COPILOT CHAT BODY"}]}');
    utimesSync(file, new Date(NOW - 2 * DAY), new Date(NOW - 2 * DAY));

    registry.register(
      new VsCodeCopilotConnector({
        engine: new StatusEngine(ctx.store, () => NOW),
        workspaceStorageDir: storageRoot,
        appPath,
        now: () => NOW,
        device: 'test-mac',
      }),
    );
    await registry.startAll();

    const key = canonicalKey('github', VSCODE_SESSION).key;
    expect(ctx.store.getWorkItemByCanonicalKey(key)).toMatchObject({
      provider: 'github',
      status: 'stale',
      title: 'radar · f8f97870',
      context: { cwd: repoPath, repo: 'radar' },
    });
    expect(ctx.store.getWorkItemByCanonicalKey(key)?.entryPoints[0]?.locateHint).toContain(
      'Visual Studio Code → Chat history',
    );
    expect(JSON.stringify(ctx.store.listObservations(key))).not.toContain('SECRET');
  });

  it('indexes Cline task directories without opening conversation JSON', async () => {
    const extensionRoot = join(ctx.home, '.vscode', 'extensions');
    const tasksDir = join(ctx.home, 'cline', 'tasks');
    const taskDir = join(tasksDir, CLINE_TASK);
    const appPath = join(ctx.home, 'Visual Studio Code.app');
    mkdirSync(
      join(extensionRoot, 'saoudrizwan.claude-dev-3.62.0'),
      { recursive: true },
    );
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(appPath, { recursive: true });
    const apiHistory = join(taskDir, 'api_conversation_history.json');
    const uiMessages = join(taskDir, 'ui_messages.json');
    writeFileSync(apiHistory, '{"prompt":"SECRET CLINE PROMPT"}');
    writeFileSync(uiMessages, '{"reply":"SECRET CLINE REPLY"}');
    utimesSync(apiHistory, new Date(NOW - DAY), new Date(NOW - DAY));
    utimesSync(uiMessages, new Date(NOW - DAY), new Date(NOW - DAY));

    registry.register(
      new ClineConnector({
        engine: new StatusEngine(ctx.store, () => NOW),
        extensionRoot,
        tasksDir,
        appPath,
        now: () => NOW,
        device: 'test-mac',
      }),
    );
    await registry.startAll();

    const key = canonicalKey('cline', CLINE_TASK).key;
    const item = ctx.store.getWorkItemByCanonicalKey(key);
    expect(item).toMatchObject({
      provider: 'cline',
      status: 'stale',
      context: { conversationId: CLINE_TASK },
    });
    expect(item?.entryPoints[0]?.locateHint).toContain(
      'Visual Studio Code → Cline → History',
    );
    expect(ctx.store.getCoverage('cline-vscode')).toMatchObject({
      state: 'degraded',
      observedSessionCount: 1,
    });
    expect(JSON.stringify(ctx.store.listObservations(key))).not.toContain(
      'SECRET',
    );
  });

  it('makes Augment a visible unsupported surface instead of silent omission', async () => {
    const extensionRoot = join(ctx.home, '.vscode', 'extensions');
    mkdirSync(
      join(extensionRoot, 'augment.vscode-augment-0.754.3'),
      { recursive: true },
    );
    registry.register(
      new AugmentConnector({
        extensionRoot,
        retainedStorageDir: join(ctx.home, 'augment-state'),
      }),
    );
    await registry.startAll();

    expect(ctx.store.getCoverage('augment-vscode')).toMatchObject({
      state: 'unsupported',
      provider: 'augment',
    });
    expect(ctx.store.getCoverage('augment-vscode')?.lastError).toMatch(
      /SecretStorage.*augment\.sessions/i,
    );
  });
});
