import { describe, expect, it } from 'vitest';
import { DEFAULT_STALE_THRESHOLDS } from './config.js';
import type { Observation } from './status.js';
import { decideStatus } from './status.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function at(minutesAgo: number): number {
  return NOW - minutesAgo * MIN;
}

function decide(observations: Observation[], surface: 'cli' | 'web' = 'cli') {
  return decideStatus({ observations, surface, now: NOW });
}

describe('decideStatus — empty', () => {
  it('never invents a status when nothing was observed', () => {
    const d = decide([]);
    expect(d.status).toBe('stale');
    expect(d.rule).toBe('stale.no-evidence');
    expect(d.confidence).toBe('low');
    expect(d.basisSignal).toBe('none');
    expect(d.basisAt).toBeNull();
  });
});

describe('decideStatus — needs_victor has absolute priority', () => {
  it('flips on a blocking signal', () => {
    const d = decide([{ signal: 'claude_code.notification.permission_prompt', at: at(1) }]);
    expect(d.status).toBe('needs_victor');
    expect(d.rule).toBe('needs_victor.blocking-signal');
    expect(d.confidence).toBe('high');
  });

  it('stays needs_victor even while activity continues afterwards', () => {
    const d = decide([
      { signal: 'claude_code.notification.permission_prompt', at: at(5) },
      { signal: 'claude_code.post_tool_use', at: at(1) },
      { signal: 'claude_code.transcript_write', at: at(0) },
    ]);
    expect(d.status).toBe('needs_victor');
  });

  it('stays needs_victor indefinitely — an old unanswered prompt still needs him', () => {
    const d = decide([{ signal: 'claude_code.notification.permission_prompt', at: at(600) }]);
    expect(d.status).toBe('needs_victor');
    expect(d.reason).toContain('600 min ago');
  });

  it('keeps the block when a completion lands on the same millisecond', () => {
    const t = at(3);
    const d = decide([
      { signal: 'claude_code.stop', at: t },
      { signal: 'claude_code.notification.permission_prompt', at: t },
    ]);
    expect(d.status).toBe('needs_victor');
  });

  it('clears on a strictly newer completion', () => {
    const d = decide([
      { signal: 'claude_code.notification.permission_prompt', at: at(3) },
      { signal: 'claude_code.stop', at: at(2) },
    ]);
    expect(d.status).toBe('done');
  });

  it('clears on process death, and the item becomes stale rather than blocked', () => {
    const d = decide([
      { signal: 'claude_code.notification.permission_prompt', at: at(30) },
      { signal: 'claude_code.process_dead', at: at(20) },
    ]);
    expect(d.status).toBe('stale');
    expect(d.rule).toBe('stale.process-dead-no-completion');
  });

  it('treats a web approval dialog as blocking too', () => {
    const d = decide([{ signal: 'web.blocked', at: at(2) }], 'web');
    expect(d.status).toBe('needs_victor');
    expect(d.confidence).toBe('med');
  });
});

describe('decideStatus — done', () => {
  it('is source-confirmed by the Stop hook', () => {
    const d = decide([
      { signal: 'claude_code.post_tool_use', at: at(4) },
      { signal: 'claude_code.stop', at: at(2) },
    ]);
    expect(d.status).toBe('done');
    expect(d.rule).toBe('done.source-confirmed');
    expect(d.confidence).toBe('high');
  });

  it('reverts to running when a new turn starts after completion', () => {
    const d = decide([
      { signal: 'claude_code.stop', at: at(9) },
      { signal: 'claude_code.post_tool_use', at: at(1) },
    ]);
    expect(d.status).toBe('running');
  });

  it('stays done forever without new activity — completion does not age out', () => {
    const d = decide([{ signal: 'claude_code.stop', at: at(5000) }]);
    expect(d.status).toBe('done');
  });

  it('treats SessionEnd as a completion', () => {
    const d = decide([{ signal: 'claude_code.session_end', at: at(3) }]);
    expect(d.status).toBe('done');
  });
});

describe('decideStatus — running', () => {
  it('counts recent tool calls', () => {
    const d = decide([{ signal: 'claude_code.post_tool_use', at: at(2) }]);
    expect(d.status).toBe('running');
    expect(d.rule).toBe('running.live-activity');
  });

  it('counts a session that just started but has produced nothing yet', () => {
    const d = decide([{ signal: 'claude_code.session_start', at: at(1) }]);
    expect(d.status).toBe('running');
  });

  it('survives a long silent tool run as long as heartbeats keep arriving', () => {
    const observations: Observation[] = [];
    for (let m = 40; m >= 0; m -= 5) {
      observations.push({ signal: 'claude_code.post_tool_use', at: at(m) });
    }
    const d = decide(observations);
    expect(d.status).toBe('running');
  });
});

describe('decideStatus — stale', () => {
  it('goes stale when the CLI process is alive but nothing was written', () => {
    const d = decide([
      { signal: 'claude_code.transcript_write', at: at(11) },
      { signal: 'claude_code.process_alive', at: at(0) },
    ]);
    expect(d.status).toBe('stale');
    expect(d.rule).toBe('stale.no-progress');
    expect(d.reason).toContain('threshold 10 min');
  });

  it('does NOT let process liveness masquerade as progress', () => {
    const d = decide([{ signal: 'claude_code.process_alive', at: at(0) }]);
    expect(d.status).toBe('stale');
  });

  it('is still running one minute inside the CLI threshold', () => {
    const d = decide([{ signal: 'claude_code.transcript_write', at: at(9) }]);
    expect(d.status).toBe('running');
    expect(DEFAULT_STALE_THRESHOLDS.cli.noProgressMs).toBe(10 * MIN);
  });

  it('flags a dead CLI process with no stop event', () => {
    const d = decide([
      { signal: 'claude_code.post_tool_use', at: at(3) },
      { signal: 'claude_code.process_dead', at: at(1) },
    ]);
    expect(d.status).toBe('stale');
    expect(d.rule).toBe('stale.process-dead-no-completion');
    expect(d.confidence).toBe('med');
  });

  it('does not flag a dead process that completed first', () => {
    const d = decide([
      { signal: 'claude_code.stop', at: at(5) },
      { signal: 'claude_code.process_dead', at: at(4) },
    ]);
    expect(d.status).toBe('done');
  });

  it('uses the 15 min web threshold, not the 10 min CLI one', () => {
    const twelveMinIdle = decide([{ signal: 'web.generating', at: at(12) }], 'web');
    expect(twelveMinIdle.status).toBe('running');

    const sixteenMinIdle = decide([{ signal: 'web.generating', at: at(16) }], 'web');
    expect(sixteenMinIdle.status).toBe('stale');
    expect(sixteenMinIdle.rule).toBe('stale.web-abandoned');
  });

  it('reports a closed tab as process death, not abandonment', () => {
    const d = decide(
      [
        { signal: 'web.generating', at: at(20) },
        { signal: 'web.tab_closed', at: at(19) },
      ],
      'web',
    );
    expect(d.status).toBe('stale');
    expect(d.rule).toBe('stale.process-dead-no-completion');
  });
});

describe('decideStatus — traceability', () => {
  it('always names the rule, signal, confidence and anchor timestamp', () => {
    const d = decide([{ signal: 'claude_code.notification.permission_prompt', at: at(7) }]);
    expect(d).toMatchObject({
      status: 'needs_victor',
      rule: 'needs_victor.blocking-signal',
      basisSignal: 'claude_code.notification.permission_prompt',
      basisAt: at(7),
      evaluatedAt: NOW,
    });
    expect(d.reason.length).toBeGreaterThan(0);
  });

  it('breaks same-millisecond ties in favour of the explicit signal', () => {
    const t = at(2);
    const d = decide([
      { signal: 'claude_code.transcript_write', at: t },
      { signal: 'claude_code.post_tool_use', at: t },
    ]);
    expect(d.basisSignal).toBe('claude_code.post_tool_use');
    expect(d.confidence).toBe('high');
  });

  it('honours per-surface threshold overrides', () => {
    const observations: Observation[] = [{ signal: 'claude_code.transcript_write', at: at(20) }];
    const strict = decideStatus({ observations, surface: 'cli', now: NOW });
    expect(strict.status).toBe('stale');

    const lenient = decideStatus({
      observations,
      surface: 'cli',
      now: NOW,
      thresholds: { cli: { noProgressMs: 60 * MIN } },
    });
    expect(lenient.status).toBe('running');
  });
});
