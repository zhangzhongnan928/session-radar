import { describe, expect, it } from 'vitest';
import {
  coverageHealthSchema,
  providerSchema,
  statusEvidenceSchema,
  statusSchema,
  workItemSchema,
} from './model.js';
import { rollupCoverage } from './api.js';

const source = {
  id: 'claude-code-cli',
  provider: 'anthropic' as const,
  surface: 'cli' as const,
  device: 'victors-mac',
};

const evidence = {
  id: 'ev_1',
  workItemId: 'wi_1',
  at: 1_800_000_000_000,
  signal: 'claude_code.stop',
  raw: { hook: 'Stop' },
  rule: 'done.source-confirmed',
  confidence: 'high' as const,
  resultingStatus: 'done' as const,
};

const workItem = {
  id: 'wi_1',
  canonicalKey: 'anthropic:id:sess-123',
  title: 'Refactor the billing module',
  provider: 'anthropic' as const,
  entryPoints: [
    {
      id: 'sr_1',
      workItemId: 'wi_1',
      source,
      externalId: 'sess-123',
      resumeCommand: 'claude --resume sess-123',
      firstSeenAt: 1_799_999_000_000,
      lastSeenAt: 1_800_000_000_000,
      mergeBasis: 'canonical-id' as const,
    },
  ],
  context: { cwd: '/Users/victor/code/billing', repo: 'billing' },
  status: 'done' as const,
  statusSince: 1_800_000_000_000,
  lastActivityAt: 1_800_000_000_000,
  attention: 'unseen' as const,
  createdAt: 1_799_999_000_000,
  updatedAt: 1_800_000_000_000,
  currentEvidence: evidence,
};

describe('event model schemas', () => {
  it('accepts a fully populated work item', () => {
    expect(() => workItemSchema.parse(workItem)).not.toThrow();
  });

  it('has exactly four canonical statuses', () => {
    expect(statusSchema.options).toEqual(['running', 'needs_victor', 'done', 'stale']);
  });

  it('keeps interface-owned session ids in separate provider namespaces', () => {
    expect(providerSchema.options).toEqual([
      'openai',
      'anthropic',
      'xai',
      'cursor',
      'windsurf',
      'google',
      'github',
      'cline',
      'augment',
    ]);
  });

  it('rejects a fifth status masquerading as attention', () => {
    expect(statusSchema.safeParse('unseen').success).toBe(false);
  });

  it('rejects a work item whose timestamps are not epoch milliseconds', () => {
    const bad = { ...workItem, lastActivityAt: '2026-07-28T00:00:00Z' };
    expect(workItemSchema.safeParse(bad).success).toBe(false);
  });

  it('requires evidence to name both a signal and a rule', () => {
    expect(statusEvidenceSchema.safeParse({ ...evidence, rule: '' }).success).toBe(false);
    expect(statusEvidenceSchema.safeParse({ ...evidence, signal: '' }).success).toBe(false);
  });

  it('allows coverage health with no successful scan yet', () => {
    const parsed = coverageHealthSchema.parse({
      connectorId: 'claude-code-cli',
      displayName: 'Claude Code CLI',
      state: 'down',
      lastSuccessfulScanAt: null,
      permissionState: 'unknown',
      lastError: 'connector registered but has not completed a scan yet',
      observedSessionCount: 0,
      archivedSessionCount: 0,
      consecutiveFailures: 0,
      updatedAt: 1_800_000_000_000,
    });
    expect(parsed.state).toBe('down');
  });
});

describe('rollupCoverage', () => {
  it('reports no_connectors rather than pretending zero connectors is healthy', () => {
    expect(rollupCoverage([])).toBe('no_connectors');
  });

  it('lets a single down connector dominate', () => {
    expect(rollupCoverage([{ state: 'ok' }, { state: 'degraded' }, { state: 'down' }])).toBe('down');
  });

  it('reports degraded when nothing is down', () => {
    expect(rollupCoverage([{ state: 'ok' }, { state: 'degraded' }])).toBe('degraded');
  });

  it('treats unsupported as a known gap, not an incident', () => {
    expect(rollupCoverage([{ state: 'ok' }, { state: 'unsupported' }])).toBe('ok');
  });

  it('reports ok only when everything is ok', () => {
    expect(rollupCoverage([{ state: 'ok' }, { state: 'ok' }])).toBe('ok');
  });
});
