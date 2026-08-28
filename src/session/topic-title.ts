/**
 * Derive the display title for a topic-scoped session catalog entry from the
 * topic's first user prompt.
 *
 * Rules (agreed with the operator):
 *  - The first user prompt of a topic is the topic's title (write-once —
 *    later prompts never change it; see SessionCatalog.upsertActive).
 *  - A leading bot mention (the `@Name ` wake-up prefix, where `Name` is one
 *    of the supplied bot display names) is stripped first; mentions inside
 *    the sentence are kept. Without bot names nothing is stripped.
 *  - Newlines and repeated whitespace are collapsed to single spaces.
 *  - Text longer than 20 characters is truncated to 20 and suffixed with an
 *    ellipsis character (so a title is at most 21 characters).
 *  - Empty / whitespace-only (or mention-only) input yields an empty string,
 *    which callers treat as "no value" (the title can then be backfilled
 *    later).
 */
const MAX_TOPIC_TITLE_CHARS = 20;
const ELLIPSIS = '…';

export function topicTitleFromPrompt(text: string, botNames: readonly string[] = []): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const stripped = stripLeadingBotMentions(collapsed, botNames);
  if (!stripped) return '';
  if (stripped.length <= MAX_TOPIC_TITLE_CHARS) return stripped;
  return `${stripped.slice(0, MAX_TOPIC_TITLE_CHARS)}${ELLIPSIS}`;
}

/**
 * Remove `@Name` prefixes from the head of the text, but only when the
 * mention is a whole token: followed by whitespace or end of text. Strips
 * repeatedly so a stacked `@A @B ` wake-up disappears entirely.
 */
function stripLeadingBotMentions(text: string, botNames: readonly string[]): string {
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of botNames) {
      if (!name) continue;
      const prefix = `@${name}`;
      const rest = out.startsWith(prefix) ? out.slice(prefix.length) : null;
      if (rest === null || (rest.length > 0 && !/^\s/.test(rest))) continue;
      out = rest.replace(/^\s+/, '');
      changed = true;
    }
  }
  return out;
}
