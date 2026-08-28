# Topic-Scoped Sessions (thread-id-driven scope) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Session scope follows `thread_id` whenever a message carries one, regardless of chat mode, so groups switched to topic mode get one session per topic.

**Architecture:** Replace the `chatMode === 'topic' && threadId` gate with a single sync rule `threadId ? chatId:threadId : chatId` in `src/bot/scope.ts`, then wire the two computation sites (message intake in `src/bot/channel.ts`, card-action `resolveScope` in `src/card/dispatcher.ts`) to it. Chat-mode resolution stays for other consumers (reply-in-thread policy).

**Tech Stack:** TypeScript (ESM, imports without `.js` suffix in `src/`), vitest, existing integration harness patterns from `tests/integration/bot/topic-quote.test.ts` and `tests/integration/card/callback-dispatch.test.ts`.

**Spec:** `docs/superpowers/specs/2026-08-28-topic-session-scope-design.md`

## Global Constraints

- Never run vitest in watch mode — always `pnpm exec vitest run <file>` (project CLAUDE.md rule).
- Run the narrowest test scope possible; only Task 4 runs broader suites.
- Do not pass `--pool` / `--poolOptions` flags to vitest.
- Commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Do not refactor anything unrelated to scope computation (YAGNI).
- `src/bot/scope.ts`'s current `scopeFor` / `scopeForMessage` have **no production callers** (verified by grep) — replacing them outright is safe.

---

### Task 1: Sync scope rule in `src/bot/scope.ts` + unit tests

**Files:**
- Modify: `src/bot/scope.ts` (full rewrite — file is 37 lines)
- Test: `tests/unit/bot/scope.test.ts` (new)

**Interfaces:**
- Consumes: nothing (pure function).
- Produces: `chatScope(chatId: string, threadId: string | undefined): string` — the canonical scope rule. Tasks 2 and 3 import and call this.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/bot/scope.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { chatScope } from '../../../src/bot/scope.js';

describe('chatScope', () => {
  it('scopes topic messages by thread even when chat mode is group', () => {
    // The converted-group case: chat.get says "group" but the message
    // carries a topic thread_id.
    expect(chatScope('oc_chat', 'omt_topic')).toBe('oc_chat:omt_topic');
  });

  it('scopes topic messages in native topic groups the same way', () => {
    expect(chatScope('oc_chat', 'omt_topic')).toBe('oc_chat:omt_topic');
  });

  it('keeps quote-replies on the chat-level scope (no thread_id)', () => {
    // Quote-replies carry root_id/parent_id but never thread_id.
    expect(chatScope('oc_chat', undefined)).toBe('oc_chat');
  });

  it('falls back to chatId for plain messages', () => {
    expect(chatScope('oc_chat', undefined)).toBe('oc_chat');
  });

  it('falls back to chatId when a topic-group top-level message has no thread_id', () => {
    expect(chatScope('oc_chat', undefined)).toBe('oc_chat');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/bot/scope.test.ts`
Expected: FAIL — `chatScope` is not exported (import error).

- [ ] **Step 3: Rewrite `src/bot/scope.ts`**

Replace the entire file content with:

```typescript
/**
 * Compute the **session scope** for a message.
 *
 *  - Message carries `thread_id` (a topic message — in native topic
 *    groups, in regular groups switched to topic mode, or in topics
 *    started inside normal groups): scope = `${chatId}:${threadId}`.
 *    Each topic is an independent conversation with its own session /
 *    cwd / pending queue.
 *  - Everything else (p2p, plain group messages, quote-replies that only
 *    carry root_id/parent_id): scope = `chatId` — the chat-level session.
 *
 * Chat mode is deliberately NOT consulted. Feishu's `im.v1.chat.get`
 * keeps returning `chat_mode: "group"` for groups switched to topic
 * mode (verified live 2026-08-28), so `thread_id` presence is the only
 * reliable topic signal — and it is a clean one: quote-replies never
 * carry it. See docs/superpowers/specs/2026-08-28-topic-session-scope-design.md.
 */
export function chatScope(chatId: string, threadId: string | undefined): string {
  return threadId ? `${chatId}:${threadId}` : chatId;
}
```

This deletes the old async `scopeFor` / `scopeForMessage` (they had no production callers — the intake path in `channel.ts` inlines its own copy, which Task 2 replaces).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/bot/scope.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify nothing else imported the deleted functions**

Run: `grep -rn "scopeFor\|scopeForMessage" src tests --include='*.ts'`
Expected: no matches (if any match appears in a test, update that test to use `chatScope`).

- [ ] **Step 6: Commit**

```bash
git add src/bot/scope.ts tests/unit/bot/scope.test.ts
git commit -m "feat(scope): thread-id-driven session scope rule

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Use `chatScope` at message intake + converted-group integration test

**Files:**
- Modify: `src/bot/channel.ts:552-557` (intake scope computation in `intakeMessage`)
- Test: `tests/integration/bot/topic-scope.test.ts` (new)

**Interfaces:**
- Consumes: `chatScope` from Task 1.
- Produces: intake assigns `scope` used by every downstream consumer (pending queue, commands, run flow). No signature changes.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/bot/topic-scope.test.ts`, modeled on `tests/integration/bot/topic-quote.test.ts`:

```typescript
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
    const h = await createHarness({ chatMode: 'group' });

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
    const h = await createHarness({ chatMode: 'group' });

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
    const h = await createHarness({ chatMode: 'group' });

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

    expect(h.sessions.getRaw('oc_scope_chat')?.sessionId).toBe('sess-topic-a');
    expect(h.sessions.getRaw('oc_scope_chat:omt_a')).toBeUndefined();
  });
});

async function createHarness(options: {
  chatMode?: 'group' | 'topic';
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
  const done = { type: 'done' as const, terminationReason: 'normal' as const };
  const agent = new FakeAgentAdapter({
    events: [
      // Test 1 run + test 3 run: sessionId 'sess-topic-a'.
      [{ type: 'system' as const, sessionId: 'sess-topic-a' }, done],
      // Test 2, first message (topic A).
      [{ type: 'system' as const, sessionId: 'sess-topic-a' }, done],
      // Test 2, second message (topic B).
      [{ type: 'system' as const, sessionId: 'sess-topic-b' }, done],
      [{ type: 'system' as const, sessionId: 'sess-topic-a' }, done],
    ],
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
```

Note on the harness: `FakeAgentAdapter`'s `events` option is `readonly (readonly AgentEvent[])[]` — one event list per run, consumed in order (verified in `tests/helpers/fake-agent.ts`). Each harness creates a fresh adapter, so the four event lists map to the runs above deterministically.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/integration/bot/topic-scope.test.ts`
Expected: FAIL — first two tests: `h.sessions.getRaw('oc_scope_chat:omt_a')` is undefined because intake scopes by plain `chatId` when chatMode is `group` (the session lands under `oc_scope_chat` instead). Third test may already pass (it asserts the unchanged quote-reply behavior — it is the regression guard).

- [ ] **Step 3: Modify `src/bot/channel.ts` intake**

Find in `intakeMessage` (around line 552-557):

```typescript
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const chatMode = await chatModeCache.resolve(channel, msg.chatId);
  const scope = chatMode === 'topic' && msg.threadId
    ? `${msg.chatId}:${msg.threadId}`
    : msg.chatId;
```

Replace with:

```typescript
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these. Scope follows thread_id alone:
  // chat_mode stays "group" for groups switched to topic mode, so it
  // can't be the gate (see scope.ts).
  const chatMode = await chatModeCache.resolve(channel, msg.chatId);
  const scope = chatScope(msg.chatId, msg.threadId);
```

And add to the import block near the other `./` imports in `src/bot/channel.ts` (alphabetical position after the `./run-flow`-style siblings — place it next to `./scope`-sorted neighbors):

```typescript
import { chatScope } from './scope';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/integration/bot/topic-scope.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the neighboring bot integration tests for regressions**

Run: `pnpm exec vitest run tests/integration/bot/topic-quote.test.ts`
Expected: PASS (topic-group behavior unchanged — `chatMode: 'topic'` + thread_id produces the same scope as before).

- [ ] **Step 6: Commit**

```bash
git add src/bot/channel.ts tests/integration/bot/topic-scope.test.ts
git commit -m "feat(bot): scope sessions per topic for thread-bearing messages at intake

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Card-action `resolveScope` without the mode gate + integration test

**Files:**
- Modify: `src/card/dispatcher.ts:248-265` (`resolveScope`)
- Test: `tests/integration/card/callback-dispatch.test.ts` (add one case)

**Interfaces:**
- Consumes: `chatScope` from Task 1; existing `lookupMessageThreadId(channel, messageId)`.
- Produces: same `{ scope, threadId, mode }` return shape — downstream code in this file is unchanged.

- [ ] **Step 1: Write the failing test**

In `tests/integration/card/callback-dispatch.test.ts`, inside the top-level `describe('signed card callback dispatch', ...)`, add after the existing `'scopes topic-group callbacks by the carrier message thread_id'` test:

```typescript
  it('scopes card callbacks by thread_id even when chat mode resolves as group (converted group)', async () => {
    // A regular group switched to topic mode: chat.get says "group" but
    // the card's carrier message lives inside a topic (thread_id set).
    const h = await createHarness({ chatMode: 'group' });
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    h.activeRuns.register('oc_group:th_topic', h.agent.run({ runId: 'run-active', prompt: 'running' }));

    await h.dispatch({
      __bridge_cb: true,
      bridge_token: h.token('agent_callback', { nonce: 'nonce-converted', scope: 'oc_group:th_topic' }),
      choice: 'a',
    });

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    const queued = h.pending.cancel('oc_group:th_topic');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a"}');
  });

  it('still resolves the chat-level scope for card clicks in normal groups (no thread_id)', async () => {
    const h = await createHarness({ chatMode: 'group' });
    // rawThreadIds has no entry for 'om_card' — a plain group message.

    await h.dispatch({
      __bridge_cb: true,
      bridge_token: h.token('agent_callback', { nonce: 'nonce-plain-group' }),
      choice: 'a',
    });

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/integration/card/callback-dispatch.test.ts`
Expected: the new first test FAILS (`pending.cancel('oc_group:th_topic')` is empty — `resolveScope` early-returns the bare `oc_group` scope because mode is `group`); the new second test may already pass (regression guard).

- [ ] **Step 3: Modify `resolveScope` in `src/card/dispatcher.ts`**

Find (lines 248-265):

```typescript
async function resolveScope(
  deps: CardDispatchDeps,
): Promise<{ scope: string; threadId: string | undefined; mode: 'p2p' | 'group' | 'topic' }> {
  const chatId = deps.evt.chatId;
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  if (mode !== 'topic') {
    return { scope: chatId, threadId: undefined, mode };
  }
  // Topic group — need the carrier message's thread_id to compose scope.
  // One API call per click; could cache by messageId if it ever becomes hot.
  const threadId = await lookupMessageThreadId(deps.channel, deps.evt.messageId);
  if (!threadId) {
    // Fall back to plain chatId. Better to land in the chat's "default"
    // scope than fail the click silently.
    return { scope: chatId, threadId: undefined, mode };
  }
  return { scope: `${chatId}:${threadId}`, threadId, mode };
}
```

Replace with:

```typescript
async function resolveScope(
  deps: CardDispatchDeps,
): Promise<{ scope: string; threadId: string | undefined; mode: 'p2p' | 'group' | 'topic' }> {
  const chatId = deps.evt.chatId;
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  // Look up the carrier message's thread_id regardless of chat mode:
  // groups switched to topic mode keep chat_mode="group", so thread_id
  // presence is the only reliable topic signal. One API call per click;
  // could cache by messageId if it ever becomes hot.
  const threadId = await lookupMessageThreadId(deps.channel, deps.evt.messageId);
  // Fall back to plain chatId when there's no thread. Better to land in
  // the chat's "default" scope than fail the click silently.
  return { scope: chatScope(chatId, threadId), threadId, mode };
}
```

And add `chatScope` to the `../bot` imports in `src/card/dispatcher.ts` (next to the existing `import type { ChatModeCache } from '../bot/chat-mode-cache';`):

```typescript
import { chatScope } from '../bot/scope';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/integration/card/callback-dispatch.test.ts`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/card/dispatcher.ts tests/integration/card/callback-dispatch.test.ts
git commit -m "feat(card): resolve card-action scope by carrier thread_id in converted groups

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Regression sweep

**Files:**
- No code changes. Verification only.

**Interfaces:**
- Consumes: everything from Tasks 1-3.

- [ ] **Step 1: Unit suite**

Run: `pnpm test:unit`
Expected: PASS.

- [ ] **Step 2: Integration suite**

Run: `pnpm test:integration`
Expected: PASS. Pay attention to any test that asserts the old `chatMode === 'topic'` gating — if one fails, read its assertion: if it encodes the old rule, update the test to the new rule (thread_id-driven) and note it in the commit message; if it encodes an unrelated real behavior, stop and investigate before changing anything.

- [ ] **Step 3: Full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 4: Manual smoke (requires the user's converted group)**

Ask the user to send two messages in two different topics of the converted group and confirm the bot's replies land in their topics with independent sessions. This is optional if the user is unavailable — flag it as pending manual verification in the final report instead of skipping silently.
