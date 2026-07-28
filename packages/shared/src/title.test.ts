import { describe, expect, it } from 'vitest';
import { TITLE_MAX_CHARS } from './config.js';
import { deriveTitle } from './title.js';

describe('deriveTitle — privacy boundary', () => {
  it('never returns more than TITLE_MAX_CHARS characters', () => {
    const long = 'a'.repeat(5_000);
    const title = deriveTitle(long);
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(TITLE_MAX_CHARS).toBe(120);
  });

  it('marks truncation so a clipped title is never mistaken for the whole prompt', () => {
    const title = deriveTitle('b'.repeat(500));
    expect(title.endsWith('…')).toBe(true);
  });

  it('leaves short prompts intact', () => {
    expect(deriveTitle('Fix the flaky test')).toBe('Fix the flaky test');
  });

  it('collapses newlines so a multi-line prompt cannot leak extra structure', () => {
    expect(deriveTitle('line one\nline two\n\tline three')).toBe('line one line two line three');
  });

  it('strips control characters', () => {
    const withControls = `hello${String.fromCharCode(0)}${String.fromCharCode(7)}world`;
    expect(deriveTitle(withControls)).toBe('hello world');
  });

  it('falls back when there is no readable first message', () => {
    expect(deriveTitle(null)).toBe('Untitled session');
    expect(deriveTitle(undefined)).toBe('Untitled session');
    expect(deriveTitle('   ')).toBe('Untitled session');
  });

  it('accepts a caller-supplied fallback such as the repo name', () => {
    expect(deriveTitle('', { fallback: 'billing (cli)' })).toBe('billing (cli)');
  });

  it('honours a tighter cap when asked', () => {
    const title = deriveTitle('x'.repeat(100), { maxChars: 10 });
    expect(title.length).toBeLessThanOrEqual(10);
  });

  it('does not leave a dangling space before the ellipsis', () => {
    const title = deriveTitle(`${'word '.repeat(50)}`, { maxChars: 11 });
    expect(title).not.toContain(' …');
  });
});
