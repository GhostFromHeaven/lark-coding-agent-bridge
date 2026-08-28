import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    im: {
      v1: {
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      }
    };
  };
  getAppInfo: ReturnType<typeof vi.fn>;
  listChats: ReturnType<typeof vi.fn>;
  fetchRawMessage: ReturnType<typeof vi.fn>;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('topic-scoped catalog topicTitle', () => {
  it('records the first user prompt as topicTitle (truncated) for topic sessions', async () => {
    const h = await createHarness({ sessionIds: ['sess-topic-a'] });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_topic_a',
        threadId: 'omt_a',
        // 28 chars after whitespace collapse → first 20 + ellipsis.
        content: '@Bridge 一二三四五六七八九十一二三四五六七八九十',
      }),
    );
    await waitFor(() => entriesFor(h, 'oc_scope_chat:omt_a').length === 1);

    expect(entriesFor(h, 'oc_scope_chat:omt_a')[0]).toMatchObject({
      sessionId: 'sess-topic-a',
      topicTitle: '@Bridge 一二三四五六七八九十一二…',
    });
  });

  it('gives the second topic its own catalog entry and title', async () => {
    const h = await createHarness({ sessionIds: ['sess-topic-a', 'sess-topic-b'] });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_topic_a', threadId: 'omt_a', content: '@Bridge 话题A的问题' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    await h.channel.handlers.message?.(
      message({ messageId: 'om_topic_b', threadId: 'omt_b', content: '@Bridge 话题B的问题' }),
    );
    await waitFor(() => entriesFor(h, 'oc_scope_chat:omt_b').length === 1);

    expect(entriesFor(h, 'oc_scope_chat:omt_a')[0]?.topicTitle).toBe('@Bridge 话题A的问题');
    expect(entriesFor(h, 'oc_scope_chat:omt_b')[0]).toMatchObject({
      sessionId: 'sess-topic-b',
      topicTitle: '@Bridge 话题B的问题',
    });
  });

  it('never sets topicTitle for the chat-level (non-topic) session', async () => {
    const h = await createHarness({ sessionIds: ['sess-chat'] });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_chat', content: '@Bridge 普通群消息的正文' }),
    );
    await waitFor(() => entriesFor(h, 'oc_scope_chat').length === 1);

    const entry = entriesFor(h, 'oc_scope_chat')[0];
    expect(entry).toMatchObject({ sessionId: 'sess-chat' });
    expect('topicTitle' in entry).toBe(false);
  });

  it('keeps the topic title write-once: the second message in a topic does not retitle it', async () => {
    const h = await createHarness({ sessionIds: ['sess-topic-a', 'sess-topic-a'] });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_topic_a1', threadId: 'omt_a', content: '@Bridge 话题A的第一个问题' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    await waitFor(() => entriesFor(h, 'oc_scope_chat:omt_a').length === 1);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_topic_a2', threadId: 'omt_a', content: '@Bridge 完全不同的第二个问题' }),
    );
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(entriesFor(h, 'oc_scope_chat:omt_a')).toHaveLength(1);
    expect(entriesFor(h, 'oc_scope_chat:omt_a')[0]?.topicTitle).toBe('@Bridge 话题A的第一个问题');
  });
});

interface Harness {
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  catalog: SessionCatalog;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}

async function createHarness(options: { sessionIds?: string[] }): Promise<Harness> {
  const tmp: TmpProfile = await createTmpProfile('topic-title-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: ['oc_scope_chat'],
      allowedUsers: ['ou_user'],
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'sessions.json.catalog.json'));
  const done = { type: 'done' as const, terminationReason: 'normal' as const };
  const sessionIds = options.sessionIds ?? ['sess-topic-a'];
  const agent = new FakeAgentAdapter({
    events: sessionIds.map((sessionId) => [
      { type: 'system' as const, sessionId },
      done,
    ]),
  });
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });
  return { channel, agent, catalog, sessions, workspaces, profileConfig, controls };
}

async function startTestBridge(h: Harness): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    sessionCatalog: h.catalog,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function entriesFor(h: Harness, scopeId: string) {
  return h.catalog.entries().filter((entry) => entry.scopeId === scopeId);
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function createFakeLarkChannel(): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  return {
    handlers,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: {
        v1: {
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    getAppInfo: vi.fn(async () => ({ ownerId: 'ou_owner' })),
    listChats: vi.fn(async () => []),
    fetchRawMessage: vi.fn(async () => []),
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group' as const;
    },
    getConnectionStatus() {
      return { state: 'connected' as const, reconnectAttempts: 0 };
    },
    async send() {},
    async stream() {},
  };
}

function message(input: {
  messageId: string;
  threadId?: string;
  rootId?: string;
  parentId?: string;
  content: string;
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: 'oc_scope_chat',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
    mentionAll: false,
    mentionedBot: true,
    rootId: input.rootId ?? '',
    parentId: input.parentId ?? '',
    ...(input.threadId ? { threadId: input.threadId } : {}),
    replyToMessageId: input.parentId ?? '',
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
