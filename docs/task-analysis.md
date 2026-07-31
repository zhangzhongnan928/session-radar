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
4. The response lists the fields and source material examined, source and
   lifecycle evidence, uncertainty, generation time, byte budget, and whether
   any full conversation was read or raw conversation was stored.
5. **Refresh analysis** repeats that bounded request for the same card. Results
   are not written to the radar database.

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

## Evidence and uncertainty

The result separates three kinds of claims:

- **Source report** — text projected from the exact task's latest completed
  assistant response. High confidence means the source said it; it does not mean
  session-radar independently reproduced the work.
- **Verified lifecycle fact** — the existing metadata-derived radar state, kept
  separate from the substantive source result.
- **Inference** — currently limited to a recommended next step when the source
  did not state one. The uncertainty list says so explicitly.

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
