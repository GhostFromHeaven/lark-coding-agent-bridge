import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getProfileModel } from '../../../src/config/schema';
import { resolveRunModel } from '../../../src/workspace/model';
import { WorkspaceStore } from '../../../src/workspace/store';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function newStore(): Promise<WorkspaceStore> {
  const dir = await mkdtemp(join(tmpdir(), 'ws-model-'));
  const store = new WorkspaceStore(join(dir, 'workspaces.json'));
  await store.load();
  cleanups.push(async () => {
    // 等待在途写完成，避免与目录删除竞态（先例见 store.test.ts）
    await store.flush();
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });
  return store;
}

describe('resolveRunModel precedence', () => {
  it('falls through scope > named-workspace > profile > unset', async () => {
    const workspaces = await newStore();
    workspaces.saveNamed('proj', '/tmp/proj');
    workspaces.setCwd('chat-1', '/tmp/proj');

    // 全部未设 → undefined（claude CLI 默认）
    expect(resolveRunModel({ workspaces, scopeId: 'chat-x', cwdRealpath: '/tmp/proj', profileModel: undefined })).toBeUndefined();

    // 仅 profile
    expect(resolveRunModel({ workspaces, scopeId: 'chat-x', cwdRealpath: '/tmp/proj', profileModel: 'sonnet' })).toBe('sonnet');

    // profile 空串按未设置处理
    expect(resolveRunModel({ workspaces, scopeId: 'chat-x', cwdRealpath: '/tmp/proj', profileModel: '  ' })).toBeUndefined();

    // named workspace 命中 cwd 覆盖 profile
    workspaces.setNamedModel('proj', 'ws-model');
    expect(resolveRunModel({ workspaces, scopeId: 'chat-x', cwdRealpath: '/tmp/proj', profileModel: 'sonnet' })).toBe('ws-model');

    // scope 覆盖一切
    workspaces.setModel('chat-1', 'opus');
    expect(resolveRunModel({ workspaces, scopeId: 'chat-1', cwdRealpath: '/tmp/proj', profileModel: 'sonnet' })).toBe('opus');

    // scope 清除后回落 workspace
    workspaces.setModel('chat-1', null);
    expect(resolveRunModel({ workspaces, scopeId: 'chat-1', cwdRealpath: '/tmp/proj', profileModel: 'sonnet' })).toBe('ws-model');
  });
});

describe('getProfileModel', () => {
  it('trims and treats blank as unset', () => {
    expect(getProfileModel({} as never)).toBeUndefined();
    expect(getProfileModel({ preferences: {} } as never)).toBeUndefined();
    expect(getProfileModel({ preferences: { model: '' } } as never)).toBeUndefined();
    expect(getProfileModel({ preferences: { model: ' claude-sonnet-5 ' } } as never)).toBe('claude-sonnet-5');
  });
});
