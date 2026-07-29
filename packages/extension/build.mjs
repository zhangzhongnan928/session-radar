import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Content scripts cannot use ES module imports, so all three entry points are
// bundled. `shared` is pulled in from source rather than dist so the extension
// and the daemon can never drift on the wire contract.
await build({
  entryPoints: [
    join(root, 'src/background.ts'),
    join(root, 'src/content.ts'),
    join(root, 'src/page.ts'),
  ],
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  platform: 'browser',
  sourcemap: true,
  logLevel: 'info',
});

copyFileSync(join(root, 'manifest.json'), join(dist, 'manifest.json'));

process.stdout.write(`\nBuilt to ${dist}\nLoad it: chrome://extensions -> Developer mode -> Load unpacked -> select that folder\n`);
