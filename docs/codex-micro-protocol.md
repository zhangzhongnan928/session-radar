# How Codex Micro gets its status — investigation and capture plan

Victor has two Codex Micro units in transit. This records what static analysis already
established, and the plan for capturing the protocol once they arrive.

Observing traffic between hardware you own and an app on your own machine, for
interoperability, is the legitimate case. Nothing here involves impersonating a device
or defeating encryption.

---

## The bigger finding: inventory no longer needs CDP or hardware

Static inspection changed the ChatGPT verdict, but through a safer route than the
original CDP hypothesis.

```
/Applications/ChatGPT.app/Contents/Frameworks/
  Codex Framework.framework/Versions/150.0.7871.128/Codex Framework   (254 MB)
```

That version is a **Chromium version**, and the framework identifies as
`Chrome/150.0.7871.128`. More importantly, the app persists its recent and pinned ChatGPT
conversation lists in Chromium Local Storage:

```
~/Library/Application Support/Codex/Default/Local Storage/leveldb
  codex.chatgpt-conversations
  codex.chatgpt-pinned-conversations
```

Those cache records provide server ids, titles and timestamps, and the bundled app
contains the deep-link form `codex://threads/<id>`. Session-radar now reads a private
copy of that store and ingests only allowlisted metadata.

The app's `~/.codex/ipc/ipc.sock` does not finish the job. It is a coordination bus for
following already-known Codex thread streams, not a thread-list API. Its
`thread-stream-state-changed` method transfers full conversation snapshots and patches,
not a narrow status event, so an external subscription would still miss forgotten ids
and would violate session-radar's metadata-only boundary. The first-party renderer holds
ordinary ChatGPT lifecycle in memory as `idle | streaming | error`; those values are not
in the persisted cache. There is one verified exception: the recent-list record has an
`async_status` enum whose bundle-defined values `3` (`STREAMING`) and `4` (`UNREAD`,
meaning a background result is ready) are persisted and now classified.

So inventory and that narrow async lifecycle are solved without relaunching the app,
enabling CDP, touching encrypted conversation files or waiting for hardware. CDP
remains an untested, consent-bound option for the full ordinary-chat lifecycle. The HID
route below is now optional protocol research, not a prerequisite for the dashboard.

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

The deployed `chatgpt-desktop` connector already covers recent/pinned inventory,
classifies persisted async values 3/4, and marks all other cache-only rows
`stale.inventory-only`. A decoded HID protocol would only be useful if it also carries
a stable conversation id and can be observed without permanently modified hardware.

A passive HID listener is not usable as-is: host-to-device output reports are not
broadcast to another process. Custom firmware on a spare unit is fine for *learning* the
protocol but is not a reasonable required dependency for the dashboard.

The deployable variant would be inverted: flash unit B to forward received frames over
its own console/serial channel. That is technically workable, but it makes a dedicated
device part of one connector. A supported software status subscription, or the existing
Chrome extension when a conversation is open there, remains the better production path.

**Recommendation:** treat the HID capture as optional interoperability research. It is
interesting, but no longer on session-radar's inventory critical path.
