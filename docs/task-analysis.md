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
4. The response must list the fields actually accessed, evidence for each claim,
   uncertainty, and whether any full conversation was read or stored.

No authorised source adapter exists in this version. The endpoint consequently
returns `status: "unavailable"`, `accessedFields: []`, and a truthful explanation.
It does not open transcripts, read conversation bodies, or persist analysis
material.

## Future adapter contract

A source adapter may be added only when its platform offers a safe, explicit
per-task authorisation path. It must:

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
requires its own verified authorisation and return-path support.
