import { describe, expect, it } from 'vitest';
import type { CoverageHealth, WorkItem } from '@session-radar/shared';
import {
  actionGroup,
  absoluteTime,
  displayTitle,
  entryActions,
  humanTaskState,
  PROVIDER_LABELS,
  recommendedNextStep,
  relativeTime,
  sourceBadges,
  taskSummary,
  webExtensionReloadRequired,
} from './format.js';

describe('dashboard time formatting', () => {
  it('does not present missing source time as an ancient or current timestamp', () => {
    expect(relativeTime(0, 1_800_000_000_000)).toBe('time unknown');
    expect(absoluteTime(0)).toBe('Time unknown');
  });

  it('keeps ordinary relative formatting for valid timestamps', () => {
    expect(relativeTime(1_800_000_000_000 - 5 * 60_000, 1_800_000_000_000)).toBe(
      '5m ago',
    );
  });

  it('labels newly supported interface-owned providers without calling them OpenAI', () => {
    const item = {
      entryPoints: [
        {
          source: {
            id: 'cursor-desktop',
            provider: 'cursor',
            surface: 'desktop',
          },
        },
      ],
    } as WorkItem;
    expect(PROVIDER_LABELS.cursor).toBe('Cursor');
    expect(PROVIDER_LABELS.xai).toBe('xAI');
    expect(sourceBadges(item)).toEqual(['Cursor agent']);
  });

  it('recognises the old-extension state that needs a protected-page reload', () => {
    const connector = {
      connectorId: 'chatgpt-web',
      state: 'degraded',
      lastError:
        'the extension reported v0.0.1 with no history inventory — reload the updated unpacked extension, then refresh the open tabs',
    } as CoverageHealth;
    expect(webExtensionReloadRequired([connector])).toBe(true);
    expect(
      webExtensionReloadRequired([
        { ...connector, connectorId: 'chatgpt-desktop' },
      ]),
    ).toBe(false);
    expect(
      webExtensionReloadRequired([{ ...connector, state: 'ok', lastError: null }]),
    ).toBe(false);
  });
});

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi_1',
    canonicalKey: 'anthropic:sess-1',
    title: 'Current status',
    provider: 'anthropic',
    entryPoints: [
      {
        id: 'sr_1',
        workItemId: 'wi_1',
        source: {
          id: 'claude-code-cli',
          provider: 'anthropic',
          surface: 'cli',
          device: 'mac',
        },
        externalId: 'sess-1',
        resumeCommand: 'claude --resume sess-1',
        firstSeenAt: 1,
        lastSeenAt: 2,
        mergeBasis: 'canonical-id',
      },
    ],
    context: {
      cwd: '/Users/victor/OPK-Terminal-Native-Payment-Protocol',
      repo: 'OPK-Terminal-Native-Payment-Protocol',
    },
    status: 'running',
    statusSince: 1,
    lastActivityAt: 2,
    attention: 'unseen',
    createdAt: 1,
    updatedAt: 2,
    currentEvidence: {
      id: 'se_1',
      workItemId: 'wi_1',
      at: 2,
      signal: 'claude_code.post_tool_use',
      raw: { reason: 'tool use observed' },
      rule: 'running.live-activity',
      confidence: 'high',
      resultingStatus: 'running',
    },
    ...overrides,
  };
}

describe('human action cards', () => {
  it('maps evidence to the six human states without changing canonical status', () => {
    expect(humanTaskState(workItem())).toBe('Running');
    expect(
      humanTaskState(
        workItem({
          status: 'needs_victor',
          currentEvidence: {
            ...workItem().currentEvidence!,
            rule: 'needs_victor.blocking-signal',
            resultingStatus: 'needs_victor',
          },
        }),
      ),
    ).toBe('Waiting for you');
    expect(
      humanTaskState(
        workItem({
          status: 'stale',
          currentEvidence: {
            ...workItem().currentEvidence!,
            rule: 'stale.process-dead-no-completion',
            resultingStatus: 'stale',
          },
        }),
      ),
    ).toBe('Needs attention');
    expect(humanTaskState(workItem({ status: 'done' }))).toBe('Done—review needed');
    expect(
      humanTaskState(
        workItem({
          status: 'stale',
          currentEvidence: {
            ...workItem().currentEvidence!,
            rule: 'stale.inventory-only',
            confidence: 'low',
            resultingStatus: 'stale',
          },
        }),
      ),
    ).toBe('Status unknown');
    expect(humanTaskState(workItem({ status: 'stale' }))).toBe('Stale');
  });

  it('organises interrupted and blocked work ahead of running and review work', () => {
    expect(actionGroup(workItem({ status: 'needs_victor' }))).toBe('attention');
    expect(actionGroup(workItem())).toBe('running');
    expect(actionGroup(workItem({ status: 'done' }))).toBe('done_review');
    expect(actionGroup(workItem({ status: 'stale' }))).toBe('stale_unknown');
    expect(actionGroup(workItem({ status: 'done', attention: 'seen' }))).toBe(
      'acknowledged',
    );
  });

  it('uses only proven project context for the summary and keeps ids secondary', () => {
    expect(taskSummary(workItem())).toBe(
      'Project work in OPK-Terminal-Native-Payment-Protocol.',
    );
    expect(
      displayTitle(
        workItem({
          title: 'OPK-Terminal-Native-Payment-Protocol · 12ab34cd',
        }),
      ),
    ).toBe('Untitled task in OPK-Terminal-Native-Payment-Protocol');
    expect(taskSummary(workItem({ context: { conversationId: 'private-session-id' } }))).toBe(
      undefined,
    );
  });

  it('makes the return path and next action understandable without ids', () => {
    expect(entryActions(workItem())[0]).toMatchObject({
      kind: 'copy',
      label: 'Copy command to open',
    });
    expect(recommendedNextStep(workItem({ status: 'done' }))).toMatch(
      /review the result/i,
    );
    expect(
      entryActions(workItem({ entryPoints: [] }))[0]?.value,
    ).not.toContain('sess-1');
  });
});
