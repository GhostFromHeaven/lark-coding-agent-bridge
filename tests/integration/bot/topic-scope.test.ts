import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
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
      };
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

describe('thread-id-driven session scope', () => {
  /**
   * The converted-group scenario: the group was switched to topic mode in
   * Feishu settings, so messages carry thread_id, but im.v1.chat.get still
   * reports chat_mode="group". Sessions must still split per topic.
   */
  it('scopes sessions per topic when chat mode resolves as group but messages carry thread_id', async () => {
    const h = await createHarness({ chatMode: 'group', sessionIds: ['sess-topic-a'] });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_topic_a', threadId: 'omt_a', content: '@Bridge 话题A的问题' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    // The system event's sessionId lands in the SessionStore keyed by scope.
    expect(h.sessions.getRaw('oc_scope_chat:omt_a')?.sessionId).toBe('sess-topic-a');
    expect(h.sessions.getRaw('oc_scope_chat')).toBeUndefined();
  });

  it('gives two topics two distinct sessions in the same converted group', async () => {
    const h = await createHarness({ chatMode: 'group', sessionIds: ['sess-topic-a', 'sess-topic-b'] });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_topic_a', threadId: 'omt_a', content: '@Bridge 话题A的问题' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    await h.channel.handlers.message?.(
      message({ messageId: 'om_topic_b', threadId: 'omt_b', content: '@Bridge 话题B的问题' }),
    );
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.sessions.getRaw('oc_scope_chat:omt_a')?.sessionId).toBe('sess-topic-a');
    expect(h.sessions.getRaw('oc_scope_chat:omt_b')?.sessionId).toBe('sess-topic-b');
  });

  it('keeps quote-replies (root_id only, no thread_id) on the chat-level session', async () => {
    const h = await createHarness({ chatMode: 'group', sessionIds: ['sess-quote'] });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_quote_reply',
        rootId: 'om_quote_target',
        parentId: 'om_quote_target',
        content: '@Bridge 引用回复',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.sessions.getRaw('oc_scope_chat')?.sessionId).toBe('sess-quote');
    expect(h.sessions.getRaw('oc_scope_chat:omt_a')).toBeUndefined();
  });
});

async function createHarness(options: {
  chatMode?: 'group' | 'topic';
  sessionIds?: string[];
}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('topic-scope-');
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
  // FakeAgentAdapter's `events` takes one event list per run (array of
  // arrays, shifted per `run()` call). Each run's system event records a
  // distinct sessionId we can assert against the SessionStore scope keys.
  // Each test passes the exact sessionIds it needs, so expectations are
  // self-contained instead of relying on a shared default event ordering.
  const done = { type: 'done' as const, terminationReason: 'normal' as const };
  const sessionIds = options.sessionIds ?? ['sess-topic-a', 'sess-topic-b'];
  const agent = new FakeAgentAdapter({
    events: sessionIds.map((sessionId) => [
      { type: 'system' as const, sessionId },
      done,
    ]),
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  chatMode?: 'group' | 'topic';
} = {}): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  const chatMode = options.chatMode ?? 'group';
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
      return chatMode;
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send() {},
    async stream() {},
  };
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
