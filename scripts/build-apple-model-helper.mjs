import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(
  root,
  'packages',
  'daemon',
  'apple-foundation-models',
  'SessionRadarAppleModel.swift',
);
const output = resolve(
  root,
  'packages',
  'daemon',
  'dist',
  'bin',
  'session-radar-apple-model',
);

// Never leave a previously built helper behind when this build cannot produce
// the matching binary. The TypeScript service will then expose the honest
// deterministic-only state.
rmSync(output, { force: true });

if (platform() !== 'darwin') {
  process.stdout.write(
    'Apple Foundation Models helper: unavailable on this platform; deterministic analysis remains enabled.\n',
  );
  process.exit(0);
}

const compiler = spawnSync('xcrun', ['--find', 'swiftc'], {
  encoding: 'utf8',
});
if (compiler.status !== 0 || !compiler.stdout.trim()) {
  process.stdout.write(
    'Apple Foundation Models helper: Swift compiler not found; deterministic analysis remains enabled.\n',
  );
  process.exit(0);
}

mkdirSync(dirname(output), { recursive: true });

const targetArch = arch() === 'x64' ? 'x86_64' : arch();
const built = spawnSync(
  'xcrun',
  [
    'swiftc',
    '-parse-as-library',
    '-O',
    '-target',
    `${targetArch}-apple-macosx15.0`,
    source,
    '-o',
    output,
  ],
  { encoding: 'utf8' },
);

if (built.status !== 0) {
  rmSync(output, { force: true });
  const detail = (built.stderr || built.stdout)
    .split('\n')
    .filter(Boolean)
    .slice(0, 6)
    .join('\n');
  process.stdout.write(
    [
      'Apple Foundation Models helper: build unavailable; deterministic analysis remains enabled.',
      detail,
      '',
    ].join('\n'),
  );
  process.exit(0);
}

chmodSync(output, 0o755);
process.stdout.write('Apple Foundation Models helper: built local on-device bridge.\n');
