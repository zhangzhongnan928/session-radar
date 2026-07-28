#!/usr/bin/env node
/**
 * Query helper for the acceptance scripts.
 *
 * Exists because embedding JavaScript inside `$(...)` in a shell script is a
 * quoting minefield — an earlier version had a check silently pass on a mangled
 * command. Named commands with plain arguments cannot be mangled that way.
 *
 *   node scripts/lib/query.mjs <baseUrl> <command> [args...]
 */

const [, , baseUrl, command, ...args] = process.argv;

if (!baseUrl || !command) {
  process.stderr.write('usage: query.mjs <baseUrl> <command> [args...]\n');
  process.exit(2);
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.json();
}

/** Work items are matched by canonical-key suffix so tests can use short ids. */
function findItem(items, suffix) {
  return items.find((item) => item.canonicalKey.endsWith(suffix));
}

try {
  switch (command) {
    case 'status': {
      const { items } = await get('/api/workitems');
      const item = findItem(items, args[0]);
      console.log(item ? item.status : '<absent>');
      break;
    }
    case 'count': {
      const { count } = await get('/api/workitems');
      console.log(count);
      break;
    }
    case 'coverage-overall': {
      const { overall } = await get('/api/coverage');
      console.log(overall);
      break;
    }
    case 'coverage-state': {
      const { connectors } = await get('/api/coverage');
      const connector = connectors.find((c) => c.connectorId === args[0]);
      console.log(connector ? connector.state : '<absent>');
      break;
    }
    case 'coverage-error-matches': {
      const { connectors } = await get('/api/coverage');
      const connector = connectors.find((c) => c.connectorId === args[0]);
      const pattern = new RegExp(args[1], 'i');
      console.log(connector && pattern.test(connector.lastError ?? '') ? 'yes' : 'no');
      break;
    }
    case 'connector-count-by-surface': {
      const { connectors } = await get('/api/coverage');
      console.log(connectors.filter((c) => c.surface === args[0]).length);
      break;
    }
    case 'item-count-matching': {
      const { items } = await get('/api/workitems');
      console.log(items.filter((item) => item.canonicalKey.endsWith(args[0])).length);
      break;
    }
    case 'entry-surfaces': {
      const { items } = await get('/api/workitems');
      const item = findItem(items, args[0]);
      if (!item) { console.log('<absent>'); break; }
      console.log([...new Set(item.entryPoints.map((e) => e.source.surface))].sort().join('+'));
      break;
    }
    case 'has-both-entry-kinds': {
      const { items } = await get('/api/workitems');
      const item = findItem(items, args[0]);
      if (!item) { console.log('<absent>'); break; }
      const hasUrl = item.entryPoints.some((e) => e.url);
      const hasCommand = item.entryPoints.some((e) => e.resumeCommand);
      console.log(hasUrl && hasCommand ? 'yes' : 'no');
      break;
    }
    case 'evidence-rule': {
      const { items } = await get('/api/workitems');
      const item = findItem(items, args[0]);
      console.log(item?.currentEvidence ? item.currentEvidence.rule : '<absent>');
      break;
    }
    case 'title': {
      const { items } = await get('/api/workitems');
      const item = findItem(items, args[0]);
      console.log(item ? item.title : '<absent>');
      break;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      process.exit(2);
  }
} catch (error) {
  console.log(`<error:${error instanceof Error ? error.message : String(error)}>`);
}
