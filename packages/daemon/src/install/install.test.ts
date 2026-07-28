import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempHome } from '../testing.js';
import {
  HOOK_TIMEOUT_SECONDS,
  applyClaudeHooks,
  planClaudeHooks,
  removeClaudeHooks,
} from './claude-hooks.js';
import {
  applyCodexNotify,
  findNotifyLine,
  parseNotifyArray,
  planCodexNotify,
  removeCodexNotify,
  renderDispatcher,
} from './codex-notify.js';

const PORT = 4747;

/** Victor's real config shape: sounds on four events. */
const EXISTING_SETTINGS = {
  permissions: { allow: ['Bash(ls:*)'] },
  theme: 'dark',
  hooks: {
    SessionStart: [
      { matcher: 'startup', hooks: [{ type: 'command', command: 'afplay ~/.claude/hooks/sounds/ready.wav' }] },
    ],
    Notification: [
      { hooks: [{ type: 'command', command: 'afplay ~/.claude/hooks/sounds/what.mp3' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'afplay ~/.claude/hooks/sounds/jobsdone.mp3' }] }],
  },
};

describe('Claude Code hook installer', () => {
  let home: ReturnType<typeof createTempHome>;
  let claudeHome: string;
  let settingsPath: string;

  beforeEach(() => {
    home = createTempHome();
    claudeHome = join(home.home, 'dot-claude');
    mkdirSync(claudeHome, { recursive: true });
    process.env['SESSION_RADAR_CLAUDE_HOME'] = claudeHome;
    settingsPath = join(claudeHome, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(EXISTING_SETTINGS, null, 2));
  });

  afterEach(() => {
    delete process.env['SESSION_RADAR_CLAUDE_HOME'];
    home.restore();
  });

  it('plans to add every event it needs, and reports what it will preserve', () => {
    const plan = planClaudeHooks(PORT, settingsPath);
    expect(plan.entries.every((e) => e.action === 'add')).toBe(true);
    expect(plan.preservedEvents).toEqual(['Notification', 'SessionStart', 'Stop']);
    expect(plan.changed).toBe(true);
  });

  it('NEVER destroys existing hooks — the sounds keep playing', () => {
    applyClaudeHooks(PORT, settingsPath);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof EXISTING_SETTINGS;

    const stopCommands = after.hooks.Stop.flatMap((g) => g.hooks).map((h) => h.command);
    expect(stopCommands).toContain('afplay ~/.claude/hooks/sounds/jobsdone.mp3');

    const startCommands = after.hooks.SessionStart.flatMap((g) => g.hooks).map((h) => h.command);
    expect(startCommands).toContain('afplay ~/.claude/hooks/sounds/ready.wav');
    // The matcher on his group must survive untouched.
    expect(after.hooks.SessionStart[0]?.matcher).toBe('startup');
  });

  it('preserves unrelated settings keys', () => {
    applyClaudeHooks(PORT, settingsPath);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof EXISTING_SETTINGS;
    expect(after.theme).toBe('dark');
    expect(after.permissions.allow).toEqual(['Bash(ls:*)']);
  });

  it('adds http hooks with a short timeout so a dead daemon cannot wedge a session', () => {
    applyClaudeHooks(PORT, settingsPath);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, { hooks: { type: string; url?: string; timeout?: number }[] }[]>;
    };
    const ours = after.hooks.Stop?.flatMap((g) => g.hooks).find((h) => h.type === 'http');
    expect(ours?.url).toBe(`http://127.0.0.1:${PORT}/api/hooks/claude-code`);
    expect(ours?.timeout).toBe(HOOK_TIMEOUT_SECONDS);
    expect(HOOK_TIMEOUT_SECONDS).toBeLessThanOrEqual(10);
  });

  it('backs up before writing', () => {
    const result = applyClaudeHooks(PORT, settingsPath);
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath as string)).toBe(true);
    expect(JSON.parse(readFileSync(result.backupPath as string, 'utf8'))).toEqual(EXISTING_SETTINGS);
  });

  it('is idempotent — a second install adds nothing', () => {
    applyClaudeHooks(PORT, settingsPath);
    const second = applyClaudeHooks(PORT, settingsPath);
    expect(second.added).toEqual([]);
    expect(planClaudeHooks(PORT, settingsPath).changed).toBe(false);
  });

  it('uninstall removes only our entries and leaves his intact', () => {
    applyClaudeHooks(PORT, settingsPath);
    removeClaudeHooks(settingsPath);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof EXISTING_SETTINGS;

    expect(JSON.stringify(after.hooks)).not.toContain('/api/hooks/');
    expect(JSON.stringify(after.hooks)).toContain('jobsdone.mp3');
    expect(after.hooks.SessionStart[0]?.matcher).toBe('startup');
  });

  it('handles a machine with no settings file at all', () => {
    const fresh = join(claudeHome, 'nope.json');
    const plan = planClaudeHooks(PORT, fresh);
    expect(plan.settingsExists).toBe(false);
    applyClaudeHooks(PORT, fresh);
    const written = JSON.parse(readFileSync(fresh, 'utf8')) as { hooks: Record<string, unknown> };
    expect(Object.keys(written.hooks)).toContain('Stop');
  });
});

describe('Codex notify installer', () => {
  let home: ReturnType<typeof createTempHome>;
  let codexHome: string;
  let configPath: string;

  /** Victor's real config: a notify already wired to Codex Computer Use. */
  const EXISTING_NOTIFY =
    'notify = ["/Users/victorzhang/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/Client", "turn-ended"]';
  const EXISTING_CONFIG = [
    'model = "gpt-5.6-sol"',
    'approval_policy = "never"',
    '',
    EXISTING_NOTIFY,
    '',
    '[plugins."vercel-plugin@plugins-cli"]',
    'enabled = true',
    '',
  ].join('\n');

  beforeEach(() => {
    home = createTempHome();
    codexHome = join(home.home, 'dot-codex');
    mkdirSync(codexHome, { recursive: true });
    process.env['SESSION_RADAR_CODEX_HOME'] = codexHome;
    configPath = join(codexHome, 'config.toml');
    writeFileSync(configPath, EXISTING_CONFIG);
  });

  afterEach(() => {
    delete process.env['SESSION_RADAR_CODEX_HOME'];
    home.restore();
  });

  it('detects an existing notify program and plans to WRAP, not replace', () => {
    const plan = planCodexNotify(PORT, configPath);
    expect(plan.kind).toBe('wrap');
    expect(plan.existingArgv?.[0]).toContain('Codex Computer Use.app');
    expect(plan.existingArgv?.[1]).toBe('turn-ended');
  });

  it('the dispatcher runs the original program FIRST, with its arguments intact', () => {
    const script = renderDispatcher(
      ['/Applications/Codex Computer Use.app/Contents/MacOS/Client', 'turn-ended'],
      PORT,
    );
    // Quoted so the space in the .app path survives.
    expect(script).toContain(`'/Applications/Codex Computer Use.app/Contents/MacOS/Client'`);
    expect(script).toContain(`'turn-ended' "$@"`);
    // The original command line executes before the curl that reports to us.
    expect(script.indexOf('Codex Computer Use')).toBeLessThan(script.indexOf('curl'));
    // And its exit code is what the dispatcher returns.
    expect(script).toContain('ORIGINAL_STATUS=$?');
    expect(script.trimEnd().endsWith('exit "$ORIGINAL_STATUS"')).toBe(true);
  });

  it('reports to session-radar in the background with a hard timeout', () => {
    const script = renderDispatcher(['/bin/true'], PORT);
    expect(script).toContain('--max-time 2');
    expect(script).toContain(`http://127.0.0.1:${PORT}/api/hooks/codex`);
    // Trailing & — a stopped daemon must never delay the real notifier.
    expect(script).toMatch(/api\/hooks\/codex >\/dev\/null 2>&1 &/);
  });

  it('applying rewrites only the notify line and preserves the rest byte-for-byte', () => {
    const result = applyCodexNotify(PORT, configPath);
    expect(result.applied).toBe(true);
    const after = readFileSync(configPath, 'utf8');
    expect(after).toContain('model = "gpt-5.6-sol"');
    expect(after).toContain('[plugins."vercel-plugin@plugins-cli"]');
    expect(after).not.toContain('Codex Computer Use.app/Contents/MacOS/Client", "turn-ended"');
    expect(after).toContain('codex-notify-dispatch.sh');
    expect(existsSync(result.dispatcherPath as string)).toBe(true);
  });

  it('backs up the config before touching it', () => {
    const result = applyCodexNotify(PORT, configPath);
    expect(existsSync(result.backupPath as string)).toBe(true);
    expect(readFileSync(result.backupPath as string, 'utf8')).toBe(EXISTING_CONFIG);
  });

  it('uninstall restores the original notify line verbatim', () => {
    applyCodexNotify(PORT, configPath);
    const removed = removeCodexNotify(configPath);
    expect(removed.restored).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toContain(EXISTING_NOTIFY);
  });

  it('REFUSES to touch a notify it cannot safely rewrite', () => {
    writeFileSync(configPath, 'notify = { program = "x" }\n');
    const plan = planCodexNotify(PORT, configPath);
    expect(plan.kind).toBe('manual');
    expect(plan.reason).toMatch(/corrupt/);
    const result = applyCodexNotify(PORT, configPath);
    expect(result.applied).toBe(false);
    // The file is untouched.
    expect(readFileSync(configPath, 'utf8')).toBe('notify = { program = "x" }\n');
  });

  it('refuses a notify nested inside a table rather than hijacking it', () => {
    writeFileSync(configPath, '[some.table]\nnotify = ["x"]\n');
    expect(planCodexNotify(PORT, configPath).kind).toBe('manual');
  });

  it('adds a notify cleanly when there is none, above any table header', () => {
    writeFileSync(configPath, 'model = "x"\n\n[plugins."p"]\nenabled = true\n');
    expect(planCodexNotify(PORT, configPath).kind).toBe('add');
    applyCodexNotify(PORT, configPath);
    const after = readFileSync(configPath, 'utf8');
    expect(after.indexOf('notify =')).toBeLessThan(after.indexOf('[plugins.'));
  });

  it('is idempotent', () => {
    applyCodexNotify(PORT, configPath);
    expect(planCodexNotify(PORT, configPath).kind).toBe('already-installed');
    expect(applyCodexNotify(PORT, configPath).applied).toBe(false);
  });
});

describe('TOML line helpers', () => {
  it('finds a top-level notify and knows when it is inside a table', () => {
    expect(findNotifyLine('a = 1\nnotify = ["x"]\n')?.inTopLevel).toBe(true);
    expect(findNotifyLine('[t]\nnotify = ["x"]\n')?.inTopLevel).toBe(false);
    expect(findNotifyLine('a = 1\n')).toBeUndefined();
  });

  it('parses only the simple array form', () => {
    expect(parseNotifyArray('notify = ["a", "b"]')).toEqual(['a', 'b']);
    expect(parseNotifyArray('notify = []')).toEqual([]);
    expect(parseNotifyArray('notify = { p = 1 }')).toBeUndefined();
    expect(parseNotifyArray('notify = [1, 2]')).toBeUndefined();
  });
});
