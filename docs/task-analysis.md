# Per-task analysis boundary

`session-radar` can prove lifecycle facts from metadata, but lifecycle metadata
does not reveal a task's substantive result. A source-confirmed stop can support
“Done—review needed”; it cannot support “the migration succeeded.”

The dashboard therefore exposes analysis as a deliberately separate, per-card
flow:

1. The user expands **Analyze this task** on one card.
2. The dashboard states the only requested outputs: final conclusion,
   unresolved items, and code-change summary.
3. A second user action sends `POST /api/workitems/:id/analyze` with
   `authorize: true` and an allowlisted `requestedFields` array.
4. When Apple Foundation Models is available, the already-selected result
   excerpt is summarized on device. The deterministic bounded projection is
   retained as the evidence-bearing fallback and trust anchor.
5. The response lists the fields and source material examined, source and
   lifecycle evidence, uncertainty, generation time, byte budget, local-model
   status, and whether any full conversation was read or raw content was stored.
6. **Refresh analysis** repeats that bounded request for the same card. Results
   are not written to the radar database.

Opening the panel may call `GET /api/analysis/status`. That is a content-free
availability probe only. It does not identify, open, or read any task. The
source reader and model bridge run only after the explicit per-card
`authorize: true` request.

## Supported result adapters

| Task source | Result surface | Support |
| --- | --- | --- |
| Codex Desktop, Codex CLI, Codex browser side panel, Buzz/Codex | Exact session rollout under `~/.codex/sessions` | Latest assistant `final_answer` |
| Claude Code CLI | Exact session transcript under `~/.claude/projects` | Latest non-sidechain assistant `end_turn` text |
| Claude Code in Claude Desktop | The joined CLI transcript, when the card's canonical id matches it | Same bounded `end_turn` projection |
| Ordinary Claude Desktop chat, Claude web, ChatGPT, Grok Build, Cursor, and other sources | No verified narrow result adapter | Explicitly unavailable, with no source body read |

Claude Desktop **Code** and ordinary Claude Desktop **chat** are intentionally
different here. The former can expose a plain local Code transcript joined by an
exact session id. The latter does not currently expose a verified narrow result
surface, so session-radar does not inspect private/encrypted app data or widen to
a full chat read.

## What one authorised request reads

1. Radar takes candidate session ids only from that card's source references and
   canonical identity.
2. It enumerates filename/stat metadata in the corresponding known local source
   root to find an exact id match. It does not open other transcript bodies.
3. It reads the matched JSONL file backwards in 8 KiB chunks, stopping as soon
   as the newest supported terminal assistant record is found.
4. The reader has a 512 KiB ceiling and deliberately leaves at least one source
   byte unread, even for a tiny file. A cut record is ignored rather than
   widening the read.
5. User turns, reasoning, tool calls/results, commentary/intermediate assistant
   text, and Claude sidechain/subagent results are not selected for analysis.
6. The selected assistant result is capped, stripped of transport directives,
   and projected deterministically into:

   - outcome/current progress;
   - explicit verification statements;
   - explicitly stated unresolved items;
   - explicitly stated risks/blockers;
   - code-change summary;
   - source-stated or clearly labelled inferred next step.

Raw source text exists only transiently in process memory for that request. The
daemon does not cache it, write it to SQLite, add it to lifecycle evidence, or
return it as a transcript. The browser holds only the capped structured response
for the open card.

`fullConversationRead` is `false` for these adapters by construction.
`fullConversationStored` and `rawConversationStored` are always `false`.

## Optional Apple on-device semantic enhancement

On macOS, the normal build tries to compile the narrow Swift helper
`session-radar-apple-model`. Failure to find a compatible Swift SDK is
non-fatal: the TypeScript service and deterministic analysis still build and
run. At runtime the helper reports one of the following without reading task
content:

- available;
- device not eligible;
- Apple Intelligence disabled;
- model downloading/not ready;
- unsupported locale;
- unsupported macOS/runtime;
- helper missing or failed.

The model is usable only when the Mac, macOS runtime, Apple Intelligence
setting, installed on-device assets, and current locale are supported. Radar
does not change those settings.

For one authorised task request:

1. The existing adapter performs the same exact-id match and bounded reverse
   read described above.
2. The deterministic projection runs first.
3. Radar selects at most 16 Ki characters from that latest completed assistant
   response. If necessary it uses a disclosed head/tail excerpt and marks it as
   truncated.
4. The daemon starts one Swift helper process with **zero command-line
   arguments**. JSON goes over stdin; no task content is placed in argv, an
   environment variable, or a temporary file.
5. The helper uses `SystemLanguageModel.default` with an empty tools array and
   a constrained `@Generable` schema. Task content is encoded as untrusted JSON
   data and the model is instructed never to follow instructions inside it.
6. The helper returns capped JSON containing a concise summary, outcome,
   source-reported verification, unresolved items, risks/blockers, change
   summary, next step, and uncertainty. Its stdout is byte-capped and
   schema-validated by the daemon.
7. Evidence-bearing fields are reconciled to the deterministic bounded
   projection. The model supplies the semantic summary; it cannot fill a fact
   field that the deterministic source projection left unstated.
8. Each summary sentence must be an extractive word sequence found in one
   deterministic grounding claim. Any model sentence that combines claims or
   introduces unsupported content is discarded. If no model sentence survives,
   the UI labels and shows a concise deterministic fallback instead of
   presenting it as model output.

This personal local flow intentionally passes the authorised excerpt directly
to the on-device model without deidentifying ordinary task content. It does
**not** use a cloud API, Claude Code, API keys, Private Cloud Compute, or a
network fallback. The helper receives a restricted environment and exposes no
tools or actions.

Only one generation runs at a time. A concurrent request is rejected rather
than queued in the background. Timeouts, refusals, guardrail decisions,
unsupported language, context-window limits, decoding errors, and unavailable
model assets all produce a visible local-enhancement status while preserving
the deterministic result.

The raw excerpt, generated prompt, Foundation Models transcript, and raw model
output are request-scoped memory only and are not logged or written to the
ledger. The browser receives only the derived structured result and provenance.
No analysis runs in the background.

## Evidence and uncertainty

The result separates three kinds of claims:

- **Source report** — text projected from the exact task's latest completed
  assistant response. High confidence means the source said it; it does not mean
  session-radar independently reproduced the work.
- **Verified lifecycle fact** — the existing metadata-derived radar state, kept
  separate from the substantive source result.
- **Inference** — currently limited to a recommended next step when the source
  did not state one. The uncertainty list says so explicitly.
- **Apple on-device summary** — a request-scoped semantic rendering constrained
  by the deterministic source facts. The UI identifies the model, input size,
  truncation, generation time, no-tools state, and no-cloud state.

Absent sections remain `null` and render as “Not stated”; an explicit “none”
renders as an empty list. A running or waiting task is described as the latest
completed-turn progress, not a final outcome. When no terminal result appears
within the bounded window, radar returns `unavailable` and does not expand the
read.

## Adapter contract

Any additional source adapter may be added only when its platform offers a safe,
explicit per-task authorisation path. It must:

- receive one work-item identity and the allowlisted requested fields;
- request the minimum source material needed for those fields;
- never enumerate or ingest unrelated conversations;
- avoid persisting a full prompt/reply stream;
- return evidence and uncertainty alongside every substantive result;
- report `partial` or `unavailable` when a requested field cannot be supported;
- keep connector coverage separate from task result confidence.

The intended future flow is:

`voice delegation -> immediate metadata card -> lifecycle updates -> per-task
analysis on request -> open original task`

The analysis endpoint is not a promise of universal platform access. Each source
still requires its own verified authorisation and return-path support.
