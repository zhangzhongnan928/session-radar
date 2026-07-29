import { describe, expect, it } from 'vitest';
import {
  collectChatGptAccountInventory,
  collectClaudeAccountInventory,
  collectClaudeAgentInventory,
  projectClaudeAgentSession,
  projectClaudeConversation,
  projectConversation,
} from './page-inventory.js';

const CLAUDE_ORG_A = '10000000-0000-4000-8000-000000000001';
const CLAUDE_ORG_B = '10000000-0000-4000-8000-000000000002';
const CLAUDE_ORG_NON_CHAT = '10000000-0000-4000-8000-000000000003';
const CLAUDE_CONVERSATION_A = '20000000-0000-4000-8000-000000000001';
const CLAUDE_CONVERSATION_B = '20000000-0000-4000-8000-000000000002';
const CLAUDE_CONVERSATION_C = '20000000-0000-4000-8000-000000000003';
const CLAUDE_CONVERSATION_D = '20000000-0000-4000-8000-000000000004';
const CLAUDE_AGENT_A = 'session_01AgentRunning00000000000';
const CLAUDE_AGENT_B = 'session_01AgentPaused000000000000';
const CLAUDE_AGENT_C = 'session_01AgentArchived0000000000';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ChatGPT account inventory projection', () => {
  it('paginates active and archived metadata without retaining unknown fields', async () => {
    const calls: string[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      const archived = url.includes('is_archived=true');
      return json({
        items: archived
          ? [
              {
                id: 'archived-1',
                title: 'Old planning',
                update_time: 1_700_000_000,
                is_archived: true,
                mapping: null,
                snippet: null,
                unrelated_vendor_field: 'stripped',
              },
            ]
          : [
              {
                id: 'active-1',
                title: '  Current   work  ',
                update_time: 1_800_000_000,
                is_archived: false,
                async_status: 3,
                mapping: null,
                snippet: null,
              },
              {
                id: 'active-2',
                title: null,
                create_time: '2026-07-01T00:00:00.000Z',
                is_archived: false,
              },
            ],
        total: archived ? 1 : 2,
        limit: archived ? 30 : 28,
        offset: 0,
      });
    };

    const inventory = await collectChatGptAccountInventory(
      fetcher,
      1_900_000_000_000,
    );

    expect(inventory.completeness).toBe('complete');
    expect(inventory.advertisedTotal).toBe(3);
    expect(inventory.items).toHaveLength(3);
    expect(inventory.items.find((item) => item.conversationId === 'active-1')).toEqual({
      conversationId: 'active-1',
      title: 'Current work',
      url: 'https://chatgpt.com/c/active-1',
      updatedAt: 1_800_000_000_000,
      archived: false,
      asyncStatus: 3,
    });
    expect(JSON.stringify(inventory)).not.toContain('unrelated_vendor_field');
    expect(calls).toEqual([
      '/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false',
      '/backend-api/conversations?offset=0&limit=30&order=updated&is_archived=true',
    ]);
  });

  it('rejects a row if a content-bearing field unexpectedly becomes non-null', async () => {
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const archived = String(input).includes('is_archived=true');
      return json({
        items: archived
          ? []
          : [
              {
                id: 'unsafe',
                title: 'Do not ingest',
                mapping: { node: 'message content would live here' },
                is_archived: false,
              },
            ],
        total: archived ? 0 : 1,
        limit: archived ? 30 : 28,
        offset: 0,
      });
    };

    const inventory = await collectChatGptAccountInventory(fetcher);
    expect(inventory.items).toEqual([]);
    expect(inventory.rejectedItems).toBe(1);
    expect(inventory.completeness).toBe('partial');
  });

  it('reports unavailable instead of an empty complete archive on auth failure', async () => {
    const inventory = await collectChatGptAccountInventory(
      async () => json({ error: 'unauthorized' }, 401),
    );
    expect(inventory.completeness).toBe('unavailable');
    expect(inventory.items).toEqual([]);
    expect(inventory.error).toMatch(/HTTP 401/);
  });

  it('does not guess unknown async enum values', () => {
    expect(
      projectConversation(
        {
          id: 'bad-enum',
          is_archived: false,
          async_status: 99,
        },
        false,
      ),
    ).toBeUndefined();
  });
});

describe('Claude account inventory projection', () => {
  function bootstrap(): Record<string, unknown> {
    return {
      resolved_org_uuid: CLAUDE_ORG_B,
      account: {
        is_verified: true,
        memberships: [
          {
            organization: {
              uuid: CLAUDE_ORG_A,
              capabilities: ['chat'],
              name: 'stripped organization name',
            },
          },
          {
            organization: {
              uuid: CLAUDE_ORG_B,
              capabilities: ['chat', 'raven'],
            },
          },
          {
            organization: {
              uuid: CLAUDE_ORG_NON_CHAT,
              capabilities: ['api'],
            },
          },
        ],
        email_address: 'stripped@example.test',
      },
      personalized_greeting: 'stripped bootstrap prose',
      system_prompts: null,
    };
  }

  it('paginates starred and non-starred metadata across chat organizations', async () => {
    const calls: string[] = [];
    const privateSummary = 'private generated summary that must not cross the bridge';
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('/api/bootstrap?')) return json(bootstrap());

      const isResolvedOrganization = url.includes(CLAUDE_ORG_B);
      const starred = url.includes('starred=true');
      const secondPage = url.includes('offset=30');
      if (!isResolvedOrganization) return json({ data: [], has_more: false });
      if (starred) {
        return json({
          data: [
            {
              uuid: CLAUDE_CONVERSATION_D,
              name: 'Starred work',
              summary: privateSummary,
              created_at: '2026-07-01T00:00:00.000Z',
              updated_at: '2026-07-04T00:00:00.000Z',
              is_starred: true,
              settings: { stripped: true },
            },
          ],
          has_more: false,
        });
      }
      if (secondPage) {
        return json({
          data: [
            {
              uuid: CLAUDE_CONVERSATION_C,
              name: null,
              summary: null,
              created_at: '2026-07-03T00:00:00.000Z',
              is_starred: false,
            },
          ],
          has_more: false,
        });
      }
      return json({
        data: [
          {
            uuid: CLAUDE_CONVERSATION_A,
            name: '  Current   Claude work  ',
            summary: privateSummary,
            created_at: '2026-07-01T00:00:00.000Z',
            updated_at: '2026-07-02T00:00:00.000Z',
            is_starred: false,
            unrelated_vendor_field: 'stripped',
          },
          {
            uuid: CLAUDE_CONVERSATION_B,
            name: 'Second conversation',
            summary: '',
            updated_at: '2026-07-03T00:00:00.000Z',
            is_starred: false,
          },
        ],
        has_more: true,
      });
    };

    const inventory = await collectClaudeAccountInventory(
      fetcher,
      1_900_000_000_000,
    );

    expect(inventory.completeness).toBe('complete');
    expect(inventory.items).toHaveLength(4);
    expect(
      inventory.items.find(
        (item) => item.conversationId === CLAUDE_CONVERSATION_A,
      ),
    ).toEqual({
      conversationId: CLAUDE_CONVERSATION_A,
      title: 'Current Claude work',
      url: `https://claude.ai/chat/${CLAUDE_CONVERSATION_A}`,
      updatedAt: Date.parse('2026-07-02T00:00:00.000Z'),
      archived: false,
    });
    expect(JSON.stringify(inventory)).not.toContain(privateSummary);
    expect(JSON.stringify(inventory)).not.toContain('stripped organization name');
    expect(JSON.stringify(inventory)).not.toContain('stripped@example.test');
    expect(JSON.stringify(inventory)).not.toContain('unrelated_vendor_field');
    expect(calls).toEqual([
      '/api/bootstrap?statsig_hashing_algorithm=djb2&growthbook_format=sdk&include_system_prompts=false',
      `/api/organizations/${CLAUDE_ORG_B}/chat_conversations_v2?limit=30&offset=0&starred=false&consistency=strong`,
      `/api/organizations/${CLAUDE_ORG_B}/chat_conversations_v2?limit=30&offset=30&starred=false&consistency=strong`,
      `/api/organizations/${CLAUDE_ORG_B}/chat_conversations_v2?limit=30&offset=0&starred=true&consistency=strong`,
      `/api/organizations/${CLAUDE_ORG_A}/chat_conversations_v2?limit=30&offset=0&starred=false&consistency=strong`,
      `/api/organizations/${CLAUDE_ORG_A}/chat_conversations_v2?limit=30&offset=0&starred=true&consistency=strong`,
    ]);
  });

  it('enumerates chat memberships when bootstrap omits the retired resolved organization field', async () => {
    const currentBootstrap = bootstrap();
    delete currentBootstrap['resolved_org_uuid'];
    const calls: string[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('/api/bootstrap?')) return json(currentBootstrap);
      return json({ data: [], has_more: false });
    };

    const inventory = await collectClaudeAccountInventory(fetcher);

    expect(inventory.completeness).toBe('complete');
    expect(inventory.items).toEqual([]);
    expect(inventory.basis).toContain('across 2 chat organization(s)');
    expect(calls).toEqual([
      '/api/bootstrap?statsig_hashing_algorithm=djb2&growthbook_format=sdk&include_system_prompts=false',
      `/api/organizations/${CLAUDE_ORG_A}/chat_conversations_v2?limit=30&offset=0&starred=false&consistency=strong`,
      `/api/organizations/${CLAUDE_ORG_A}/chat_conversations_v2?limit=30&offset=0&starred=true&consistency=strong`,
      `/api/organizations/${CLAUDE_ORG_B}/chat_conversations_v2?limit=30&offset=0&starred=false&consistency=strong`,
      `/api/organizations/${CLAUDE_ORG_B}/chat_conversations_v2?limit=30&offset=0&starred=true&consistency=strong`,
    ]);
  });

  it('still rejects a malformed resolved organization when the field is present', async () => {
    const malformedBootstrap = bootstrap();
    malformedBootstrap['resolved_org_uuid'] = 'not-an-organization-uuid';

    const inventory = await collectClaudeAccountInventory(async () =>
      json(malformedBootstrap),
    );

    expect(inventory.completeness).toBe('unavailable');
    expect(inventory.items).toEqual([]);
    expect(inventory.error).toMatch(/resolved organization is invalid/);
  });

  it('rejects unexpected message structures while dropping the known summary field', async () => {
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.startsWith('/api/bootstrap?')) {
        return json({
          resolved_org_uuid: CLAUDE_ORG_A,
          account: {
            is_verified: true,
            memberships: [
              {
                organization: {
                  uuid: CLAUDE_ORG_A,
                  capabilities: ['chat'],
                },
              },
            ],
          },
        });
      }
      if (url.includes('starred=true')) return json({ data: [], has_more: false });
      return json({
        data: [
          {
            uuid: CLAUDE_CONVERSATION_A,
            name: 'Unsafe row',
            summary: 'known list summary is stripped',
            messages: [{ text: 'unexpected message body' }],
            is_starred: false,
          },
        ],
        has_more: false,
      });
    };

    const inventory = await collectClaudeAccountInventory(fetcher);
    expect(inventory.items).toEqual([]);
    expect(inventory.rejectedItems).toBe(1);
    expect(inventory.completeness).toBe('partial');
  });

  it('reports unavailable when bootstrap cannot prove a verified chat organization', async () => {
    const inventory = await collectClaudeAccountInventory(async () =>
      json({
        resolved_org_uuid: CLAUDE_ORG_A,
        account: {
          is_verified: false,
          memberships: [],
        },
      }),
    );
    expect(inventory.completeness).toBe('unavailable');
    expect(inventory.items).toEqual([]);
    expect(inventory.error).toMatch(/not verified/);
  });

  it('does not call a truncated final page complete when the safety cap is reached', async () => {
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.startsWith('/api/bootstrap?')) {
        return json({
          resolved_org_uuid: CLAUDE_ORG_A,
          account: {
            is_verified: true,
            memberships: [
              {
                organization: {
                  uuid: CLAUDE_ORG_A,
                  capabilities: ['chat'],
                },
              },
            ],
          },
        });
      }
      return json({
        data: [
          {
            uuid: CLAUDE_CONVERSATION_A,
            is_starred: false,
          },
          {
            uuid: CLAUDE_CONVERSATION_B,
            is_starred: false,
          },
        ],
        has_more: false,
      });
    };

    const inventory = await collectClaudeAccountInventory(fetcher, Date.now(), 1);
    expect(inventory.items).toHaveLength(1);
    expect(inventory.completeness).toBe('partial');
    expect(inventory.error).toMatch(/cap 1 reached/);
  });

  it('does not trust a row whose star filter or summary shape drifted', () => {
    expect(
      projectClaudeConversation(
        {
          uuid: CLAUDE_CONVERSATION_A,
          is_starred: true,
        },
        false,
      ),
    ).toBeUndefined();
    expect(
      projectClaudeConversation(
        {
          uuid: CLAUDE_CONVERSATION_A,
          is_starred: false,
          summary: { unexpected: 'object' },
        },
        false,
      ),
    ).toBeUndefined();
  });
});

describe('Claude Code/Cowork account inventory projection', () => {
  function bootstrap(): Record<string, unknown> {
    return {
      resolved_org_uuid: CLAUDE_ORG_B,
      account: {
        is_verified: true,
        memberships: [
          {
            organization: {
              uuid: CLAUDE_ORG_A,
              capabilities: ['chat'],
            },
          },
          {
            organization: {
              uuid: CLAUDE_ORG_B,
              capabilities: ['chat', 'raven'],
            },
          },
        ],
      },
    };
  }

  it('paginates active/paused and archived sessions with required first-party headers', async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const privateTaskSummary = 'private task summary that must be stripped';
    const fetcher = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.startsWith('/api/bootstrap?')) return json(bootstrap());
      calls.push({ url, headers: new Headers(init?.headers) });

      const resolved = init
        ?.headers instanceof Headers
        ? init.headers.get('x-organization-uuid') === CLAUDE_ORG_B
        : new Headers(init?.headers).get('x-organization-uuid') === CLAUDE_ORG_B;
      if (!resolved) return json({ data: [], next_cursor: null });
      if (url.includes('statuses=archived')) {
        return json({
          data: [
            {
              id: CLAUDE_AGENT_C,
              title: 'Archived agent task',
              status: 'archived',
              worker_status: 'idle',
              connection_status: 'disconnected',
              environment_kind: 'anthropic_cloud',
              created_at: '2026-07-01T00:00:00.000Z',
              last_event_at: '2026-07-02T00:00:00.000Z',
              config: {
                origin: 'web_claude_ai',
                sources: [{ private: 'source configuration' }],
              },
              external_metadata: {
                task_summary: privateTaskSummary,
              },
            },
          ],
          next_cursor: null,
          resume_token: 'must not cross the bridge',
        });
      }
      if (url.includes('cursor=cursor-one')) {
        return json({
          data: [
            {
              id: CLAUDE_AGENT_B,
              title: 'Paused mobile task',
              status: 'paused',
              worker_status: 'idle',
              connection_status: 'disconnected',
              environment_kind: 'anthropic_cloud',
              unread: true,
              created_at: '2026-07-02T00:00:00.000Z',
              updated_at: '2026-07-03T00:00:00.000Z',
              config: { origin: 'ios' },
              post_turn_summary: {
                status_category: 'need_input',
                needs_action: 'private question',
              },
            },
          ],
          next_cursor: null,
        });
      }
      return json({
        data: [
          {
            id: CLAUDE_AGENT_A.replace(/^session_/u, 'cse_'),
            title: '  Running   CLI agent  ',
            status: 'active',
            worker_status: 'running',
            connection_status: 'connected',
            environment_kind: 'bridge',
            created_at: '2026-07-01T00:00:00.000Z',
            last_event_at: '2026-07-04T00:00:00.000Z',
            config: {
              origin: 'claude_code_cli',
              outcomes: [{ private: 'outcome configuration' }],
            },
            first_message: 'private first message',
            task_summary: privateTaskSummary,
            client_metadata: { private: 'client metadata' },
          },
        ],
        next_cursor: 'cursor-one',
      });
    };

    const inventory = await collectClaudeAgentInventory(
      fetcher,
      1_900_000_000_000,
    );

    expect(inventory.completeness).toBe('complete');
    expect(inventory.items).toHaveLength(3);
    expect(
      inventory.items.find((item) => item.sessionId === CLAUDE_AGENT_A),
    ).toEqual({
      sessionId: CLAUDE_AGENT_A,
      title: 'Running CLI agent',
      url: `https://claude.ai/cowork/${CLAUDE_AGENT_A}`,
      createdAt: Date.parse('2026-07-01T00:00:00.000Z'),
      updatedAt: Date.parse('2026-07-04T00:00:00.000Z'),
      sessionStatus: 'running',
      workerStatus: 'running',
      connectionStatus: 'connected',
      environmentKind: 'bridge',
      origin: 'claude_code_cli',
      archived: false,
    });
    expect(
      inventory.items.find((item) => item.sessionId === CLAUDE_AGENT_C),
    ).toMatchObject({
      sessionStatus: 'archived',
      archived: true,
    });
    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain(privateTaskSummary);
    expect(serialized).not.toContain('private question');
    expect(serialized).not.toContain('source configuration');
    expect(serialized).not.toContain('outcome configuration');
    expect(serialized).not.toContain('must not cross the bridge');

    expect(calls.map((call) => call.url)).toEqual([
      '/v1/code/sessions?statuses=active&statuses=paused&limit=50',
      '/v1/code/sessions?statuses=active&statuses=paused&limit=50&cursor=cursor-one',
      '/v1/code/sessions?statuses=archived&limit=50',
      '/v1/code/sessions?statuses=active&statuses=paused&limit=50',
      '/v1/code/sessions?statuses=archived&limit=50',
    ]);
    for (const call of calls) {
      expect(call.headers.get('anthropic-version')).toBe('2023-06-01');
      expect(call.headers.get('anthropic-beta')).toBe(
        'ccr-byoc-2025-07-29',
      );
      expect(call.headers.get('anthropic-client-feature')).toBe('ccr');
      expect(call.headers.get('x-organization-uuid')).toMatch(
        /^10000000-/u,
      );
    }
  });

  it('keeps unknown enum values out of the wire object and reports partial coverage', async () => {
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.startsWith('/api/bootstrap?')) {
        return json({
          resolved_org_uuid: CLAUDE_ORG_A,
          account: {
            is_verified: true,
            memberships: [
              {
                organization: {
                  uuid: CLAUDE_ORG_A,
                  capabilities: ['chat'],
                },
              },
            ],
          },
        });
      }
      if (url.includes('statuses=archived')) {
        return json({ data: [], next_cursor: null });
      }
      return json({
        data: [
          {
            id: CLAUDE_AGENT_A,
            title: 'Unknown enum task',
            status: 'active',
            worker_status: 'future_worker_state',
            connection_status: 'future_connection_state',
            environment_kind: 'future_environment',
            created_at: '2026-07-01T00:00:00.000Z',
            config: { origin: 'future_origin' },
            post_turn_summary: { status_category: 'future_category' },
          },
        ],
        next_cursor: null,
      });
    };

    const inventory = await collectClaudeAgentInventory(fetcher);
    expect(inventory.completeness).toBe('partial');
    expect(inventory.unknownEnumValues).toBe(5);
    expect(inventory.items[0]).toMatchObject({
      sessionId: CLAUDE_AGENT_A,
      sessionStatus: 'pending',
      archived: false,
    });
    expect(JSON.stringify(inventory)).not.toContain('future_');
  });

  it('detects cursor cycles rather than looping or claiming completeness', async () => {
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.startsWith('/api/bootstrap?')) {
        return json({
          resolved_org_uuid: CLAUDE_ORG_A,
          account: {
            is_verified: true,
            memberships: [
              {
                organization: {
                  uuid: CLAUDE_ORG_A,
                  capabilities: ['chat'],
                },
              },
            ],
          },
        });
      }
      if (url.includes('statuses=archived')) {
        return json({ data: [], next_cursor: null });
      }
      return json({
        data: [
          {
            id: CLAUDE_AGENT_A,
            status: 'active',
            created_at: '2026-07-01T00:00:00.000Z',
          },
        ],
        next_cursor: 'same-cursor',
      });
    };

    const inventory = await collectClaudeAgentInventory(fetcher);
    expect(inventory.completeness).toBe('partial');
    expect(inventory.error).toMatch(/repeated pagination cursor/);
  });

  it('mirrors the verified disconnected-running and failed lifecycle mapping', () => {
    expect(
      projectClaudeAgentSession(
        {
          id: CLAUDE_AGENT_A,
          status: 'active',
          worker_status: 'running',
          connection_status: 'disconnected',
        },
        false,
      ).item?.sessionStatus,
    ).toBe('idle');
    expect(
      projectClaudeAgentSession(
        {
          id: CLAUDE_AGENT_B,
          status: 'failed',
        },
        false,
      ).item?.sessionStatus,
    ).toBe('idle');
  });
});
