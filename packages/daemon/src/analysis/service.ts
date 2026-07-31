import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import type {
  Confidence,
  TaskAnalysisField,
  TaskAnalysisResponse,
  TaskAnalysisStatusResponse,
  WorkItem,
} from '@session-radar/shared';
import {
  claudeProjectsDir,
  listTranscripts,
} from '../connectors/claude-code/transcript.js';
import {
  codexSessionsDir,
  listRollouts,
} from '../connectors/codex/rollout.js';
import { projectSourceResult } from './project.js';
import {
  DEFAULT_ANALYSIS_TAIL_BYTES,
  findNewestJsonRecord,
} from './tail.js';
import {
  AppleFoundationModelsClient,
  type LocalSemanticModel,
  notAttemptedSemanticEnhancement,
  unavailableLocalSemanticAvailability,
} from './apple-model.js';

export interface TaskAnalysis {
  status(): Promise<TaskAnalysisStatusResponse>;
  analyze(
    item: WorkItem,
    requestedFields: readonly TaskAnalysisField[],
  ): Promise<TaskAnalysisResponse>;
}

export interface LocalTaskAnalysisOptions {
  codexDir?: string;
  claudeDir?: string;
  maxTailBytes?: number;
  now?: () => number;
  /** `false` is an explicit deterministic-only test/build mode. */
  semanticModel?: LocalSemanticModel | false;
}

interface SelectedSourceResult {
  text: string;
  at: number | null;
}

interface SourceCandidate {
  path: string;
  sizeBytes: number;
  modifiedAt: number;
}

interface AdapterSelection {
  adapter: string;
  source: string;
  root: string;
  candidates: string[];
  listFiles(): SourceCandidate[];
  select(record: Record<string, unknown>): SelectedSourceResult | undefined;
}

const SESSION_ID = /^[a-z0-9][a-z0-9_-]{5,199}$/iu;
const SOURCE_RESULT_MAX_CHARS = 96 * 1024;
const SEMANTIC_EXCERPT_MAX_CHARS = 16 * 1024;

/**
 * Exact-session, opt-in analysis for the two local result surfaces that expose a
 * stable terminal record today. Nothing is cached or written: each call selects
 * one file, reads a bounded tail, projects it, and releases the raw text.
 */
export class LocalTaskAnalysisService implements TaskAnalysis {
  private readonly codexDir: string;
  private readonly claudeDir: string;
  private readonly maxTailBytes: number;
  private readonly now: () => number;
  private readonly semanticModel: LocalSemanticModel | undefined;

  constructor(options: LocalTaskAnalysisOptions = {}) {
    this.codexDir = options.codexDir ?? codexSessionsDir();
    this.claudeDir = options.claudeDir ?? claudeProjectsDir();
    this.maxTailBytes = options.maxTailBytes ?? DEFAULT_ANALYSIS_TAIL_BYTES;
    this.now = options.now ?? (() => Date.now());
    this.semanticModel =
      options.semanticModel === false
        ? undefined
        : (options.semanticModel ?? new AppleFoundationModelsClient());
  }

  async status(): Promise<TaskAnalysisStatusResponse> {
    const generatedAt = this.now();
    let localSemanticEnhancement = unavailableLocalSemanticAvailability(
      generatedAt,
      'helper_disabled',
      'Local semantic enhancement is disabled in this runtime.',
    );
    if (this.semanticModel) {
      try {
        localSemanticEnhancement = await this.semanticModel.probe();
      } catch {
        localSemanticEnhancement = unavailableLocalSemanticAvailability(
          generatedAt,
          'probe_failed',
          'The Apple on-device availability probe failed. Deterministic analysis remains available.',
        );
      }
    }
    return {
      generatedAt,
      localSemanticEnhancement,
      deterministicFallback: {
        available: true,
        mode: 'bounded_source_projection',
        message:
          'Exact-task bounded source projection remains available without any model.',
      },
      privacy: {
        backgroundAnalysis: false,
        cloudModelsAllowed: false,
        rawTaskContentStored: false,
      },
    };
  }

  async analyze(
    item: WorkItem,
    requestedFields: readonly TaskAnalysisField[],
  ): Promise<TaskAnalysisResponse> {
    const selection = this.selectAdapter(item);
    if (!selection) {
      return this.unavailable(
        item,
        requestedFields,
        'unsupported-source',
        humanSource(item),
        'not_matched',
        0,
        null,
        null,
        'This source does not expose a supported, authorised per-task result adapter.',
      );
    }

    let files: SourceCandidate[];
    try {
      files = selection.listFiles();
    } catch {
      return this.unavailable(
        item,
        requestedFields,
        selection.adapter,
        selection.source,
        'not_matched',
        0,
        null,
        null,
        `The ${selection.source} result store is not currently available to session-radar.`,
      );
    }

    const wanted = new Set(selection.candidates);
    const file = files
      .filter((candidate) => wanted.has(sessionIdFromPath(candidate.path)))
      .filter((candidate) => isSafeRegularFile(selection.root, candidate.path))
      .sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
    if (!file) {
      return this.unavailable(
        item,
        requestedFields,
        selection.adapter,
        selection.source,
        'not_matched',
        0,
        null,
        null,
        `No exact ${selection.source} result file matched this task. No other task was opened.`,
      );
    }

    let found;
    try {
      found = await findNewestJsonRecord(
        file.path,
        file.sizeBytes,
        selection.select,
        this.maxTailBytes,
      );
    } catch {
      return this.unavailable(
        item,
        requestedFields,
        selection.adapter,
        selection.source,
        'exact_session_id',
        0,
        file.sizeBytes,
        file.modifiedAt,
        'The exact source result file became unavailable during this request. No other task was opened.',
      );
    }
    if (!found.value) {
      return this.unavailable(
        item,
        requestedFields,
        selection.adapter,
        selection.source,
        'exact_session_id',
        found.bytesRead,
        file.sizeBytes,
        file.modifiedAt,
        'No completed assistant result was found inside the bounded per-task tail. The read was not widened.',
        ['bounded_source_tail'],
      );
    }

    const truncated = found.value.text.length > SOURCE_RESULT_MAX_CHARS;
    const selectedResult = found.value.text.slice(0, SOURCE_RESULT_MAX_CHARS);
    const projected = projectSourceResult(
      selectedResult,
      item.status,
      requestedFields,
    );
    const conclusionFullyStated =
      !requestedFields.includes('final_conclusion') ||
      (projected.result.verifiedResults !== null &&
        projected.result.risksOrBlockers !== null &&
        projected.result.recommendedNextStep !== null &&
        !projected.recommendedNextStepInferred);
    const complete =
      projected.resolvedFields.length === requestedFields.length &&
      conclusionFullyStated;
    const uncertainties = [...projected.uncertainties];
    if (truncated) {
      uncertainties.push(
        'The selected assistant result exceeded the projection limit; later text was not analysed.',
      );
    }
    const semanticInput = boundedSemanticExcerpt(selectedResult);
    let semanticEnhancement = notAttemptedSemanticEnhancement(
      'Local semantic enhancement is not enabled; the deterministic bounded result is shown.',
    );
    if (this.semanticModel) {
      try {
        semanticEnhancement = await this.semanticModel.enhance({
          excerpt: semanticInput.excerpt,
          lifecycleStatus: item.status,
          inputCharacters: semanticInput.inputCharacters,
          sourceResultCharacters: found.value.text.length,
          inputTruncated:
            semanticInput.inputTruncated ||
            found.value.text.length > SOURCE_RESULT_MAX_CHARS,
          grounding: {
            outcome: projected.result.outcome,
            verifiedResults: projected.result.verifiedResults,
            unresolvedItems: projected.result.unresolvedItems,
            risksOrBlockers: projected.result.risksOrBlockers,
            codeChangeSummary: projected.result.codeChangeSummary,
            recommendedNextStep: projected.result.recommendedNextStep,
            recommendedNextStepInferred:
              projected.recommendedNextStepInferred,
          },
        });
      } catch {
        semanticEnhancement = {
          ...semanticEnhancement,
          status: 'failed',
          message:
            'Local semantic enhancement failed without exposing task content. The deterministic bounded result is shown instead.',
        };
      }
    }

    return {
      workItemId: item.id,
      status: complete ? 'complete' : 'partial',
      generatedAt: this.now(),
      requestedFields: [...requestedFields],
      accessedFields: [...requestedFields],
      result: projected.result,
      semanticEnhancement,
      evidence: [
        {
          kind: 'source_report',
          source: selection.source,
          claim:
            'The structured result was projected from the latest completed assistant response in the exact matched source task.',
          confidence: 'high',
        },
        lifecycleEvidence(item),
        ...(projected.recommendedNextStepInferred
          ? [
              {
                kind: 'inference' as const,
                source: 'session-radar lifecycle interpretation',
                claim:
                  'The recommended next step was inferred from lifecycle state, not stated by the source response.',
                confidence: 'med' as const,
              },
            ]
          : []),
      ],
      uncertainties,
      provenance: {
        adapter: selection.adapter,
        source: selection.source,
        matchedBy: 'exact_session_id',
        accessedMaterial: [
          'bounded_source_tail',
          'final_assistant_response',
          'task_lifecycle_metadata',
        ],
        sourceRecordAt: found.value.at,
        sourceModifiedAt: file.modifiedAt,
        sourceBytesRead: found.bytesRead,
        sourceSizeBytes: found.sourceSizeBytes,
      },
      privacy: {
        fullConversationRead: false,
        fullConversationStored: false,
        rawConversationStored: false,
      },
      message: complete
        ? 'Analysis generated from the exact task’s latest completed source result.'
        : 'Useful source result found; details the source did not state remain unknown.',
    };
  }

  private selectAdapter(item: WorkItem): AdapterSelection | undefined {
    const sourceIds = new Set(item.entryPoints.map((entry) => entry.source.id));
    if ([...sourceIds].some(isCodexSource)) {
      const candidates = sessionCandidates(item, 'openai');
      if (candidates.length === 0) return undefined;
      return {
        adapter: 'codex-rollout-final-result-v1',
        source: codexSourceLabel(sourceIds),
        root: this.codexDir,
        candidates,
        listFiles: () =>
          listRollouts(this.codexDir).map((file) => ({
            path: file.path,
            sizeBytes: file.sizeBytes,
            modifiedAt: file.modifiedAt,
          })),
        select: selectCodexFinalResult,
      };
    }

    if (
      sourceIds.has('claude-code-cli') ||
      sourceIds.has('claude-code-desktop')
    ) {
      const candidates = sessionCandidates(item, 'anthropic');
      if (candidates.length === 0) return undefined;
      return {
        adapter: 'claude-code-transcript-final-result-v1',
        source: sourceIds.has('claude-code-desktop')
          ? 'Claude Code Desktop/CLI transcript'
          : 'Claude Code CLI transcript',
        root: this.claudeDir,
        candidates,
        listFiles: () =>
          listTranscripts(this.claudeDir).map((file) => ({
            path: file.path,
            sizeBytes: file.sizeBytes,
            modifiedAt: file.modifiedAt,
          })),
        select: selectClaudeFinalResult,
      };
    }

    return undefined;
  }

  private unavailable(
    item: WorkItem,
    requestedFields: readonly TaskAnalysisField[],
    adapter: string,
    source: string,
    matchedBy: 'exact_session_id' | 'not_matched',
    sourceBytesRead: number,
    sourceSizeBytes: number | null,
    sourceModifiedAt: number | null,
    reason: string,
    accessedMaterial: TaskAnalysisResponse['provenance']['accessedMaterial'] = [],
  ): TaskAnalysisResponse {
    return {
      workItemId: item.id,
      status: 'unavailable',
      generatedAt: this.now(),
      requestedFields: [...requestedFields],
      accessedFields: [],
      result: null,
      semanticEnhancement: notAttemptedSemanticEnhancement(
        'No supported exact-task result was selected, so no task content was sent to the on-device model.',
      ),
      evidence: [lifecycleEvidence(item)],
      uncertainties: [reason],
      provenance: {
        adapter,
        source,
        matchedBy,
        accessedMaterial: [
          ...accessedMaterial,
          'task_lifecycle_metadata',
        ],
        sourceRecordAt: null,
        sourceModifiedAt,
        sourceBytesRead,
        sourceSizeBytes,
      },
      privacy: {
        fullConversationRead: false,
        fullConversationStored: false,
        rawConversationStored: false,
      },
      message: reason,
    };
  }
}

function boundedSemanticExcerpt(text: string): {
  excerpt: string;
  inputCharacters: number;
  inputTruncated: boolean;
} {
  if (text.length <= SEMANTIC_EXCERPT_MAX_CHARS) {
    return {
      excerpt: text,
      inputCharacters: text.length,
      inputTruncated: false,
    };
  }

  const marker =
    '\n\n[session-radar omitted the middle of this authorised result to stay within the on-device context limit]\n\n';
  const sourceBudget = SEMANTIC_EXCERPT_MAX_CHARS - marker.length;
  const headLength = Math.ceil(sourceBudget / 2);
  const tailLength = sourceBudget - headLength;
  return {
    excerpt: `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`,
    inputCharacters: headLength + tailLength,
    inputTruncated: true,
  };
}

function selectCodexFinalResult(
  record: Record<string, unknown>,
): SelectedSourceResult | undefined {
  if (record['type'] !== 'response_item') return undefined;
  const payload = objectValue(record['payload']);
  if (
    !payload ||
    payload['type'] !== 'message' ||
    payload['role'] !== 'assistant' ||
    payload['phase'] !== 'final_answer'
  ) {
    return undefined;
  }
  const text = textBlocks(payload['content'], 'output_text');
  if (!text) return undefined;
  return { text, at: timestampValue(record['timestamp']) };
}

function selectClaudeFinalResult(
  record: Record<string, unknown>,
): SelectedSourceResult | undefined {
  if (record['type'] !== 'assistant' || record['isSidechain'] === true) return undefined;
  const message = objectValue(record['message']);
  if (
    !message ||
    message['role'] !== 'assistant' ||
    message['stop_reason'] !== 'end_turn'
  ) {
    return undefined;
  }
  const text = textBlocks(message['content'], 'text');
  if (!text) return undefined;
  return { text, at: timestampValue(record['timestamp']) };
}

function textBlocks(value: unknown, expectedType: string): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((block) => {
      const object = objectValue(block);
      return object?.['type'] === expectedType && typeof object['text'] === 'string'
        ? [object['text']]
        : [];
    })
    .join('\n')
    .trim();
  return text || undefined;
}

function sessionCandidates(item: WorkItem, provider: WorkItem['provider']): string[] {
  const values = item.entryPoints
    .filter((entry) => entry.source.provider === provider)
    .map((entry) => entry.externalId);
  const prefix = `${provider}:id:`;
  if (item.canonicalKey.startsWith(prefix)) {
    values.push(item.canonicalKey.slice(prefix.length));
  }
  return [...new Set(values.filter((value) => SESSION_ID.test(value)))];
}

function sessionIdFromPath(path: string): string {
  const name = path.split(sep).at(-1) ?? '';
  const codex =
    /^rollout-.+?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu.exec(
      name,
    )?.[1];
  return codex ?? name.replace(/\.jsonl$/iu, '');
}

function isSafeRegularFile(root: string, path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const rootPath = realpathSync(root);
    const filePath = realpathSync(path);
    const fromRoot = relative(rootPath, filePath);
    return (
      fromRoot.length > 0 &&
      !isAbsolute(fromRoot) &&
      fromRoot !== '..' &&
      !fromRoot.startsWith(`..${sep}`)
    );
  } catch {
    return false;
  }
}

function isCodexSource(sourceId: string): boolean {
  return (
    sourceId === 'codex-cli' ||
    sourceId === 'codex-desktop' ||
    sourceId === 'codex-chrome-sidepanel' ||
    sourceId === 'codex-buzz' ||
    sourceId.startsWith('codex-origin-')
  );
}

function codexSourceLabel(sourceIds: ReadonlySet<string>): string {
  if (sourceIds.has('codex-desktop')) return 'Codex Desktop rollout';
  if (sourceIds.has('codex-cli')) return 'Codex CLI rollout';
  if (sourceIds.has('codex-chrome-sidepanel')) return 'Codex browser rollout';
  if (sourceIds.has('codex-buzz')) return 'Codex via Buzz rollout';
  return 'Codex client rollout';
}

function humanSource(item: WorkItem): string {
  const entry = item.entryPoints[0];
  if (!entry) return 'Unknown task source';
  if (entry.source.id === 'claude-desktop') return 'Claude Desktop chat';
  if (entry.source.id === 'claude-web') return 'Claude web';
  if (entry.source.id === 'chatgpt-desktop') return 'ChatGPT Desktop';
  if (entry.source.id === 'chatgpt-web') return 'ChatGPT web';
  return `${entry.source.provider} ${entry.source.surface}`;
}

function lifecycleEvidence(
  item: WorkItem,
): TaskAnalysisResponse['evidence'][number] {
  const confidence: Confidence = item.currentEvidence?.confidence ?? 'low';
  return {
    kind: 'lifecycle_fact',
    source: 'session-radar lifecycle metadata',
    claim: `The currently observed lifecycle state is ${item.status}; this does not independently prove the source-reported outcome.`,
    confidence,
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function timestampValue(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
