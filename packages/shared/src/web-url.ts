/**
 * Zod-free web helpers.
 *
 * Split out so the Chrome extension can import site constants and URL parsing
 * without pulling zod into a content script that runs on every claude.ai and
 * chatgpt.com page load. Importing the barrel cost 130 kB; this costs ~2 kB.
 */

/** One connector per site: claude.ai selectors can rot without chatgpt.com's doing so. */
export type WebSite = 'claude-web' | 'chatgpt-web';

export const WEB_SITES: readonly WebSite[] = ['claude-web', 'chatgpt-web'];

export const WEB_SITE_LABELS: Record<WebSite, string> = {
  'claude-web': 'claude.ai (extension)',
  'chatgpt-web': 'chatgpt.com (extension)',
};

export const WEB_SITE_PROVIDERS: Record<WebSite, 'anthropic' | 'openai'> = {
  'claude-web': 'anthropic',
  'chatgpt-web': 'openai',
};

/**
 * The extension's stable id, derived from the public key embedded in its
 * manifest. Pinning it means the daemon allowlists exactly one extension rather
 * than trusting anything that calls itself an extension.
 */
export const SESSION_RADAR_EXTENSION_ID = 'mdbfiohpejlnjbeebkmplfhiommkaonf';

export function extensionOrigin(id: string = SESSION_RADAR_EXTENSION_ID): string {
  return `chrome-extension://${id}`;
}

/** Deep links back into the conversation. */
export function webConversationUrl(site: WebSite, conversationId: string): string {
  return site === 'claude-web'
    ? `https://claude.ai/chat/${conversationId}`
    : `https://chatgpt.com/c/${conversationId}`;
}

/**
 * Conversation id from a URL, or undefined when the page is not a conversation
 * (a new chat, a settings page, the project list).
 */
export function conversationIdFromUrl(rawUrl: string): { site: WebSite; id: string } | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }

  const segments = url.pathname.split('/').filter(Boolean);

  if (url.hostname === 'claude.ai' || url.hostname.endsWith('.claude.ai')) {
    // /chat/<uuid> and /project/<id>/chat/<uuid>
    const index = segments.lastIndexOf('chat');
    const id = index >= 0 ? segments[index + 1] : undefined;
    if (id) return { site: 'claude-web', id };
    // Cross-device agent/Cowork sessions use /cowork/<session-id>. Project
    // collection routes (/cowork/project/<id>) are not conversations.
    if (segments[0] === 'cowork' && segments[1] && segments[1] !== 'project') {
      return { site: 'claude-web', id: segments[1] };
    }
    return undefined;
  }

  if (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com')) {
    // /c/<uuid>, and Codex web lives under /codex/<id>
    if (segments[0] === 'c' && segments[1]) return { site: 'chatgpt-web', id: segments[1] };
    if (segments[0] === 'codex' && segments[1]) return { site: 'chatgpt-web', id: segments[1] };
    return undefined;
  }

  return undefined;
}
