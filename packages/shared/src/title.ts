/**
 * Title derivation — and the enforcement point for the one content-reading
 * exception in this product.
 *
 * We are allowed to read the first `TITLE_MAX_CHARS` characters of the first user
 * message, locally, purely to build a display title. Nothing longer is ever
 * returned by this function, so nothing longer can end up in the database.
 */
import { TITLE_MAX_CHARS } from './config.js';

const ELLIPSIS = '…';
const SPACE_CODE = 0x20;
const DELETE_CODE = 0x7f;

/**
 * Control characters (including newlines and tabs) become spaces so a title is
 * always a single line. Done by code point rather than a regex character class to
 * keep literal control bytes out of this source file.
 */
function flattenControlChars(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code < SPACE_CODE || code === DELETE_CODE ? ' ' : char;
  }
  return out;
}

/**
 * Whether a piece of text is machine-injected rather than something a human
 * typed, and therefore unusable as a title.
 *
 * Both CLIs put synthetic content in the user role: tag blocks
 * (`<system-reminder>`, `<recommended_plugins>`), markdown context dumps
 * (`# Files mentioned by the user:`), and plugin system prompts
 * (`[Base] You are operating inside ...`). Titling on those produced pages of
 * identical, useless rows — worse than no title, because they look like data.
 */
export function isInjectedContext(text: string): boolean {
  const head = text.trimStart();
  if (head.length === 0) return true;
  // <tag> ... — injected context block
  if (/^<[a-zA-Z][a-zA-Z0-9_-]*>/.test(head)) return true;
  // # Heading — a context dump, not a request
  if (head.startsWith('#')) return true;
  // [Base] / [System] prefixed platform prompts
  if (/^\[[^\]]{1,32}\]/.test(head)) return true;
  // Role-setting preambles
  if (/^You are (a|an|operating|working)\b/i.test(head)) return true;
  return false;
}

/**
 * Codex/Claude may wrap an attachment turn in a generated markdown preamble:
 *
 *   # Files mentioned by the user:
 *   ...
 *   ## My request for Codex:
 *   <the text the user actually typed>
 *
 * Keep the request and discard the generated file inventory. If the marker is
 * absent, return the original text so the normal injected-context guard can
 * reject the whole block.
 */
export function extractUserAuthoredText(text: string): string | undefined {
  const head = text.trimStart();
  if (!head.startsWith('# Files mentioned by the user:')) return text;

  const marker = /(?:^|\n)## My request for [^:\n]{1,40}:[ \t]*(?:\r?\n|$)/gi;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | undefined;
  while ((match = marker.exec(head)) !== null) last = match;
  if (!last) return undefined;

  const request = head.slice((last.index ?? 0) + last[0].length).trim();
  return request.length > 0 ? request : undefined;
}

/**
 * Label for a session whose prompt yielded no usable title.
 *
 * Includes a short session-id suffix because "which of these eight `.buzz` rows
 * is which?" is a real question — an ambiguous title is barely better than none.
 */
export function fallbackLabel(context: string | undefined, sessionId: string): string {
  // The SUFFIX, not the prefix: Codex uses time-ordered (v7) UUIDs, so sessions
  // started minutes apart share a leading prefix and would collide again.
  const short = sessionId.replace(/-/g, '').slice(-8);
  const where = context && context.trim().length > 0 ? context.trim() : 'session';
  return `${where} · ${short}`;
}

export interface DeriveTitleOptions {
  maxChars?: number;
  fallback?: string;
}

export function deriveTitle(
  firstUserMessage: string | null | undefined,
  options: DeriveTitleOptions = {},
): string {
  const maxChars = options.maxChars ?? TITLE_MAX_CHARS;
  const fallback = options.fallback ?? 'Untitled session';

  if (typeof firstUserMessage !== 'string') return fallback;

  const normalized = flattenControlChars(firstUserMessage).replace(/\s+/g, ' ').trim();

  if (normalized.length === 0) return fallback;
  if (normalized.length <= maxChars) return normalized;
  // Strictly under the cap once the ellipsis is counted.
  return `${normalized.slice(0, maxChars - 1).trimEnd()}${ELLIPSIS}`;
}
