/**
 * Derive the display title for a topic-scoped session catalog entry from the
 * topic's first user prompt.
 *
 * Rules (agreed with the operator):
 *  - The first user prompt of a topic is the topic's title (write-once —
 *    later prompts never change it; see SessionCatalog.upsertActive).
 *  - Newlines and repeated whitespace are collapsed to single spaces.
 *  - Text longer than 20 characters is truncated to 20 and suffixed with an
 *    ellipsis character (so a title is at most 21 characters).
 *  - Empty / whitespace-only input yields an empty string, which callers
 *    treat as "no value" (the title can then be backfilled later).
 */
const MAX_TOPIC_TITLE_CHARS = 20;
const ELLIPSIS = '…';

export function topicTitleFromPrompt(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= MAX_TOPIC_TITLE_CHARS) return normalized;
  return `${normalized.slice(0, MAX_TOPIC_TITLE_CHARS)}${ELLIPSIS}`;
}
