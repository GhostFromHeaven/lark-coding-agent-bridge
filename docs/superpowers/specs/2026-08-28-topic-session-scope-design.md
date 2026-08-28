# Topic-scoped sessions for all thread-bearing messages

- Date: 2026-08-28
- Status: approved (design confirmed with user)
- Branch target: `feat/claude-pty-integrated`

## Problem

Sessions are scoped per chat unless the chat is a native topic group. The
scope rule today (`src/bot/scope.ts`, `src/bot/channel.ts` intake,
`src/card/dispatcher.ts` `resolveScope`) gates thread-scoping on
`chatMode === 'topic'`, which comes from `im.v1.chat.get` → `chat_mode`.

A regular group switched to topic mode (群设置 → 话题模式) is **not**
reported as `topic` by that API — it keeps returning `chat_mode: "group"`
(verified live against the user's converted group on 2026-08-28).
Result: messages in that group carry `thread_id` but the bridge keeps a
single chat-level session, mixing all topics into one conversation.

## Evidence (2026-08-28, live Feishu API)

| Message shape | thread_id | root_id / parent_id | Where seen |
|---|---|---|---|
| Topic message in converted group | `omt_*` | — | converted group (chat_mode=`group`) |
| Quote-reply in normal group | — | `om_*` | normal group |
| User-initiated topic in normal group | `omt_*` | — | normal group |
| Plain message | — | — | anywhere |

Key facts:

- `thread_id` is a clean topic signal: quote-replies (`root_id`/`parent_id`)
  never carry it; every message that carries it belongs to a topic.
- Card actions (`src/card/dispatcher.ts`) gate the same way
  (`mode !== 'topic'` → early return `chatId`), so card clicks in a
  converted group also route to the chat-level session — same root cause.

## Decision

**Scope by `threadId` whenever the message has one, regardless of
chat mode.** User explicitly chose the global default behavior (option A):

- All groups uniformly: thread-bearing message → `chatId:threadId` scope;
  everything else → `chatId`.
- Topics started inside normal groups get their own sessions (accepted,
  considered intuitive).
- Quote-replies keep the chat-level session (unchanged).

Rejected alternatives:

- Fix `getChatMode` to probe recent messages for topic-ness — fragile
  (empty groups misjudge), extra API call, logic spread across packages.
- Learning-style per-chat topic marking — more state, first message of a
  topic may route wrong; user rejected.

## Changes

1. **Intake scope** (`src/bot/channel.ts`, currently inline at ~L555):
   `const scope = msg.threadId ? \`${msg.chatId}:${msg.threadId}\` : msg.chatId`.
   Drop the `chatMode === 'topic'` condition.
2. **Card action scope** (`src/card/dispatcher.ts` `resolveScope`):
   remove the `mode !== 'topic'` early return; always call
   `lookupMessageThreadId` and compose `chatId:threadId` when found
   (falls back to `chatId` naturally in normal groups).
3. **Single source of truth**: move the rule into `src/bot/scope.ts`
   (`scopeFor` / `scopeForMessage`) and have both call sites above use it
   instead of inline duplicates. `scope.ts` currently has no production
   callers — this change makes it the canonical implementation.
4. **Keep chat-mode resolution**: `ChatModeCache` /
   `channel.getChatMode` remain in service for other consumers
   (e.g. `shouldReplyInThread` reply policy, topic-quote handling).
   No behavior change there: a converted group still resolves as `group`
   and `replyInThreadInGroup` preference applies.

## Downstream behavior (no code changes needed)

- Pending debounce queue, session catalog identity, `/new`, `/cd`,
  `/ws use` all key off scope — each topic naturally gets its own queue,
  session, and workspace context.
- `/cd` / `/ws use` inside a topic affect that topic's session only.

## Edge cases

- **Existing chat-level sessions** in a converted group: not migrated.
  Once messages carry `thread_id` they create fresh topic-scoped
  sessions; the old chat-level entry goes idle and is eventually GC'd
  (existing 90-day archival GC).
- **Card clicks in normal groups**: one extra `im.v1.message.get` per
  click (thread lookup that comes back empty). Previously this call only
  happened for native topic groups; the per-click cost was already
  considered acceptable in the existing code comment.
- **ChatModeCache staleness** (group switched at runtime, cached as
  `group`): no longer matters for scope — the new rule ignores mode.
  It only affects reply-in-thread policy until restart; acceptable.

## Testing

- Unit: scope rule covers all four message shapes — topic message
  (thread_id set → `chatId:threadId`), quote-reply (root_id only →
  `chatId`), plain message (→ `chatId`), native topic group top-level
  with no thread_id (→ `chatId`, fallback preserved).
- Integration: simulate a converted group — `getChatMode` returns
  `group` while the message event carries `thread_id` — assert the
  session catalog keys a per-topic session and two topics get two
  distinct sessions.
- Integration: card action in the same simulated group routes to the
  topic-scoped session; card action in a normal group still resolves
  the chat-level session.
