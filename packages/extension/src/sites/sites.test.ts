// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { conversationIdFromUrl } from '@session-radar/shared/pure';
import { chatgptAdapter } from './chatgpt.js';
import { claudeAdapter } from './claude.js';

function doc(html: string): Document {
  const parser = new DOMParser();
  return parser.parseFromString(`<html><body>${html}</body></html>`, 'text/html');
}

const CLAUDE_URL = 'https://claude.ai/chat/abc-123';
const CHATGPT_URL = 'https://chatgpt.com/c/def-456';

/** A conversation page with nothing special happening. */
const CLAUDE_IDLE = `
  <div data-testid="message-1">hello</div>
  <div contenteditable="true"></div>
  <button aria-label="Send message"></button>
`;

const CHATGPT_IDLE = `
  <div data-message-author-role="assistant">hello</div>
  <div id="prompt-textarea" contenteditable="true"></div>
  <button data-testid="send-button"></button>
`;

describe('conversation id parsing', () => {
  it('reads claude.ai chat urls', () => {
    expect(conversationIdFromUrl(CLAUDE_URL)).toEqual({ site: 'claude-web', id: 'abc-123' });
  });

  it('reads a claude.ai project chat url', () => {
    expect(conversationIdFromUrl('https://claude.ai/project/p1/chat/abc-123')).toEqual({
      site: 'claude-web',
      id: 'abc-123',
    });
  });

  it('reads chatgpt.com conversation urls', () => {
    expect(conversationIdFromUrl(CHATGPT_URL)).toEqual({ site: 'chatgpt-web', id: 'def-456' });
  });

  it('reads Codex web urls, which live on chatgpt.com', () => {
    expect(conversationIdFromUrl('https://chatgpt.com/codex/task-9')).toEqual({
      site: 'chatgpt-web',
      id: 'task-9',
    });
  });

  it('returns undefined for pages that are not conversations', () => {
    expect(conversationIdFromUrl('https://claude.ai/new')).toBeUndefined();
    expect(conversationIdFromUrl('https://chatgpt.com/')).toBeUndefined();
    expect(conversationIdFromUrl('https://example.com/chat/x')).toBeUndefined();
    expect(conversationIdFromUrl('not a url')).toBeUndefined();
  });
});

describe('claude.ai adapter', () => {
  it('matches only claude.ai conversation urls', () => {
    expect(claudeAdapter.matches(CLAUDE_URL)).toBe(true);
    expect(claudeAdapter.matches(CHATGPT_URL)).toBe(false);
    expect(claudeAdapter.matches('https://claude.ai/new')).toBe(false);
  });

  it('reports generating while a stop button is present', () => {
    const observation = claudeAdapter.detect(
      doc(`${CLAUDE_IDLE}<button aria-label="Stop response"></button>`),
      CLAUDE_URL,
    );
    expect(observation.state).toBe('generating');
    expect(observation.basis).toContain('stop button');
  });

  it('reports completed when messages are rendered and nothing is streaming', () => {
    expect(claudeAdapter.detect(doc(CLAUDE_IDLE), CLAUDE_URL).state).toBe('completed');
  });

  it('a login wall outranks everything else on the page', () => {
    const observation = claudeAdapter.detect(
      doc(`${CLAUDE_IDLE}<input type="password">`),
      CLAUDE_URL,
    );
    expect(observation.state).toBe('blocked');
    expect(observation.blockReason).toBe('login_wall');
  });

  it('detects a tool permission prompt as blocking', () => {
    const observation = claudeAdapter.detect(
      doc(`${CLAUDE_IDLE}<div data-testid="tool-approval-request"></div>`),
      CLAUDE_URL,
    );
    expect(observation.state).toBe('blocked');
    expect(observation.blockReason).toBe('tool_permission');
  });

  it('blocking beats generating — a prompt during a stream still needs Victor', () => {
    const observation = claudeAdapter.detect(
      doc(`${CLAUDE_IDLE}<button aria-label="Stop response"></button><div data-testid="tool-approval"></div>`),
      CLAUDE_URL,
    );
    expect(observation.state).toBe('blocked');
  });

  it('says UNKNOWN rather than "completed" when it recognises nothing', () => {
    // This is the rot case. Reporting `completed` here would be a confident lie.
    const observation = claudeAdapter.detect(doc('<div class="totally-redesigned"></div>'), CLAUDE_URL);
    expect(observation.state).toBe('unknown');
  });
});

describe('chatgpt.com adapter', () => {
  it('reports generating on a stop button', () => {
    expect(
      chatgptAdapter.detect(doc(`${CHATGPT_IDLE}<button data-testid="stop-button"></button>`), CHATGPT_URL)
        .state,
    ).toBe('generating');
  });

  it('reports completed on rendered messages', () => {
    expect(chatgptAdapter.detect(doc(CHATGPT_IDLE), CHATGPT_URL).state).toBe('completed');
  });

  it('detects a rate limit notice as blocking', () => {
    const observation = chatgptAdapter.detect(
      doc(`${CHATGPT_IDLE}<div data-testid="rate-limit-banner"></div>`),
      CHATGPT_URL,
    );
    expect(observation.state).toBe('blocked');
    expect(observation.blockReason).toBe('rate_limit');
  });

  it('says UNKNOWN on an unrecognised page', () => {
    expect(chatgptAdapter.detect(doc('<main></main>'), CHATGPT_URL).state).toBe('unknown');
  });
});

describe('selector self-test — the rot detector', () => {
  it('reports no missing anchors on a healthy page', () => {
    const health = claudeAdapter.selfTest(doc(CLAUDE_IDLE));
    expect(health.missing).toEqual([]);
    expect(health.found).toContain('composer');
    expect(health.found).toContain('message');
  });

  it('names exactly which anchors vanished when the DOM changes', () => {
    const health = claudeAdapter.selfTest(doc('<div class="new-design"></div>'));
    expect(health.missing).toContain('composer');
    expect(health.missing).toContain('message');
  });

  it('does NOT treat a transient anchor as rot', () => {
    // The stop button is absent whenever nothing is streaming — that is normal,
    // not a broken selector, and must never raise a false alarm.
    const health = claudeAdapter.selfTest(doc(CLAUDE_IDLE));
    expect(health.missing).not.toContain('stop-button');
  });

  it('carries a version so a fix is identifiable in coverage', () => {
    expect(claudeAdapter.selfTest(doc(CLAUDE_IDLE)).selectorsVersion).toBe(
      claudeAdapter.selectorsVersion,
    );
    expect(chatgptAdapter.selectorsVersion).toMatch(/^\d{4}\.\d{2}\.\d{2}/);
  });

  it('both sites are self-testable independently', () => {
    const claudeHealth = claudeAdapter.selfTest(doc(CLAUDE_IDLE));
    const chatgptHealth = chatgptAdapter.selfTest(doc(CLAUDE_IDLE));
    expect(claudeHealth.missing).toEqual([]);
    // The claude page does not satisfy chatgpt's anchors, and it says so.
    expect(chatgptHealth.missing.length).toBeGreaterThan(0);
  });
});
