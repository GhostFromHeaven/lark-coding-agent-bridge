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
