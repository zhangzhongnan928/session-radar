import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Provider,
  Source,
  Status,
  Surface,
  TaskAnalysisField,
  WorkItem,
} from '@session-radar/shared';
import { LocalTaskAnalysisService } from './service.js';

const CODEX_SESSION = '019fa7ae-3778-7671-ba66-b2fd928d7156';
const CLAUDE_SESSION = '4fd396ed-5473-4d2d-b60f-38c096b1337a';
const REQUESTED: TaskAnalysisField[] = [
  'final_conclusion',
  'unresolved_items',
  'code_change_summary',
];

describe('LocalTaskAnalysisService', () => {
  let root: string;
  let codexDir: string;
  let claudeDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'session-radar-analysis-'));
    codexDir = join(root, 'codex-sessions');
    claudeDir = join(root, 'claude-projects');
    mkdirSync(join(codexDir, '2026', '07', '31'), { recursive: true });
    mkdirSync(join(claudeDir, '-Users-victor-code-radar'), { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('projects one exact Codex final_answer without returning user, tool, or commentary text', async () => {
    const path = join(
      codexDir,
      '2026',
      '07',
      '31',
      `rollout-2026-07-31T10-00-00-${CODEX_SESSION}.jsonl`,
    );
    writeJsonl(path, [
      {
        timestamp: '2026-07-31T00:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: `SECRET USER PROMPT ${'private '.repeat(2_000)}`,
        },
      },
      {
        timestamp: '2026-07-31T00:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          output: 'SECRET TOOL OUTPUT',
        },
      },
      {
        timestamp: '2026-07-31T00:02:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'SECRET COMMENTARY' }],
        },
      },
      {
        timestamp: '2026-07-31T00:03:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [
            {
              type: 'output_text',
              text: [
                'Implemented exact-session analysis with bounded source reads.',
                '',
                '## Verification',
                '- 12/12 focused tests passed.',
                '- Health endpoint returned HTTP 200.',
                '',
                '## Unresolved items',
                '- None.',
                '',
                '## Risks',
                '- Claude chat sessions without a Code transcript remain unavailable.',
                '',
                '## Code changes',
                '- Added Codex and Claude Code result adapters.',
                '- Added provenance to the analysis response.',
                '',
                '## Next step',
                '- Review the generated task card.',
              ].join('\n'),
            },
          ],
        },
      },
      {
        timestamp: '2026-07-31T00:03:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete' },
      },
    ]);

    const service = new LocalTaskAnalysisService({
      codexDir,
      claudeDir,
      now: () => 1_800_000_000_000,
    });
    const response = await service.analyze(
      workItem('openai', 'codex-desktop', CODEX_SESSION, 'desktop'),
      REQUESTED,
    );

    expect(response.status).toBe('complete');
    expect(response.result).toMatchObject({
      outcome: 'Implemented exact-session analysis with bounded source reads.',
      verifiedResults: [
        '12/12 focused tests passed.',
        'Health endpoint returned HTTP 200.',
      ],
      unresolvedItems: [],
      risksOrBlockers: [
        'Claude chat sessions without a Code transcript remain unavailable.',
      ],
      recommendedNextStep: 'Review the generated task card.',
    });
    expect(response.result?.codeChangeSummary).toMatch(/Added Codex and Claude Code/);
    expect(response.provenance).toMatchObject({
      adapter: 'codex-rollout-final-result-v1',
      source: 'Codex Desktop rollout',
      matchedBy: 'exact_session_id',
      sourceRecordAt: Date.parse('2026-07-31T00:03:00.000Z'),
    });
    expect(response.provenance.sourceBytesRead).toBeLessThan(
      response.provenance.sourceSizeBytes ?? 0,
    );
    expect(response.privacy).toEqual({
      fullConversationRead: false,
      fullConversationStored: false,
      rawConversationStored: false,
    });
    expect(JSON.stringify(response)).not.toMatch(
      /SECRET USER PROMPT|SECRET TOOL OUTPUT|SECRET COMMENTARY/,
    );
  });

  it('supports a Claude Code Desktop card through its exact joined CLI transcript', async () => {
    const path = join(
      claudeDir,
      '-Users-victor-code-radar',
      `${CLAUDE_SESSION}.jsonl`,
    );
    writeJsonl(path, [
      {
        type: 'user',
        timestamp: '2026-07-31T01:00:00.000Z',
        message: { role: 'user', content: 'SECRET CLAUDE USER TURN' },
      },
      {
        type: 'assistant',
        isSidechain: true,
        timestamp: '2026-07-31T01:01:00.000Z',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'SECRET SUBAGENT RESULT' }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-07-31T01:02:00.000Z',
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'text', text: 'SECRET INTERMEDIATE TEXT' }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-07-31T01:03:00.000Z',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: [
                '## Outcome',
                'The payment review is complete.',
                '## Verification',
                '- Contract tests passed.',
                '## Unresolved',
                '- Confirm the production rollout window.',
                '## Risks',
                '- Deployment approval is still pending.',
                '## Changes',
                '- Updated payment validation.',
                '## Next step',
                '- Schedule the approved production window.',
              ].join('\n'),
            },
          ],
        },
      },
    ]);

    const item = workItem(
      'anthropic',
      'claude-code-desktop',
      'local-desktop-session',
      'desktop',
      'running',
      `anthropic:id:${CLAUDE_SESSION}`,
    );
    const response = await new LocalTaskAnalysisService({
      codexDir,
      claudeDir,
    }).analyze(item, REQUESTED);

    expect(response.status).toBe('complete');
    expect(response.result?.outcome).toBe('The payment review is complete.');
    expect(response.result?.unresolvedItems).toEqual([
      'Confirm the production rollout window.',
    ]);
    expect(response.result?.recommendedNextStep).toBe(
      'Schedule the approved production window.',
    );
    expect(response.provenance.source).toBe('Claude Code Desktop/CLI transcript');
    expect(response.uncertainties).toContain(
      'This task is not currently lifecycle-confirmed as done; the result reflects its latest completed source turn.',
    );
    expect(JSON.stringify(response)).not.toMatch(
      /SECRET CLAUDE USER TURN|SECRET SUBAGENT RESULT|SECRET INTERMEDIATE TEXT/,
    );
  });

  it('stays unavailable for ordinary Claude chat and explains the unsupported boundary', async () => {
    const response = await new LocalTaskAnalysisService({
      codexDir,
      claudeDir,
    }).analyze(
      workItem('anthropic', 'claude-desktop', 'conversation-123', 'desktop'),
      REQUESTED,
    );

    expect(response.status).toBe('unavailable');
    expect(response.provenance).toMatchObject({
      adapter: 'unsupported-source',
      source: 'Claude Desktop chat',
      matchedBy: 'not_matched',
      sourceBytesRead: 0,
    });
    expect(response.message).toMatch(/does not expose a supported/i);
  });

  it('does not follow an exact-looking transcript symlink', async () => {
    const outside = join(root, 'outside.jsonl');
    writeJsonl(outside, [
      {
        timestamp: '2026-07-31T00:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'SECRET OUTSIDE ROOT' }],
        },
      },
    ]);
    symlinkSync(
      outside,
      join(
        codexDir,
        '2026',
        '07',
        '31',
        `rollout-2026-07-31T10-00-00-${CODEX_SESSION}.jsonl`,
      ),
    );

    const response = await new LocalTaskAnalysisService({
      codexDir,
      claudeDir,
    }).analyze(
      workItem('openai', 'codex-cli', CODEX_SESSION, 'cli'),
      REQUESTED,
    );

    expect(response.status).toBe('unavailable');
    expect(response.provenance.sourceBytesRead).toBe(0);
    expect(JSON.stringify(response)).not.toContain('SECRET OUTSIDE ROOT');
  });

  it('does not widen beyond the configured tail when no terminal result is nearby', async () => {
    const path = join(
      claudeDir,
      '-Users-victor-code-radar',
      `${CLAUDE_SESSION}.jsonl`,
    );
    writeJsonl(path, [
      {
        type: 'assistant',
        timestamp: '2026-07-31T01:00:00.000Z',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'OLD SECRET RESULT' }],
        },
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        type: 'attachment',
        timestamp: `2026-07-31T01:01:${String(index).padStart(2, '0')}.000Z`,
        padding: 'x'.repeat(100),
      })),
    ]);

    const response = await new LocalTaskAnalysisService({
      codexDir,
      claudeDir,
      maxTailBytes: 256,
    }).analyze(
      workItem('anthropic', 'claude-code-cli', CLAUDE_SESSION, 'cli'),
      REQUESTED,
    );

    expect(response.status).toBe('unavailable');
    expect(response.message).toMatch(/not widened/i);
    expect(response.provenance.sourceBytesRead).toBe(256);
    expect(JSON.stringify(response)).not.toContain('OLD SECRET RESULT');
  });
});

function workItem(
  provider: Provider,
  sourceId: string,
  externalId: string,
  surface: Surface,
  status: Status = 'done',
  canonicalKey = `${provider}:id:${externalId}`,
): WorkItem {
  const at = 1_800_000_000_000;
  const source: Source = {
    id: sourceId,
    provider,
    surface,
    device: 'test-mac',
  };
  return {
    id: `wi-${externalId}`,
    canonicalKey,
    title: 'Test task',
    provider,
    entryPoints: [
      {
        id: `sr-${externalId}`,
        workItemId: `wi-${externalId}`,
        source,
        externalId,
        firstSeenAt: at,
        lastSeenAt: at,
        mergeBasis: 'canonical-id',
      },
    ],
    context: {},
    status,
    statusSince: at,
    lastActivityAt: at,
    attention: 'unseen',
    createdAt: at,
    updatedAt: at,
  };
}

function writeJsonl(path: string, records: readonly unknown[]): void {
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}
