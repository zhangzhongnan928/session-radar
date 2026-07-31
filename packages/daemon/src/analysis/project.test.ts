import { describe, expect, it } from 'vitest';
import { projectSourceResult } from './project.js';

describe('projectSourceResult', () => {
  it('turns a verification table into readable rows without treating its header as a result', () => {
    const projection = projectSourceResult(
      [
        'Done. Deployment records are current.',
        '## Verification',
        '| # | Contract | Status |',
        '| --- | --- | --- |',
        '| 1 | SessionReceiver | verified |',
        '| 2 | OPKBeacon | blocked |',
        '## Unresolved items',
        '- None.',
      ].join('\n'),
      'done',
      ['final_conclusion', 'unresolved_items'],
    );

    expect(projection.result.verifiedResults).toEqual([
      '1 — SessionReceiver — verified',
      '2 — OPKBeacon — blocked',
    ]);
    expect(projection.result.unresolvedItems).toEqual([]);
  });

  it('keeps unstated sections unknown and labels a lifecycle-derived next step', () => {
    const projection = projectSourceResult(
      'Implemented the requested change.',
      'running',
      ['final_conclusion', 'unresolved_items', 'code_change_summary'],
    );

    expect(projection.result.outcome).toBe('Implemented the requested change.');
    expect(projection.result.unresolvedItems).toBeNull();
    expect(projection.result.risksOrBlockers).toBeNull();
    expect(projection.result.recommendedNextStep).toMatch(/refresh this analysis/i);
    expect(projection.recommendedNextStepInferred).toBe(true);
    expect(projection.uncertainties).toContain(
      'The selected source result did not explicitly say whether unresolved items remain.',
    );
  });

  it('redacts credential-shaped strings even when a source result contains one', () => {
    const projection = projectSourceResult(
      'Outcome: rotated sk-exampletoken1234567890 safely.',
      'done',
      ['final_conclusion'],
    );

    expect(projection.result.outcome).toBe('Outcome: rotated [redacted token] safely.');
  });
});
