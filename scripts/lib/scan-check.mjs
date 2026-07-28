#!/usr/bin/env node
/**
 * The machine-checkable half of the 30-second scan test.
 *
 * A human still has to do the actual scan. What this proves is that the
 * information needed to do it is present and correctly ordered: every state is
 * represented, the order puts what needs attention first, each item explains
 * itself, and each actionable item offers a way back in.
 */

const baseUrl = process.argv[2];
if (!baseUrl) {
  process.stderr.write('usage: scan-check.mjs <baseUrl>\n');
  process.exit(2);
}

const response = await fetch(`${baseUrl}/api/workitems`);
const { items, coverage } = await response.json();

/** Same buckets the dashboard groups by. */
function bucket(item) {
  if (item.status === 'needs_victor') return 0;
  if (item.status === 'done') return item.attention === 'unseen' ? 1 : 4;
  if (item.status === 'stale') return 2;
  return 3;
}

const states = new Set(items.map((i) => i.status));
const counts = {
  needs_victor: items.filter((i) => i.status === 'needs_victor').length,
  done: items.filter((i) => i.status === 'done').length,
  stale: items.filter((i) => i.status === 'stale').length,
  running: items.filter((i) => i.status === 'running').length,
};
console.log(
  `items=${items.length} needs=${counts.needs_victor} done=${counts.done} stale=${counts.stale} running=${counts.running} coverage=${coverage.overall}`,
);

if (states.size === 4) console.log('STATES_OK all four states represented');
else console.log(`STATES_MISSING only: ${[...states].join(', ')}`);

// Scan order: buckets must be non-decreasing down the list.
let ordered = true;
for (let i = 1; i < items.length; i += 1) {
  if (bucket(items[i]) < bucket(items[i - 1])) {
    ordered = false;
    console.log(
      `ORDER_BROKEN at index ${i}: ${items[i].status} after ${items[i - 1].status}`,
    );
    break;
  }
}
if (ordered) console.log('ORDER_OK needs_victor -> done+unseen -> stale -> running -> done+seen');

// Every item must carry a rule, a confidence and a human reason.
const unexplained = items.filter((item) => {
  const evidence = item.currentEvidence;
  if (!evidence?.rule || !evidence.confidence) return true;
  const raw = evidence.raw;
  const reason = raw && typeof raw === 'object' ? raw.reason : undefined;
  return typeof reason !== 'string' || reason.length === 0;
});
if (unexplained.length === 0) console.log('EVIDENCE_OK every item names its rule, confidence and reason');
else console.log(`EVIDENCE_MISSING ${unexplained.length} item(s), e.g. "${unexplained[0].title}"`);

// Anything Victor might act on needs a route back: a link, a command, or a hint.
const actionable = items.filter(
  (item) => item.status === 'needs_victor' || item.status === 'stale' || item.status === 'done',
);
const stranded = actionable.filter(
  (item) => !item.entryPoints.some((e) => e.url || e.resumeCommand || e.locateHint),
);
if (stranded.length === 0) {
  console.log(`ENTRY_OK all ${actionable.length} actionable items have a link, command or hint`);
} else {
  console.log(`ENTRY_MISSING ${stranded.length} stranded, e.g. "${stranded[0].title}"`);
}
