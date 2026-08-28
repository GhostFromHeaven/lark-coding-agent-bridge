import { describe, expect, it } from 'vitest';
import { topicTitleFromPrompt } from '../../../src/session/topic-title.js';

describe('topicTitleFromPrompt', () => {
  it('returns empty string for empty input', () => {
    expect(topicTitleFromPrompt('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(topicTitleFromPrompt('   \n\t  \n')).toBe('');
  });

  it('returns short text unchanged', () => {
    expect(topicTitleFromPrompt('话题A的问题')).toBe('话题A的问题');
  });

  it('returns exactly-20-char text unchanged without ellipsis', () => {
    const text = '一二三四五六七八九十一二三四五六七八九十';
    expect(text).toHaveLength(20);
    expect(topicTitleFromPrompt(text)).toBe(text);
  });

  it('truncates to 20 chars and appends an ellipsis for longer text', () => {
    const text = '一二三四五六七八九十一二三四五六七八九十一二三四五';
    expect(text).toHaveLength(25);
    expect(topicTitleFromPrompt(text)).toBe(
      `一二三四五六七八九十一二三四五六七八九十…`,
    );
  });

  it('collapses newlines and repeated whitespace before truncating', () => {
    expect(topicTitleFromPrompt('第一行\n\n第二行   继续\n尾行')).toBe(
      '第一行 第二行 继续 尾行',
    );
  });

  it('trims leading and trailing whitespace', () => {
    expect(topicTitleFromPrompt('  你好话题  ')).toBe('你好话题');
  });

  it('truncates by code units after whitespace collapse', () => {
    expect(topicTitleFromPrompt('a'.repeat(30))).toBe(`${'a'.repeat(20)}…`);
  });

  it('strips a leading bot mention when bot names are supplied', () => {
    expect(topicTitleFromPrompt('@Bridge 话题A的问题', ['Bridge'])).toBe('话题A的问题');
  });

  it('keeps the mention when it appears mid-sentence', () => {
    expect(topicTitleFromPrompt('你好 @Bridge 请看这个问题', ['Bridge'])).toBe(
      '你好 @Bridge 请看这个问题',
    );
  });

  it('strips repeated stacked leading mentions', () => {
    expect(topicTitleFromPrompt('@Bridge @Bridge 话题', ['Bridge'])).toBe('话题');
  });

  it('does not strip a name-like prefix without a following space or end', () => {
    expect(topicTitleFromPrompt('@Bridge看看这个', ['Bridge'])).toBe('@Bridge看看这个');
  });

  it('matches any supplied bot name and ignores non-matching ones', () => {
    expect(topicTitleFromPrompt('@小助手 话题标题', ['Bridge', '小助手'])).toBe('话题标题');
    expect(topicTitleFromPrompt('@别人 话题标题', ['Bridge'])).toBe('@别人 话题标题');
  });

  it('treats a mention-only prompt as empty', () => {
    expect(topicTitleFromPrompt('  @Bridge  ', ['Bridge'])).toBe('');
  });

  it('truncates after mention stripping', () => {
    expect(topicTitleFromPrompt(`@Bridge ${'字'.repeat(25)}`, ['Bridge'])).toBe(
      `${'字'.repeat(20)}…`,
    );
  });
});
