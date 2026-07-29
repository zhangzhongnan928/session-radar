import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempHome } from '../testing.js';
import {
  LAUNCH_AGENT_LABEL,
  applyLaunchAgent,
  planLaunchAgent,
  removeLaunchAgent,
  renderLaunchAgent,
} from './launch-agent.js';
import type {
  LaunchAgentOptions,
  LaunchCommandRunner,
} from './launch-agent.js';

describe('macOS LaunchAgent installer', () => {
  let temp: ReturnType<typeof createTempHome>;
  let options: LaunchAgentOptions;
  let calls: { command: string; args: readonly string[] }[];

  beforeEach(() => {
    temp = createTempHome();
    const bin = join(temp.home, 'bin');
    const dist = join(temp.home, 'project', 'packages', 'daemon', 'dist');
    mkdirSync(bin, { recursive: true });
    mkdirSync(dist, { recursive: true });
    const nodePath = join(bin, 'node');
    const daemonPath = join(dist, 'index.js');
    writeFileSync(nodePath, '');
    writeFileSync(daemonPath, '');

    calls = [];
    const run: LaunchCommandRunner = (command, args) => {
      calls.push({ command, args });
      return { status: 0, stderr: '' };
    };
    options = {
      plistPath: join(temp.home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`),
      nodePath,
      daemonPath,
      workingDirectory: join(temp.home, 'project'),
      radarHome: temp.home,
      uid: 501,
      run,
    };
  });

  afterEach(() => temp.restore());

  it('renders absolute paths safely, including spaces and XML characters', () => {
    const plan = planLaunchAgent({
      ...options,
      nodePath: '/A & B/node',
      daemonPath: '/Project With Spaces/<daemon>.js',
    });
    const plist = renderLaunchAgent(plan);
    expect(plist).toContain('/A &amp; B/node');
    expect(plist).toContain('/Project With Spaces/&lt;daemon&gt;.js');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('<key>Umask</key><integer>63</integer>');
  });

  it('writes owner-only config and loads the service with explicit launchctl arguments', () => {
    expect(planLaunchAgent(options).action).toBe('add');
    const result = applyLaunchAgent(options);
    expect(result.service).toBe(`gui/501/${LAUNCH_AGENT_LABEL}`);
    expect(planLaunchAgent(options).action).toBe('already-installed');
    expect(statSync(result.plan.plistPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(result.plan.plistPath, 'utf8')).toContain(result.plan.daemonPath);
    expect(calls.map((call) => call.args[0])).toEqual(['bootout', 'bootstrap', 'kickstart']);
    expect(calls[1]?.args).toEqual(['bootstrap', 'gui/501', result.plan.plistPath]);
  });

  it('backs up an existing plist before updating it', () => {
    mkdirSync(join(temp.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(options.plistPath!, 'old plist');
    expect(planLaunchAgent(options).action).toBe('update');
    const result = applyLaunchAgent(options);
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(readFileSync(result.backupPath!, 'utf8')).toBe('old plist');
  });

  it('unloads only this service and keeps a recoverable backup on removal', () => {
    applyLaunchAgent(options);
    calls.length = 0;
    const removed = removeLaunchAgent(options);
    expect(removed.removed).toBe(true);
    expect(removed.backupPath).toBeDefined();
    expect(existsSync(removed.backupPath!)).toBe(true);
    expect(existsSync(options.plistPath!)).toBe(false);
    expect(calls[0]?.args).toEqual(['bootout', 'gui/501', options.plistPath!]);
  });
});
