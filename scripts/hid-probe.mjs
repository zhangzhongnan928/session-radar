#!/usr/bin/env node
/**
 * HID probe — preparation for reverse-engineering how the ChatGPT desktop app
 * pushes Codex thread status to a Codex Micro.
 *
 * Run it BEFORE plugging the device in to capture a baseline, then again after.
 * The diff isolates the device's interfaces, including the QMK raw-HID one
 * (usage page 0xFF60, usage 0x61) that a status protocol would almost certainly
 * ride on.
 *
 *   node scripts/hid-probe.mjs baseline    # before the device is attached
 *   node scripts/hid-probe.mjs diff        # after
 *
 * This only reads macOS's IORegistry. It opens nothing, writes nothing, and
 * needs no permissions.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = join(homedir(), '.session-radar', 'hid-probe');
const BASELINE = join(STATE_DIR, 'baseline.json');

/** QMK's raw HID interface, and what the VIA/QMK ecosystem standardises on. */
const QMK_RAW_HID = { usagePage: 0xff60, usage: 0x61 };

/**
 * Parses `ioreg` text output rather than its plist form: the plist contains
 * `<data>` blobs that `plutil` refuses to convert to JSON.
 */
function readHidDevices() {
  const text = execFileSync('ioreg', ['-c', 'IOHIDDevice', '-r', '-d1'], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });

  const devices = [];
  let current = null;

  for (const line of text.split('\n')) {
    // Each device node starts with `+-o <name>  <class ...>`.
    if (/^\s*\+-o /.test(line)) {
      if (current && current.vendorId !== undefined) devices.push(current);
      current = {};
      continue;
    }
    if (!current) continue;

    const match = /"([A-Za-z]+)"\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match;
    const value = rawValue.startsWith('"') ? rawValue.replace(/^"|"$/g, '') : Number(rawValue);

    switch (name) {
      case 'VendorID': current.vendorId = value; break;
      case 'ProductID': current.productId = value; break;
      case 'Product': current.product = value; break;
      case 'Manufacturer': current.manufacturer = value; break;
      case 'PrimaryUsagePage': current.usagePage = value; break;
      case 'PrimaryUsage': current.usage = value; break;
      case 'Transport': current.transport = value; break;
      case 'LocationID': current.locationId = value; break;
      default: break;
    }
  }
  if (current && current.vendorId !== undefined) devices.push(current);
  return devices;
}

function key(d) {
  return `${d.vendorId}:${d.productId}:${d.usagePage}:${d.usage}:${d.locationId ?? ''}`;
}

function describe(d) {
  const hex = (n) => (typeof n === 'number' ? `0x${n.toString(16).padStart(4, '0')}` : '?');
  const raw =
    d.usagePage === QMK_RAW_HID.usagePage && d.usage === QMK_RAW_HID.usage
      ? '   <-- QMK RAW HID (this is the status channel)'
      : '';
  return (
    `  ${String(d.product ?? '(unnamed)').padEnd(34)} vid=${hex(d.vendorId)} pid=${hex(d.productId)} ` +
    `usagePage=${hex(d.usagePage)} usage=${hex(d.usage)} ${d.transport ?? ''}${raw}`
  );
}

const command = process.argv[2] ?? 'diff';
const devices = readHidDevices();

if (command === 'baseline') {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(BASELINE, JSON.stringify(devices, null, 2), { mode: 0o600 });
  console.log(`baseline saved: ${devices.length} HID interfaces -> ${BASELINE}`);
  console.log('Now plug in the Codex Micro and run:  node scripts/hid-probe.mjs diff');
} else if (command === 'diff') {
  if (!existsSync(BASELINE)) {
    console.log('No baseline yet. Run `node scripts/hid-probe.mjs baseline` first.');
    process.exit(1);
  }
  const before = new Set(JSON.parse(readFileSync(BASELINE, 'utf8')).map(key));
  const added = devices.filter((d) => !before.has(key(d)));

  if (added.length === 0) {
    console.log('No new HID interfaces since the baseline.');
    process.exit(0);
  }

  console.log(`\n${added.length} new HID interface(s):\n`);
  for (const d of added) console.log(describe(d));

  const rawHid = added.find(
    (d) => d.usagePage === QMK_RAW_HID.usagePage && d.usage === QMK_RAW_HID.usage,
  );
  console.log('');
  if (rawHid) {
    const hex = (n) => `0x${n.toString(16).padStart(4, '0')}`;
    console.log('Found a QMK raw-HID interface. That is where status frames ride.');
    console.log(`  vendorId  ${hex(rawHid.vendorId)}`);
    console.log(`  productId ${hex(rawHid.productId)}`);
    console.log('\nNext: the app writes OUTPUT reports to the device, which another');
    console.log('process cannot observe by opening the same interface. Use the QMK');
    console.log('console route on the spare unit — see docs/codex-micro-protocol.md.');
  } else {
    console.log('No 0xFF60/0x61 interface. Either it is not QMK raw HID, or the');
    console.log('status channel is Bluetooth. Capture over BLE instead (PacketLogger).');
  }
} else {
  console.log('usage: hid-probe.mjs [baseline|diff]');
  process.exit(2);
}
