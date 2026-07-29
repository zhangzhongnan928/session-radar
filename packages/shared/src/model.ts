/**
 * Unified event model for session-radar.
 *
 * Every timestamp in this model is epoch milliseconds (integer). We deliberately
 * avoid ISO strings so ordering, windowing and SQLite storage are all trivial and
 * timezone-free. Formatting is a presentation concern.
 */
import { z } from 'zod';

/**
 * Vendor/interface that owns a session identity.
 *
 * Cursor and Windsurf can route individual turns to several model vendors, but
 * their local conversation ids belong to the interface itself. Keeping those
 * namespaces separate prevents an unrelated Cursor UUID from colliding with an
 * OpenAI or Anthropic conversation id.
 */
export const providerSchema = z.enum([
  'openai',
  'anthropic',
  'cursor',
  'windsurf',
  'google',
  'github',
  'cline',
  'augment',
]);
export type Provider = z.infer<typeof providerSchema>;

/** Where the session is observed from. */
export const surfaceSchema = z.enum(['cli', 'web', 'desktop', 'mobile', 'extension']);
export type Surface = z.infer<typeof surfaceSchema>;

/**
 * The canonical status enum. There are exactly four. `attention` (seen/unseen)
 * is a separate dashboard-local property and is never a fifth status.
 */
export const statusSchema = z.enum(['running', 'needs_victor', 'done', 'stale']);
export type Status = z.infer<typeof statusSchema>;

export const attentionSchema = z.enum(['seen', 'unseen']);
export type Attention = z.infer<typeof attentionSchema>;

export const confidenceSchema = z.enum(['high', 'med', 'low']);
export type Confidence = z.infer<typeof confidenceSchema>;

/**
 * Connector health. `unsupported` is an honest terminal verdict for a surface we
 * investigated and cannot observe (see M3) — it is NOT the same as `down`.
 */
export const coverageStateSchema = z.enum(['ok', 'degraded', 'down', 'unsupported']);
export type CoverageState = z.infer<typeof coverageStateSchema>;

export const permissionStateSchema = z.enum(['granted', 'denied', 'unknown', 'not_required']);
export type PermissionState = z.infer<typeof permissionStateSchema>;

/** How two sightings were decided to be the same WorkItem. */
export const mergeBasisSchema = z.enum(['canonical-id', 'fingerprint']);
export type MergeBasis = z.infer<typeof mergeBasisSchema>;

/** Epoch milliseconds. */
export const timestampSchema = z.number().int().nonnegative();

/** A registered origin of sightings: one tool, on one device, for one account. */
export const sourceSchema = z.object({
  id: z.string().min(1),
  provider: providerSchema,
  surface: surfaceSchema,
  device: z.string().min(1),
  account: z.string().optional(),
  version: z.string().optional(),
});
export type Source = z.infer<typeof sourceSchema>;

/**
 * One entry point into a WorkItem. A conversation seen in the browser, in the
 * desktop app and in the CLI produces three SourceRefs on ONE WorkItem — we never
 * throw an entry point away, because "how do I get back to this?" is the whole point.
 */
export const sourceRefSchema = z.object({
  id: z.string().min(1),
  workItemId: z.string().min(1),
  source: sourceSchema,
  /** Stable id inside the source: session id for CLI, conversation id for web. */
  externalId: z.string().min(1),
  /** Deep link, when the surface has one. */
  url: z.string().optional(),
  /** Copy-pasteable resume command, when the surface has one. */
  resumeCommand: z.string().optional(),
  /** Human "go find it here" hint when there is neither a link nor a command. */
  locateHint: z.string().optional(),
  /** The source vendor explicitly archived this entry point. */
  archived: z.boolean().optional(),
  firstSeenAt: timestampSchema,
  lastSeenAt: timestampSchema,
  mergeBasis: mergeBasisSchema,
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const workItemContextSchema = z.object({
  cwd: z.string().optional(),
  repo: z.string().optional(),
  conversationId: z.string().optional(),
  url: z.string().optional(),
});
export type WorkItemContext = z.infer<typeof workItemContextSchema>;

/**
 * Why an item is in the status it is in. Every status the dashboard shows must be
 * traceable to one of these rows.
 */
export const statusEvidenceSchema = z.object({
  id: z.string().min(1),
  workItemId: z.string().min(1),
  /** When the decision was made. */
  at: timestampSchema,
  /** Named signal from the signal registry (see signals.ts). */
  signal: z.string().min(1),
  /** Connector-supplied detail. Metadata only — never prompt or reply text. */
  raw: z.unknown(),
  /** Named rule from the status engine that fired. */
  rule: z.string().min(1),
  confidence: confidenceSchema,
  resultingStatus: statusSchema,
  connectorId: z.string().optional(),
});
export type StatusEvidence = z.infer<typeof statusEvidenceSchema>;

export const statusTransitionSchema = z.object({
  id: z.string().min(1),
  workItemId: z.string().min(1),
  /** null for the first observed status. */
  from: statusSchema.nullable(),
  to: statusSchema,
  at: timestampSchema,
  evidenceId: z.string().nullable(),
});
export type StatusTransition = z.infer<typeof statusTransitionSchema>;

export const workItemSchema = z.object({
  id: z.string().min(1),
  /** `(provider, conversationId|sessionId)` or a fingerprint fallback. */
  canonicalKey: z.string().min(1),
  title: z.string(),
  provider: providerSchema,
  entryPoints: z.array(sourceRefSchema),
  context: workItemContextSchema,
  status: statusSchema,
  statusSince: timestampSchema,
  lastActivityAt: timestampSchema,
  attention: attentionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** The evidence row that produced `status`. Absent only for orphaned rows. */
  currentEvidence: statusEvidenceSchema.optional(),
});
export type WorkItem = z.infer<typeof workItemSchema>;

/**
 * Per-connector coverage. A dead connector must show up here loudly; it must never
 * become silence or be mistaken for "nothing is running".
 */
export const coverageHealthSchema = z.object({
  connectorId: z.string().min(1),
  displayName: z.string().min(1),
  provider: providerSchema.optional(),
  surface: surfaceSchema.optional(),
  state: coverageStateSchema,
  lastSuccessfulScanAt: timestampSchema.nullable(),
  permissionState: permissionStateSchema,
  lastError: z.string().nullable(),
  observedSessionCount: z.number().int().nonnegative(),
  /** Sessions outside the triage window: counted separately, but backfilled when enumerable. */
  archivedSessionCount: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
});
export type CoverageHealth = z.infer<typeof coverageHealthSchema>;
