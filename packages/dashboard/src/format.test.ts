import { describe, expect, it } from 'vitest';
import type { CoverageHealth, WorkItem } from '@session-radar/shared';
import {
  absoluteTime,
  PROVIDER_LABELS,
  relativeTime,
  sourceBadges,
  webExtensionReloadRequired,
} from './format.js';

describe('dashboard time formatting', () => {
  it('does not present missing source time as an ancient or current timestamp', () => {
    expect(relativeTime(0, 1_800_000_000_000)).toBe('time unknown');
    expect(absoluteTime(0)).toBe('Time unknown');
  });

  it('keeps ordinary relative formatting for valid timestamps', () => {
    expect(relativeTime(1_800_000_000_000 - 5 * 60_000, 1_800_000_000_000)).toBe(
      '5m ago',
    );
  });

  it('labels newly supported interface-owned providers without calling them OpenAI', () => {
    const item = {
      entryPoints: [
        {
          source: {
            id: 'cursor-desktop',
            provider: 'cursor',
            surface: 'desktop',
          },
        },
      ],
    } as WorkItem;
    expect(PROVIDER_LABELS.cursor).toBe('Cursor');
    expect(sourceBadges(item)).toEqual(['Cursor agent']);
  });

  it('recognises the old-extension state that needs a protected-page reload', () => {
    const connector = {
      connectorId: 'chatgpt-web',
      state: 'degraded',
      lastError:
        'the extension reported v0.0.1 with no history inventory — reload the updated unpacked extension, then refresh the open tabs',
    } as CoverageHealth;
    expect(webExtensionReloadRequired([connector])).toBe(true);
    expect(
      webExtensionReloadRequired([
        { ...connector, connectorId: 'chatgpt-desktop' },
      ]),
    ).toBe(false);
    expect(
      webExtensionReloadRequired([{ ...connector, state: 'ok', lastError: null }]),
    ).toBe(false);
  });
});
