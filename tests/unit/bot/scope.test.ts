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
