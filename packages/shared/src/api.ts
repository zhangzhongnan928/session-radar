/**
 * Wire shapes for the daemon's read-only HTTP API, shared with the dashboard and
 * the extension so drift is a type error rather than a runtime surprise.
 */
import { z } from 'zod';
import {
  coverageHealthSchema,
  statusEvidenceSchema,
  statusTransitionSchema,
  timestampSchema,
  workItemSchema,
} from './model.js';

/**
 * Rollup for the Coverage Health strip.
 *
 * `no_connectors` is its own value on purpose: zero registered connectors is not
 * "healthy", it is "we are not watching anything", and the header must say so.
 * `unsupported` connectors are neutral here — they are a known, accepted gap that
 * is still listed individually, not an incident.
 */
export const coverageOverallSchema = z.enum(['ok', 'degraded', 'down', 'no_connectors']);
export type CoverageOverall = z.infer<typeof coverageOverallSchema>;

export const coverageResponseSchema = z.object({
  generatedAt: timestampSchema,
  overall: coverageOverallSchema,
  connectorCount: z.number().int().nonnegative(),
  connectors: z.array(coverageHealthSchema),
});
export type CoverageResponse = z.infer<typeof coverageResponseSchema>;

export const workItemsResponseSchema = z.object({
  generatedAt: timestampSchema,
  count: z.number().int().nonnegative(),
  items: z.array(workItemSchema),
  /** Repeated from /api/coverage so a single fetch can never render a clean-looking lie. */
  coverage: coverageResponseSchema,
});
export type WorkItemsResponse = z.infer<typeof workItemsResponseSchema>;

export const evidenceResponseSchema = z.object({
  workItemId: z.string().min(1),
  evidence: z.array(statusEvidenceSchema),
  transitions: z.array(statusTransitionSchema),
});
export type EvidenceResponse = z.infer<typeof evidenceResponseSchema>;

/**
 * The only substantive fields a per-task analysis adapter may request.
 *
 * Keeping this allowlist in the shared wire contract prevents a future source
 * adapter from quietly expanding "analyze" into full-conversation ingestion.
 */
export const taskAnalysisFieldSchema = z.enum([
  'final_conclusion',
  'unresolved_items',
  'code_change_summary',
]);
export type TaskAnalysisField = z.infer<typeof taskAnalysisFieldSchema>;

export const taskAnalysisRequestSchema = z.object({
  /** Must be an explicit per-item user action; omission or false is rejected. */
  authorize: z.literal(true),
  requestedFields: z
    .array(taskAnalysisFieldSchema)
    .min(1)
    .max(3)
    .refine((fields) => new Set(fields).size === fields.length, {
      message: 'requestedFields must not contain duplicates',
    }),
});
export type TaskAnalysisRequest = z.infer<typeof taskAnalysisRequestSchema>;

const taskAnalysisResultSchema = z.object({
  /** Source-authored outcome or, for active work, the latest completed-turn progress. */
  outcome: z.string().nullable(),
  /** Explicit verification statements found in the selected source result. */
  verifiedResults: z.array(z.string()).nullable(),
  /** `null` means the selected result did not say; `[]` means it explicitly said none. */
  unresolvedItems: z.array(z.string()).nullable(),
  /** `null` means the selected result did not state risks or blockers. */
  risksOrBlockers: z.array(z.string()).nullable(),
  codeChangeSummary: z.string().nullable(),
  /** May be source-authored or a clearly labelled lifecycle-based inference. */
  recommendedNextStep: z.string().nullable(),
});

const taskAnalysisEvidenceSchema = z.object({
  kind: z.enum(['source_report', 'lifecycle_fact', 'inference']),
  source: z.string().min(1),
  claim: z.string().min(1),
  confidence: z.enum(['high', 'med', 'low']),
});

export const taskAnalysisMaterialSchema = z.enum([
  'bounded_source_tail',
  'final_assistant_response',
  'task_lifecycle_metadata',
]);
export type TaskAnalysisMaterial = z.infer<typeof taskAnalysisMaterialSchema>;

/**
 * A bounded, uncertainty-first response. `unavailable` is a useful result: it
 * proves the opt-in boundary ran without pretending metadata reveals substance.
 */
export const taskAnalysisResponseSchema = z.object({
  workItemId: z.string().min(1),
  status: z.enum(['complete', 'partial', 'unavailable']),
  generatedAt: timestampSchema,
  requestedFields: z.array(taskAnalysisFieldSchema),
  accessedFields: z.array(taskAnalysisFieldSchema),
  result: taskAnalysisResultSchema.nullable(),
  evidence: z.array(taskAnalysisEvidenceSchema),
  uncertainties: z.array(z.string()),
  provenance: z.object({
    adapter: z.string().min(1),
    source: z.string().min(1),
    matchedBy: z.enum(['exact_session_id', 'not_matched']),
    accessedMaterial: z.array(taskAnalysisMaterialSchema),
    sourceRecordAt: timestampSchema.nullable(),
    sourceModifiedAt: timestampSchema.nullable(),
    /** Transparent byte budget, not a source path or conversation identifier. */
    sourceBytesRead: z.number().int().nonnegative(),
    sourceSizeBytes: z.number().int().nonnegative().nullable(),
  }),
  privacy: z.object({
    /** Kept as a boolean so a future adapter cannot hide a wider access mode. */
    fullConversationRead: z.boolean(),
    fullConversationStored: z.literal(false),
    rawConversationStored: z.literal(false),
  }),
  message: z.string().min(1),
});
export type TaskAnalysisResponse = z.infer<typeof taskAnalysisResponseSchema>;

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  startedAt: timestampSchema,
  uptimeMs: z.number().int().nonnegative(),
  db: z.object({
    path: z.string(),
    journalMode: z.string(),
    fileMode: z.string(),
    schemaVersion: z.number().int().nonnegative(),
  }),
  connectorCount: z.number().int().nonnegative(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Server-sent event names on /api/events. */
export const sseEventNameSchema = z.enum([
  'hello',
  'workitem.upserted',
  'workitem.status_changed',
  'coverage.changed',
]);
export type SseEventName = z.infer<typeof sseEventNameSchema>;

export const errorResponseSchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * Reduce per-connector health to one headline value.
 * Order matters: any `down` dominates, then any `degraded`.
 */
export function rollupCoverage(
  connectors: readonly { state: z.infer<typeof coverageHealthSchema>['state'] }[],
): CoverageOverall {
  if (connectors.length === 0) return 'no_connectors';
  if (connectors.some((c) => c.state === 'down')) return 'down';
  if (connectors.some((c) => c.state === 'degraded')) return 'degraded';
  return 'ok';
}
