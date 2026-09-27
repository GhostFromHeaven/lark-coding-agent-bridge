import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../../../src/workspace/store';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function newStore(): Promise<{ store: WorkspaceStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ws-store-'));
  cleanups.push(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'workspaces.json');
  const store = new WorkspaceStore(path);
  await store.load();
  return { store, path };
}

describe('WorkspaceStore model support', () => {
  it('keeps scope model across setCwd and persists it', async () => {
    const { store, path } = await newStore();
    store.setCwd('chat-1', '/tmp/a');
    store.setModel('chat-1', 'sonnet');
    store.setCwd('chat-1', '/tmp/b'); // /cd 切目录不丢 scope model
    expect(store.cwdFor('chat-1')).toBe('/tmp/b');
    expect(store.modelFor('chat-1')).toBe('sonnet');

    store.setModel('chat-1', null);
    expect(store.modelFor('chat-1')).toBeUndefined();
    expect(store.cwdFor('chat-1')).toBe('/tmp/b');

    await store.flush();
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw.chats['chat-1']).toEqual({ cwd: '/tmp/b' });
  });

  it('allows a model-only scope entry and drops it once cleared', async () => {
    const { store, path } = await newStore();
    store.setModel('chat-1', 'opus'); // 从未 /cd 过的 scope
    expect(store.modelFor('chat-1')).toBe('opus');
    expect(store.cwdFor('chat-1')).toBeUndefined();
    expect(store.listCwds()).toEqual({}); // 无 cwd 的条目不出现在 cwd 列表

    store.setModel('chat-1', null);
    expect(store.modelFor('chat-1')).toBeUndefined();
    await store.flush();
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw.chats['chat-1']).toBeUndefined();
  });

  it('supports legacy string and object named entries', async () => {
    const { store } = await newStore();
    store.saveNamed('legacy', '/tmp/legacy');
    store.setNamedModel('legacy', 'haiku');
    expect(store.getNamed('legacy')).toBe('/tmp/legacy');
    expect(store.namedModelFor('legacy')).toBe('haiku');

    store.saveNamed('legacy', '/tmp/legacy-2'); // 改 cwd 保留 model
    expect(store.namedModelFor('legacy')).toBe('haiku');
    expect(store.listNamed()['legacy']).toBe('/tmp/legacy-2');

    expect(store.setNamedModel('missing', 'sonnet')).toBe(false);
    expect(store.setNamedModel('legacy', null)).toBe(true);
    expect(store.namedModelFor('legacy')).toBeUndefined();
    expect(store.getNamed('legacy')).toBe('/tmp/legacy-2');
    await store.flush(); // 等待在途写完成，避免与 afterEach 的目录清理竞态
  });

  it('reads on-disk object named entries and mixed forms', async () => {
    const { store: s1, path } = await newStore();
    s1.saveNamed('plain', '/tmp/x');
    s1.saveNamed('rich', '/tmp/y'); // 别名须先存在，setNamedModel 不隐式创建
    s1.setNamedModel('rich', 'sonnet');
    await s1.flush();

    const s2 = new WorkspaceStore(path);
    await s2.load();
    expect(s2.getNamed('plain')).toBe('/tmp/x');
    expect(s2.namedModelFor('plain')).toBeUndefined();
    expect(s2.getNamed('rich')).toBe('/tmp/y');
    expect(s2.namedModelFor('rich')).toBe('sonnet');
  });

  it('resolves a named model by cwd realpath, first match with model wins', async () => {
    const { store } = await newStore();
    const dir = await mkdtemp(join(tmpdir(), 'ws-real-'));
    cleanups.push(async () => {
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    });
    const real = await realpath(dir);
    store.saveNamed('a', dir); // 无 model
    store.saveNamed('b', real);
    store.setNamedModel('b', 'opus');
    expect(store.namedModelForCwd(real)).toBe('opus');

    store.setNamedModel('a', 'haiku');
    // a 在前且带 model —— 第一个带 model 的命中优先
    expect(store.namedModelForCwd(real)).toBe('haiku');

    expect(store.namedModelForCwd('/tmp/definitely-not-bound')).toBeUndefined();
    await store.flush(); // 等待在途写完成，避免与 afterEach 的目录清理竞态
  });
});
