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
