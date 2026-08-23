import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatRegistryStore } from '../../../src/bot/chat-registry';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chat-registry-test-'));
  dirs.push(dir);
  return join(dir, 'chats.json');
}

describe('ChatRegistryStore', () => {
  it('persists a known-chats snapshot and reloads it', async () => {
    const path = await tmpFile();
    const store = new ChatRegistryStore(path);
    store.replaceAll(
      [
        { id: 'oc_a', name: '项目讨论群' },
        { id: 'oc_b', name: '(无名)' },
      ],
      1234,
    );
    await store.flush();

    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw).toEqual({
      updatedAt: 1234,
      chats: [
        { id: 'oc_a', name: '项目讨论群' },
        { id: 'oc_b', name: '(无名)' },
      ],
    });

    const reloaded = new ChatRegistryStore(path);
    await reloaded.load();
    expect(reloaded.nameFor('oc_a')).toBe('项目讨论群');
    expect(reloaded.nameFor('oc_missing')).toBeUndefined();
  });

  it('replaceAll replaces the previous snapshot entirely', async () => {
    const store = new ChatRegistryStore(await tmpFile());
    store.replaceAll([{ id: 'oc_old', name: '旧群' }], 1);
    store.replaceAll([{ id: 'oc_new', name: '新群' }], 2);
    await store.flush();

    expect(store.nameFor('oc_old')).toBeUndefined();
    expect(store.nameFor('oc_new')).toBe('新群');
  });

  it('loads empty on missing or corrupt file (best-effort derived data)', async () => {
    const missing = new ChatRegistryStore(await tmpFile());
    await missing.load();
    expect(missing.nameFor('oc_a')).toBeUndefined();

    const corruptPath = await tmpFile();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(corruptPath, 'not json', 'utf8');
    const corrupt = new ChatRegistryStore(corruptPath);
    await corrupt.load();
    expect(corrupt.nameFor('oc_a')).toBeUndefined();
  });
});
