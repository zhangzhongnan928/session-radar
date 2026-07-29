# How Codex Micro gets its status — investigation and capture plan

Victor has two Codex Micro units in transit. This records what static analysis already
established, and the plan for capturing the protocol once they arrive.

Observing traffic between hardware you own and an app on your own machine, for
interoperability, is the legitimate case. Nothing here involves impersonating a device
or defeating encryption.

---

## The bigger finding: this may all be unnecessary

While looking for the HID plumbing, static analysis turned up something that changes the
ChatGPT verdict entirely.

```
/Applications/ChatGPT.app/Contents/Frameworks/
  Codex Framework.framework/Versions/150.0.7871.128/Codex Framework   (254 MB)
```

That version is a **Chromium version**, and the framework identifies as
`Chrome/150.0.7871.128`. The merged ChatGPT + Codex desktop app is a Chromium app.

It carries the debugging switches:

| Switch | Present |
| --- | --- |
| `remote-debugging-port` | yes |
| `remote-debugging-pipe` | yes |
| `remote-allow-origins` | yes |

This also explains the AppleScript dictionary: the Chromium Suite with `tab`/`window`/
`execute` is not vestigial boilerplate, it is a genuinely Chromium-backed app.

**So the same CDP route proposed for Claude Desktop very likely works here too** — read
the conversation UI directly, no HID, no hardware, no decryption. To confirm:

```bash
osascript -e 'quit app "ChatGPT"'
sleep 2
/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9223 &
sleep 8
curl -s http://127.0.0.1:9223/json/list | python3 -m json.tool | head -40
```

If the target list contains a `chatgpt.com` page, ChatGPT desktop is solvable the same
way Claude Desktop is, and the M3 verdict flips for both.

**Test this before doing any hardware work.** The HID route below is more interesting but
far more expensive, and it only ever yields status — CDP yields conversation ids, titles
and state.

---

## What static analysis says about the HID path

From `Codex Framework`:

- `IOHIDDevice` and `IOHIDParamUserClient` — the app talks to HID devices through IOKit
  directly, as expected for driving LEDs on a macropad.
- No `com.apple.security.device.usb` entitlement is needed because the app is not
  sandboxed (the same property behind the 2024 plaintext-conversations disclosure).
- The docs note macOS asks for **Input Monitoring** during setup. That permission is for
  *reading* key presses. Writing LED state is an output report and does not need it.

### A red herring, recorded so nobody re-finds it

`strings` on the framework surfaces `options._agentKey`, `_cacheSession(options._agentKey)`
and similar. These look like "Agent Keys" and are **not**: they are Node.js's
`_http_agent.js` connection-pool keys, bundled with the app's Node runtime. Unrelated.

### The hypothesis

Work Louder boards are QMK/VIA — confirmed by their presence in the QMK firmware repo
(issue #24819 concerns "Work Louder Micro RGB Matrix"). VIA is a GUI over QMK, and the
QMK ecosystem standardises status/LED channels on **raw HID**:

| | |
| --- | --- |
| Usage Page | `0xFF60` |
| Usage | `0x61` |
| Report size | 32 bytes, typically |

Strong prior art: a Work Louder × Figma Micro Pad has already been turned into a live
status light for Claude Code and the Codex CLI over raw HID, with no Codex Micro module
involved. So the channel is well-trodden; only OpenAI's framing of the bytes is unknown.

**Working hypothesis:** ChatGPT writes a small output report per thread-state change,
carrying something like `[reportId, keyIndex, state, r, g, b]`, where `state` is one of
idle / thinking / running / waiting / done — the five colours the docs describe (white,
blue, green, amber, red).

---

## Capture plan

### Step 1 — before the devices arrive (done)

```bash
node scripts/hid-probe.mjs baseline
```

Snapshots every HID interface currently attached. Already captured: 25 interfaces.

### Step 2 — when they arrive

Plug in **one** unit, then:

```bash
node scripts/hid-probe.mjs diff
```

This isolates the new interfaces and flags the `0xFF60/0x61` one, printing its vendor and
product ids. If nothing matches, the channel is Bluetooth rather than USB and capture
moves to PacketLogger (Xcode Additional Tools) instead.

### Step 3 — capture the frames

The obstacle: the app writes **output** reports, host to device. Another process opening
the same interface does not see them — HID output is not broadcast. So passive sniffing
from the Mac side needs USB-level capture, which modern macOS makes awkward (the old kext
route is gone; it now wants a hardware analyser).

**The reason having two units matters.** Keep unit A stock. On unit B, flash a QMK build
whose `raw_hid_receive()` echoes what it receives to the QMK console:

```c
void raw_hid_receive(uint8_t *data, uint8_t length) {
    uprintf("RX %u:", length);
    for (uint8_t i = 0; i < length; i++) uprintf(" %02X", data[i]);
    uprintf("\n");
    // then hand off to the stock handler so the device still behaves normally
}
```

Then watch it live while driving Codex threads through their states:

```bash
qmk console        # or: hid_listen
```

That prints the exact bytes ChatGPT sends for each transition. Open-source firmware, own
hardware, no interception of anything that is not ours.

### Step 4 — decode

Drive one thread through idle → thinking → running → waiting → done and record the frame
for each. With five states and six keys the encoding should fall out in minutes. Note the
key index mapping too, since Settings lets you choose which chats the Agent Keys follow.

---

## What session-radar would do with it

Two possibilities, in preference order:

1. **If CDP works** (test it first): a `chatgpt-desktop` connector mirroring the Claude
   Desktop one, reusing the existing site adapter. Full conversation ids and state. The
   HID work becomes unnecessary for the dashboard.

2. **If CDP does not work**: a HID listener is still not usable as-is, because we cannot
   observe host-to-device output reports without either custom firmware or a hardware
   analyser permanently in line. Custom firmware on a spare unit is fine for *learning*
   the protocol but is not a deployable collector.

   The deployable variant would be inverted: flash unit B to *forward* what it receives
   back to the host over its own console/serial channel, and have session-radar read
   that. Workable, but it makes a $230 device a required dependency for one surface —
   hard to justify against simply opening that conversation in Chrome, where the M2
   extension already covers it.

**Recommendation: test CDP first.** If it works, the HID investigation stays what it is —
genuinely interesting, and worth doing for its own sake once the hardware lands, but not
on session-radar's critical path.
