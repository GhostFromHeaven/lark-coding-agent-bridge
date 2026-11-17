import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer';
import { renderText } from '../../../src/card/text-renderer';
import { initialState, type RunState } from '../../../src/card/run-state';

describe('run duration footer', () => {
  const finished: RunState = { ...initialState, terminal: 'done', durationMs: 83_999 };

  for (const terminal of ['done', 'error', 'interrupted', 'idle_timeout'] as const) {
    it(`shows elapsed time for ${terminal} in both card formats`, () => {
      const state = { ...finished, terminal };
      const card = JSON.stringify(renderCard({ ...state, usage: { inputTokens: 1200, outputTokens: 800 } }, { showRunDuration: true }));
      expect(card).toContain('📊 tokens 输入 1.2k · 输出 800 · 耗时1m 23s');
      expect(renderText({ ...state, usage: { inputTokens: 1200, outputTokens: 800 } }, { showRunDuration: true })).toContain('📊 tokens 输入 1.2k · 输出 800 · 耗时1m 23s');
    });
  }

  it('does not display a final duration while running or when disabled', () => {
    for (const render of [renderCard, renderText]) {
      expect(JSON.stringify(render(finished))).not.toContain('耗时');
      expect(JSON.stringify(render({ ...finished, terminal: 'running' }, { showRunDuration: true }))).not.toContain('耗时');
      expect(JSON.stringify(render({ ...initialState, terminal: 'done' }, { showRunDuration: true }))).not.toContain('耗时');
    }
  });

  it.each([
    [0, '0秒'],
    [999, '0秒'],
    [60_000, '1分0秒'],
    [3_661_000, '1小时1分1秒'],
  ])('formats %i ms without rounding up', (durationMs, label) => {
    expect(renderText({ ...finished, durationMs, usage: { inputTokens: 1, outputTokens: 2 } }, { showRunDuration: true })).toContain(`耗时${label.replace('小时', 'h ').replace('分', 'm ').replace('秒', 's')}`);
  });
});
