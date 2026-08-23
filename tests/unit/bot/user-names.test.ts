import { describe, expect, it, vi } from 'vitest';
import { resolveUserNames } from '../../../src/bot/user-names';

/** rawClient.contact.v3.user.get 桩：按 openId 返回结果，记录调用。 */
function fakeChannel(behavior: (openId: string) => Promise<{ name?: string } | { throw: Error }>) {
  const calls: string[] = [];
  const get = vi.fn(async (req: { path: { user_id: string } }) => {
    const openId = req.path.user_id;
    calls.push(openId);
    const result = await behavior(openId);
    if ('throw' in result) throw result.throw;
    return { data: { user: result.name ? { name: result.name } : {} } };
  });
  return {
    channel: { rawClient: { contact: { v3: { user: { get } } } } } as never,
    calls,
  };
}

describe('resolveUserNames', () => {
  it('resolves openIds to names and caches per process (second call hits no API)', async () => {
    const { channel, calls } = fakeChannel(async (id) =>
      id === 'ou_a' ? { name: 'A.冯' } : { throw: new Error('boom') },
    );

    const first = await resolveUserNames(channel, ['ou_a']);
    expect(first.get('ou_a')).toBe('A.冯');

    const second = await resolveUserNames(channel, ['ou_a']);
    expect(second.get('ou_a')).toBe('A.冯');
    expect(calls).toEqual(['ou_a']); // 名称缓存命中，未再调 API
  });

  it('dedupes ids within one call', async () => {
    const { channel, calls } = fakeChannel(async () => ({ name: '张三' }));
    await resolveUserNames(channel, ['ou_b', 'ou_b', 'ou_b']);
    expect(calls).toEqual(['ou_b']);
  });

  it('leaves failed lookups and name-less results absent from the map', async () => {
    const { channel } = fakeChannel(async (id) =>
      id === 'ou_err' ? { throw: new Error('no permission') } : { name: undefined },
    );
    const names = await resolveUserNames(channel, ['ou_err', 'ou_no_name']);
    expect(names.size).toBe(0);
  });
});
