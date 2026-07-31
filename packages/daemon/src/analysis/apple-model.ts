import { spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  LocalSemanticAvailability,
  TaskSemanticEnhancement,
} from '@session-radar/shared';
import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_HELPER_OUTPUT_BYTES = 128 * 1024;
const PROBE_CACHE_MS = 15_000;

const helperAvailabilitySchema = z
  .object({
    state: z.enum(['available', 'unavailable', 'not_ready', 'error']),
    reasonCode: z.string().min(1).max(100),
    message: z.string().min(1).max(1_000),
    locale: z.string().max(100),
    localeSupported: z.boolean().nullable(),
    deviceOnly: z.literal(true),
    cloudUsed: z.literal(false),
    helperVersion: z.string().min(1).max(30),
  })
  .strict();

const helperResultSchema = z
  .object({
    summary: z.string().min(1).max(800),
    outcome: z.string().max(1_200).nullable().optional(),
    verifiedResults: z.array(z.string().max(500)).max(6).nullable().optional(),
    unresolvedItems: z.array(z.string().max(500)).max(6).nullable().optional(),
    risksOrBlockers: z.array(z.string().max(500)).max(6).nullable().optional(),
    codeChangeSummary: z.string().max(1_200).nullable().optional(),
    recommendedNextStep: z.string().max(800).nullable().optional(),
    uncertainties: z.array(z.string().max(500)).max(6),
  })
  .strict();

const helperResponseSchema = z
  .object({
    ok: z.boolean(),
    operation: z.enum(['probe', 'summarize', 'unknown']),
    availability: helperAvailabilitySchema,
    result: helperResultSchema.nullable().optional(),
    errorCode: z.string().max(100).nullable().optional(),
    message: z.string().min(1).max(1_000),
  })
  .strict();

type HelperResponse = z.infer<typeof helperResponseSchema>;
type HelperGeneratedResult = z.infer<typeof helperResultSchema>;
type SemanticResult = NonNullable<TaskSemanticEnhancement['result']>;

interface HelperRequest {
  operation: 'probe' | 'summarize';
  excerpt?: string;
  lifecycleStatus?: string;
  grounding?: SemanticGrounding;
}

export interface SemanticGrounding {
  outcome: string | null;
  verifiedResults: string[] | null;
  unresolvedItems: string[] | null;
  risksOrBlockers: string[] | null;
  codeChangeSummary: string | null;
  recommendedNextStep: string | null;
  recommendedNextStepInferred: boolean;
}

export interface LocalSemanticInput {
  excerpt: string;
  lifecycleStatus: string;
  inputCharacters: number;
  sourceResultCharacters: number;
  inputTruncated: boolean;
  grounding: SemanticGrounding;
}

export interface LocalSemanticModel {
  probe(): Promise<LocalSemanticAvailability>;
  enhance(input: LocalSemanticInput): Promise<TaskSemanticEnhancement>;
}

export interface AppleFoundationModelsOptions {
  helperPath?: string;
  timeoutMs?: number;
  probeCacheMs?: number;
  now?: () => number;
  invoke?: (request: HelperRequest) => Promise<unknown>;
}

export class AppleHelperFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AppleHelperFailure';
  }
}

/**
 * Narrow, process-per-request bridge to Apple's on-device system model.
 *
 * The child receives JSON only on stdin, has no arguments or tools, and its
 * stdout is both byte-capped and schema-checked. Neither side logs raw input or
 * model output. A single in-flight generation avoids Foundation Models'
 * concurrent-request failure mode without creating a background queue.
 */
export class AppleFoundationModelsClient implements LocalSemanticModel {
  private readonly helperPath: string;
  private readonly timeoutMs: number;
  private readonly probeCacheMs: number;
  private readonly now: () => number;
  private readonly invoke: (request: HelperRequest) => Promise<unknown>;
  private cachedProbe:
    | { cachedAt: number; availability: LocalSemanticAvailability }
    | undefined;
  private generationInFlight = false;

  constructor(options: AppleFoundationModelsOptions = {}) {
    this.helperPath = options.helperPath ?? defaultAppleHelperPath();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.probeCacheMs = options.probeCacheMs ?? PROBE_CACHE_MS;
    this.now = options.now ?? (() => Date.now());
    this.invoke =
      options.invoke ??
      ((request) =>
        invokeAppleHelper(this.helperPath, request, this.timeoutMs));
  }

  async probe(): Promise<LocalSemanticAvailability> {
    const now = this.now();
    if (
      this.cachedProbe &&
      now - this.cachedProbe.cachedAt < this.probeCacheMs
    ) {
      return this.cachedProbe.availability;
    }

    let availability: LocalSemanticAvailability;
    try {
      const response = parseHelperResponse(
        await this.invoke({ operation: 'probe' }),
      );
      availability = this.toAvailability(response.availability, now);
    } catch (error) {
      availability = failureAvailability(error, now);
    }
    this.cachedProbe = { cachedAt: now, availability };
    return availability;
  }

  async enhance(input: LocalSemanticInput): Promise<TaskSemanticEnhancement> {
    if (this.generationInFlight) {
      return this.failedEnhancement(
        input,
        'Another on-device analysis is already running. The deterministic result is shown instead.',
        busyAvailability(this.now()),
      );
    }

    this.generationInFlight = true;
    try {
      const checkedAt = this.now();
      const response = parseHelperResponse(
        await this.invoke({
          operation: 'summarize',
          excerpt: input.excerpt,
          lifecycleStatus: input.lifecycleStatus,
          grounding: input.grounding,
        }),
      );
      const availability = this.toAvailability(
        response.availability,
        checkedAt,
      );
      this.cachedProbe = { cachedAt: checkedAt, availability };

      if (!response.ok || !response.result) {
        const status =
          availability.state === 'available' ? 'failed' : 'unavailable';
        return {
          status,
          generatedAt: null,
          availability,
          result: null,
          message: `${response.message} The deterministic bounded result is shown instead.`,
          provenance: semanticProvenance(input),
        };
      }

      const reconciled = reconcileWithDeterministicGrounding(
        response.result,
        input.grounding,
      );
      return {
        status: 'applied',
        generatedAt: this.now(),
        availability,
        result: reconciled.result,
        message:
          reconciled.summaryMode === 'model_grounded'
            ? 'Enhanced on this Mac with Apple Foundation Models. No cloud model was used.'
            : 'The on-device model ran, but its summary exceeded deterministic grounding and was discarded. A concise deterministic fallback is shown.',
        provenance: semanticProvenance(input, reconciled.summaryMode),
      };
    } catch (error) {
      return this.failedEnhancement(
        input,
        `${failureMessage(error)} The deterministic bounded result is shown instead.`,
        failureAvailability(error, this.now()),
      );
    } finally {
      this.generationInFlight = false;
    }
  }

  private toAvailability(
    value: HelperResponse['availability'],
    checkedAt: number,
  ): LocalSemanticAvailability {
    return {
      provider: 'apple_foundation_models',
      state: value.state,
      reasonCode: value.reasonCode,
      message: value.message,
      checkedAt,
      locale: value.locale,
      localeSupported: value.localeSupported,
      deviceOnly: true,
      cloudUsed: false,
      helperVersion: value.helperVersion,
    };
  }

  private failedEnhancement(
    input: LocalSemanticInput,
    message: string,
    availability: LocalSemanticAvailability,
  ): TaskSemanticEnhancement {
    return {
      status:
        availability.state === 'unavailable' ||
        availability.state === 'not_ready'
          ? 'unavailable'
          : 'failed',
      generatedAt: null,
      availability,
      result: null,
      message,
      provenance: semanticProvenance(input),
    };
  }
}

export function unavailableLocalSemanticAvailability(
  checkedAt: number,
  reasonCode = 'helper_not_built',
  message = 'The Apple on-device helper is not available in this build.',
): LocalSemanticAvailability {
  return {
    provider: 'apple_foundation_models',
    state: 'unavailable',
    reasonCode,
    message,
    checkedAt,
    locale: '',
    localeSupported: null,
    deviceOnly: true,
    cloudUsed: false,
    helperVersion: null,
  };
}

export function notAttemptedSemanticEnhancement(
  message: string,
): TaskSemanticEnhancement {
  return {
    status: 'not_attempted',
    generatedAt: null,
    availability: null,
    result: null,
    message,
    provenance: semanticProvenance({
      excerpt: '',
      lifecycleStatus: 'unknown',
      inputCharacters: 0,
      sourceResultCharacters: 0,
      inputTruncated: false,
      grounding: {
        outcome: null,
        verifiedResults: null,
        unresolvedItems: null,
        risksOrBlockers: null,
        codeChangeSummary: null,
        recommendedNextStep: null,
        recommendedNextStepInferred: false,
      },
    }),
  };
}

export function defaultAppleHelperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const builtAlongsideCompiledCode = resolve(
    here,
    '..',
    'bin',
    'session-radar-apple-model',
  );
  if (existsSync(builtAlongsideCompiledCode)) return builtAlongsideCompiledCode;

  // `tsx` executes this file from src/ while the helper still lives in dist/.
  return resolve(
    here,
    '..',
    '..',
    'dist',
    'bin',
    'session-radar-apple-model',
  );
}

export async function invokeAppleHelper(
  helperPath: string,
  request: HelperRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  if (!isExecutableFile(helperPath)) {
    throw new AppleHelperFailure('helper_not_built');
  }

  const payload = JSON.stringify(request);
  return await new Promise<unknown>((resolvePromise, rejectPromise) => {
    let settled = false;
    let outputBytes = 0;
    const chunks: Buffer[] = [];
    const child = spawn(helperPath, [], {
      cwd: dirname(helperPath),
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: helperEnvironment(),
    });

    const finish = (error?: AppleHelperFailure, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new AppleHelperFailure('helper_timeout'));
    }, timeoutMs);
    timer.unref();

    child.once('error', () => {
      finish(new AppleHelperFailure('helper_spawn_failed'));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new AppleHelperFailure('helper_output_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new AppleHelperFailure('helper_failed'));
        return;
      }
      try {
        finish(
          undefined,
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        );
      } catch {
        finish(new AppleHelperFailure('helper_invalid_json'));
      }
    });

    // Deliberately no task text on argv, in the environment, or in a temp file.
    child.stdin.on('error', () => {
      // The exit/close handler produces the stable error; never include input.
    });
    child.stdin.end(payload);
  });
}

function parseHelperResponse(value: unknown): HelperResponse {
  const parsed = helperResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppleHelperFailure('helper_invalid_response');
  }
  return parsed.data;
}

function semanticProvenance(
  input: LocalSemanticInput,
  summaryMode: TaskSemanticEnhancement['provenance']['summaryMode'] = 'not_generated',
): TaskSemanticEnhancement['provenance'] {
  return {
    provider: 'apple_foundation_models',
    model: 'SystemLanguageModel.default',
    execution: 'on_device',
    inputMaterial: 'latest_completed_assistant_response',
    inputCharacters: input.inputCharacters,
    sourceResultCharacters: input.sourceResultCharacters,
    inputTruncated: input.inputTruncated,
    factFieldsGroundedBy: 'deterministic_bounded_projection',
    summaryMode,
    requestScoped: true,
    toolsAvailable: false,
    cloudUsed: false,
    rawInputStored: false,
    rawPromptStored: false,
    rawModelOutputStored: false,
  };
}

function reconcileWithDeterministicGrounding(
  generated: HelperGeneratedResult,
  grounding: SemanticGrounding,
): {
  result: SemanticResult;
  summaryMode: 'model_grounded' | 'deterministic_fallback';
} {
  const grounded = groundedSummary(
    generated.summary,
    [
      grounding.outcome,
      ...(grounding.verifiedResults ?? []),
      ...(grounding.unresolvedItems ?? []),
      ...(grounding.risksOrBlockers ?? []),
      grounding.codeChangeSummary,
    ].filter((value): value is string => value !== null),
  );
  const uncertainties: string[] = [];
  if (grounded.discarded) {
    uncertainties.push(
      'Model-generated summary details outside the deterministic grounding were discarded.',
    );
  }
  if (grounding.recommendedNextStepInferred) {
    uncertainties.push(
      'The recommended next step is a lifecycle-based radar inference, not a source-stated instruction.',
    );
  }
  uncertainties.push(
    'The on-device semantic summary was not independently verified beyond the selected source result.',
  );

  return {
    summaryMode:
      grounded.summary === null ? 'deterministic_fallback' : 'model_grounded',
    result: {
      summary:
        grounded.summary ??
        conciseDeterministicSummary(grounding) ??
        'The selected result did not provide enough grounded detail for a semantic summary.',
      outcome: grounding.outcome,
      verifiedResults: grounding.verifiedResults,
      unresolvedItems: grounding.unresolvedItems,
      risksOrBlockers: grounding.risksOrBlockers,
      codeChangeSummary: grounding.codeChangeSummary,
      recommendedNextStep: grounding.recommendedNextStep,
      uncertainties: [...new Set(uncertainties)].slice(0, 6),
    },
  };
}

function conciseDeterministicSummary(
  grounding: SemanticGrounding,
): string | null {
  const source =
    grounding.outcome ??
    grounding.codeChangeSummary ??
    grounding.verifiedResults?.[0];
  if (!source) return null;
  const sentences =
    source.match(/[^.!?]+[.!?]?/gu)?.map((value) => value.trim()) ?? [];
  return sentences.slice(0, 2).join(' ').slice(0, 800) || null;
}

function groundedSummary(
  generated: string,
  groundingClaims: readonly string[],
): { summary: string | null; discarded: boolean } {
  const normalizedClaims = groundingClaims.map(normalizeExtractiveText);
  const sentences =
    generated.match(/[^.!?]+[.!?]?/gu)?.map((value) => value.trim()) ?? [];
  const matched = sentences.filter((sentence) => {
    const normalizedSentence = normalizeExtractiveText(sentence);
    return (
      normalizedSentence.length > 0 &&
      normalizedClaims.some((claim) => claim.includes(normalizedSentence))
    );
  });
  const accepted = matched.slice(0, 3);
  return {
    summary: accepted.length > 0 ? accepted.join(' ') : null,
    discarded:
      matched.length !== sentences.length || accepted.length !== matched.length,
  };
}

function normalizeExtractiveText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function failureAvailability(
  error: unknown,
  checkedAt: number,
): LocalSemanticAvailability {
  const code =
    error instanceof AppleHelperFailure ? error.code : 'helper_failed';
  const unavailable = code === 'helper_not_built';
  return {
    provider: 'apple_foundation_models',
    state: unavailable ? 'unavailable' : 'error',
    reasonCode: code,
    message: failureMessage(error),
    checkedAt,
    locale: '',
    localeSupported: null,
    deviceOnly: true,
    cloudUsed: false,
    helperVersion: null,
  };
}

function busyAvailability(checkedAt: number): LocalSemanticAvailability {
  return {
    provider: 'apple_foundation_models',
    state: 'error',
    reasonCode: 'model_busy',
    message: 'Another on-device analysis is already running.',
    checkedAt,
    locale: '',
    localeSupported: null,
    deviceOnly: true,
    cloudUsed: false,
    helperVersion: null,
  };
}

function failureMessage(error: unknown): string {
  const code =
    error instanceof AppleHelperFailure ? error.code : 'helper_failed';
  switch (code) {
    case 'helper_not_built':
      return 'Local semantic enhancement is unavailable because the Apple helper was not built.';
    case 'helper_timeout':
      return 'The on-device semantic enhancement timed out.';
    case 'helper_output_too_large':
      return 'The on-device helper returned more data than the safety limit permits.';
    case 'helper_invalid_json':
    case 'helper_invalid_response':
      return 'The on-device helper returned an invalid structured response.';
    case 'helper_spawn_failed':
      return 'The Apple on-device helper could not start on this Mac.';
    default:
      return 'The Apple on-device helper failed without exposing task content.';
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function helperEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    '__CF_USER_TEXT_ENCODING',
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
