import { describe, expect, it } from 'vitest';
import { configFormCard, configSavedCard } from '../../../src/card/config-card';

const baseOpts = {
  messageReply: 'card' as const,
  toolCallDisplay: 'compact' as const,
  toolCallDisplayInGroups: 'inherit' as const,
  maxConcurrentRuns: 10,
  runIdleTimeoutMinutes: 0,
  requireMentionInGroup: true,
  replyInThreadInGroup: true,
  claudeDriver: 'pty' as const,
  larkCliIdentity: 'bot-only' as const,
  allowedUsers: [],
  allowedChats: [],
  admins: [],
  knownChats: [],
};

describe('config form model field', () => {
  it('offers and preselects the card duration setting', () => {
    const card = configFormCard({ ...baseOpts, model: '', showRunDurationInGroups: true }) as {
      body: { elements: Array<{ tag: string; elements?: Array<{ name?: string; initial_option?: string }> }> };
    };
    const form = card.body.elements.find((element) => element.tag === 'form');
    expect(form?.elements?.find((element) => element.name === 'show_run_duration_in_groups')?.initial_option).toBe('yes');
    expect(JSON.stringify(configSavedCard({ ...baseOpts, model: '', showRunDurationInGroups: true }))).toContain('**卡片总执行时间**:`显示`');
  });

  it('renders a model input prefilled with the profile model', () => {
    const card = configFormCard({ ...baseOpts, model: 'sonnet' });
    const text = JSON.stringify(card);
    expect(text).toContain('"name":"model"');
    expect(text).toContain('sonnet');
  });

  it('renders an empty model input when unset', () => {
    const card = configFormCard({ ...baseOpts, model: '' });
    expect(JSON.stringify(card)).toContain('"name":"model"');
  });

  it('shows the model in the saved card', () => {
    const saved = configSavedCard({ ...baseOpts, model: 'opus' });
    expect(JSON.stringify(saved)).toContain('opus');
    const savedEmpty = configSavedCard({ ...baseOpts, model: '' });
    expect(JSON.stringify(savedEmpty)).toContain('未设置');
  });
});
