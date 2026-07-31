import type {
  Status,
  TaskAnalysisField,
  TaskAnalysisResponse,
} from '@session-radar/shared';

type AnalysisResult = NonNullable<TaskAnalysisResponse['result']>;
type SectionKind =
  | 'outcome'
  | 'verified'
  | 'unresolved'
  | 'risks'
  | 'changes'
  | 'next'
  | 'other';

interface Section {
  kind: SectionKind;
  lines: string[];
}

export interface ProjectedSourceResult {
  result: AnalysisResult;
  resolvedFields: TaskAnalysisField[];
  uncertainties: string[];
  recommendedNextStepInferred: boolean;
}

const OUTPUT_TEXT_MAX = 700;
const ITEM_TEXT_MAX = 360;
const LIST_MAX = 6;

/**
 * Deterministically projects a source-authored final response into a compact
 * card. This is deliberately not an LLM claim generator: absent sections stay
 * unknown, and fallback statements remain attributable to the source response.
 */
export function projectSourceResult(
  sourceText: string,
  status: Status,
  requestedFields: readonly TaskAnalysisField[],
): ProjectedSourceResult {
  const cleaned = cleanSourceText(sourceText);
  const { intro, sections, allLines } = parseSections(cleaned);
  const wantsConclusion = requestedFields.includes('final_conclusion');
  const wantsUnresolved = requestedFields.includes('unresolved_items');
  const wantsChanges = requestedFields.includes('code_change_summary');

  const outcome = wantsConclusion ? extractOutcome(intro, sections) : null;
  const verifiedResults = wantsConclusion
    ? extractItems(sections, 'verified') ?? extractVerificationFallback(allLines)
    : null;
  const unresolvedItems = wantsUnresolved ? extractItems(sections, 'unresolved') : null;
  const risksOrBlockers = wantsConclusion ? extractItems(sections, 'risks') : null;
  const codeChangeSummary = wantsChanges ? extractChangeSummary(sections, allLines) : null;

  const sourceNextStep = wantsConclusion ? firstItem(sections, 'next') : null;
  const recommendedNextStep =
    sourceNextStep ??
    (wantsConclusion ? inferredNextStep(status, unresolvedItems) : null);
  const recommendedNextStepInferred =
    wantsConclusion && recommendedNextStep !== null && sourceNextStep === null;

  const resolvedFields: TaskAnalysisField[] = [];
  if (wantsConclusion && outcome !== null) resolvedFields.push('final_conclusion');
  if (wantsUnresolved && unresolvedItems !== null) resolvedFields.push('unresolved_items');
  if (wantsChanges && codeChangeSummary !== null) resolvedFields.push('code_change_summary');

  const uncertainties: string[] = [];
  if (wantsConclusion && outcome === null) {
    uncertainties.push('The selected source result did not contain a concise outcome statement.');
  }
  if (wantsConclusion && verifiedResults === null) {
    uncertainties.push('The selected source result did not state an explicit verification result.');
  }
  if (wantsUnresolved && unresolvedItems === null) {
    uncertainties.push(
      'The selected source result did not explicitly say whether unresolved items remain.',
    );
  }
  if (wantsConclusion && risksOrBlockers === null) {
    uncertainties.push(
      'The selected source result did not explicitly state risks or blockers.',
    );
  }
  if (wantsChanges && codeChangeSummary === null) {
    uncertainties.push('The selected source result did not include a code-change summary.');
  }
  if (recommendedNextStepInferred) {
    uncertainties.push(
      'The recommended next step is inferred from lifecycle state because the source did not state one.',
    );
  }
  if (status !== 'done') {
    uncertainties.push(
      'This task is not currently lifecycle-confirmed as done; the result reflects its latest completed source turn.',
    );
  }

  return {
    result: {
      outcome,
      verifiedResults,
      unresolvedItems,
      risksOrBlockers,
      codeChangeSummary,
      recommendedNextStep,
    },
    resolvedFields,
    uncertainties,
    recommendedNextStepInferred,
  };
}

function cleanSourceText(text: string): string {
  return redactSecrets(
    text
      .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/giu, '')
      .replace(/^::[a-z0-9-]+\{.*\}\s*$/gimu, '')
      .replace(/\r\n?/gu, '\n'),
  ).trim();
}

function redactSecrets(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu,
      '[redacted private key]',
    )
    .replace(/\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{16,})\b/giu, '[redacted token]')
    .replace(/\bBearer\s+[a-z0-9._~+/-]{20,}\b/giu, 'Bearer [redacted token]');
}

function parseSections(text: string): {
  intro: string[];
  sections: Section[];
  allLines: string[];
} {
  const intro: string[] = [];
  const sections: Section[] = [];
  const allLines: string[] = [];
  let current: Section | undefined;
  let inCodeFence = false;

  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (
      inCodeFence ||
      trimmed.length === 0 ||
      isTableDivider(trimmed) ||
      isTableHeader(trimmed)
    ) {
      continue;
    }

    const heading = headingText(trimmed);
    if (heading) {
      current = { kind: classifyHeading(heading), lines: [] };
      sections.push(current);
      continue;
    }

    const line = plainText(trimmed);
    if (line.length === 0) continue;
    allLines.push(line);
    if (current) current.lines.push(line);
    else intro.push(line);
  }

  return { intro, sections, allLines };
}

function headingText(line: string): string | undefined {
  const markdown = /^#{1,6}\s+(.+?)\s*#*$/u.exec(line)?.[1];
  if (markdown) return plainText(markdown);
  const bold = /^\*\*(.{1,90}?)\*\*:?\s*$/u.exec(line)?.[1];
  return bold ? plainText(bold) : undefined;
}

function classifyHeading(heading: string): SectionKind {
  const value = heading.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
  if (/\b(test|tests|testing|validation|verification|verified result|checks?)\b/u.test(value)) {
    return 'verified';
  }
  if (/\b(unresolved|remaining|open items?|outstanding|todo|follow ups?)\b/u.test(value)) {
    return 'unresolved';
  }
  if (/\b(risks?|blockers?|caveats?|limitations?|known issues?)\b/u.test(value)) {
    return 'risks';
  }
  if (/\b(next steps?|recommended next|user action|what you need to do)\b/u.test(value)) {
    return 'next';
  }
  if (/\b(code changes?|changes?|implementation|implemented|files? changed|what changed)\b/u.test(value)) {
    return 'changes';
  }
  if (/\b(outcome|result|summary|current status|status|progress|completed)\b/u.test(value)) {
    return 'outcome';
  }
  return 'other';
}

function extractOutcome(intro: readonly string[], sections: readonly Section[]): string | null {
  const explicit = sectionLines(sections, 'outcome');
  const candidates =
    explicit.length > 0
      ? explicit
      : intro.length > 0
        ? intro
        : sections.find((section) => section.kind === 'changes' || section.kind === 'other')?.lines ?? [];
  return candidates.length > 0 ? cap(candidates.slice(0, 3).join(' '), OUTPUT_TEXT_MAX) : null;
}

function extractItems(
  sections: readonly Section[],
  kind: SectionKind,
): string[] | null {
  const lines = sectionLines(sections, kind);
  if (lines.length === 0) return null;
  if (lines.every(explicitlyNone)) return [];
  const items = lines.filter((line) => !explicitlyNone(line)).slice(0, LIST_MAX);
  return items.length > 0 ? items.map((line) => cap(line, ITEM_TEXT_MAX)) : [];
}

function extractVerificationFallback(lines: readonly string[]): string[] | null {
  const matches = lines.filter((line) =>
    /\b(passed|passing|verified|validated|succeeded|successful|green|healthy|http 200|\d+\s*\/\s*\d+)\b/iu.test(
      line,
    ),
  );
  return matches.length > 0
    ? matches.slice(0, LIST_MAX).map((line) => cap(line, ITEM_TEXT_MAX))
    : null;
}

function extractChangeSummary(
  sections: readonly Section[],
  allLines: readonly string[],
): string | null {
  const explicit = sectionLines(sections, 'changes');
  const fallback = allLines.filter((line) =>
    /\b(added|changed|created|implemented|updated|fixed|removed|refactored)\b/iu.test(line),
  );
  const candidates = explicit.length > 0 ? explicit : fallback;
  return candidates.length > 0
    ? cap(candidates.slice(0, 4).join(' '), OUTPUT_TEXT_MAX)
    : null;
}

function firstItem(sections: readonly Section[], kind: SectionKind): string | null {
  const lines = sectionLines(sections, kind).filter((line) => !explicitlyNone(line));
  return lines[0] ? cap(lines[0], ITEM_TEXT_MAX) : null;
}

function sectionLines(sections: readonly Section[], kind: SectionKind): string[] {
  return sections.filter((section) => section.kind === kind).flatMap((section) => section.lines);
}

function inferredNextStep(status: Status, unresolvedItems: readonly string[] | null): string {
  if (unresolvedItems && unresolvedItems.length > 0) {
    return `Address the first unresolved item: ${cap(unresolvedItems[0] ?? '', 260)}`;
  }
  switch (status) {
    case 'needs_victor':
      return 'Open the original task and answer the pending request.';
    case 'running':
      return 'Let the task continue, then refresh this analysis after its next completed turn.';
    case 'done':
      return 'Review the source result before treating the task as complete.';
    case 'stale':
      return 'Open the original task to decide whether to resume it.';
  }
}

function explicitlyNone(line: string): boolean {
  return /^(?:none|none known|no\b.*|nothing\b.*|n\/a|not applicable)[.!]?$/iu.test(
    plainText(line),
  );
}

function plainText(value: string): string {
  const text = value
    .replace(/^[-*+]\s+/u, '')
    .replace(/^\d+[.)]\s+/u, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/[*_~`]/gu, '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const table = /^\|(.+)\|$/u.exec(text)?.[1];
  return table
    ? table
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(' — ')
    : text;
}

function isTableDivider(line: string): boolean {
  return /^\|?[\s:|-]+\|?$/u.test(line);
}

function isTableHeader(line: string): boolean {
  if (!/^\|.+\|$/u.test(line)) return false;
  const cells = line
    .slice(1, -1)
    .split('|')
    .map((cell) => plainText(cell).toLowerCase());
  return (
    cells.length > 1 &&
    (cells[0] === '#' || cells[0] === 'item' || cells[0] === 'check') &&
    cells.some((cell) => /^(?:status|source|result|contract|test|verification)$/u.test(cell))
  );
}

function cap(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
