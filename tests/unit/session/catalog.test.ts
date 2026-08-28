import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SessionCatalog,
  sessionCatalogKey,
} from '../../../src/session/catalog.js';

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware session catalog', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('keys entries by scope, agent, cwd realpath, and policy fingerprint', () => {
    expect(
      sessionCatalogKey({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBe('chat-1\x1fclaude\x1f/repo\x1ffp-1');
  });

  it('stores Claude sessions and Codex threads in isolated active entries', async () => {
    const catalog = new SessionCatalog(await path());

    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'claude',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      sessionId: 'sess-1',
      now: 1000,
    });
    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      threadId: 'thread-1',
      now: 2000,
    });

    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ sessionId: 'sess-1', agentId: 'claude' });
    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ threadId: 'thread-1', agentId: 'codex' });
    await catalog.flush();
  });

  it('rejects mismatched Claude/Codex identity fields and does not auto-resume damaged entries', async () => {
    const catalog = new SessionCatalog(await path());

    expect(() =>
      catalog.upsertActive({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        threadId: 'thread-wrong',
        now: 1000,
      }),
    ).toThrow(/Claude.*sessionId/i);
    expect(() =>
      catalog.upsertActive({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        sessionId: 'sess-wrong',
        now: 1000,
      }),
    ).toThrow(/Codex.*threadId/i);

    await catalog.replaceForTest([
      {
        key: sessionCatalogKey({
          scopeId: 'chat-1',
          agentId: 'codex',
          cwdRealpath: '/repo',
          policyFingerprint: 'fp-1',
        }),
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        sessionId: 'sess-damaged',
        status: 'active',
        updatedAt: 1000,
      },
    ]);

    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBeUndefined();
    await catalog.flush();
  });

  it('archives only the current agent/cwd/fingerprint entry for a new conversation', async () => {
    const catalog = new SessionCatalog(await path());
    const base = {
      scopeId: 'chat-1',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
    };
    catalog.upsertActive({ ...base, agentId: 'claude', sessionId: 'sess-1', now: 1000 });
    catalog.upsertActive({ ...base, agentId: 'codex', threadId: 'thread-1', now: 1000 });

    expect(catalog.archiveActive({ ...base, agentId: 'claude', now: 2000 })).toBe(true);

    expect(catalog.activeFor({ ...base, agentId: 'claude' })).toBeUndefined();
    expect(catalog.activeFor({ ...base, agentId: 'codex' })).toMatchObject({
      threadId: 'thread-1',
    });
    expect(catalog.entries().filter((entry) => entry.status === 'archived')).toHaveLength(1);
    await catalog.flush();
  });

  it('keeps topicTitle write-once across upserts for the same key', async () => {
    const catalog = new SessionCatalog(await path());
    const base = {
      scopeId: 'chat-1:thread-1',
      agentId: 'claude' as const,
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
    };

    catalog.upsertActive({ ...base, sessionId: 'sess-1', now: 1000, topicTitle: '首个话题标题' });

    // A later run without topicTitle (e.g. non-first message) must not clear it.
    catalog.upsertActive({ ...base, sessionId: 'sess-2', now: 2000 });
    expect(catalog.activeFor(base)?.topicTitle).toBe('首个话题标题');

    // Even an explicit competing title must not overwrite the first one.
    catalog.upsertActive({
      ...base,
      sessionId: 'sess-3',
      now: 3000,
      topicTitle: '后来的标题',
    });
    expect(catalog.activeFor(base)?.topicTitle).toBe('首个话题标题');

    // Empty string counts as "no value" and never becomes the stored title.
    catalog.upsertActive({ ...base, sessionId: 'sess-4', now: 4000, topicTitle: '' });
    expect(catalog.activeFor(base)?.topicTitle).toBe('首个话题标题');
    await catalog.flush();
  });

  it('backfills topicTitle when the first attempt produced no value', async () => {
    const catalog = new SessionCatalog(await path());
    const base = {
      scopeId: 'chat-1:thread-1',
      agentId: 'claude' as const,
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
    };

    catalog.upsertActive({ ...base, sessionId: 'sess-1', now: 1000 });
    expect(catalog.activeFor(base)?.topicTitle).toBeUndefined();

    catalog.upsertActive({
      ...base,
      sessionId: 'sess-2',
      now: 2000,
      topicTitle: '补写的标题',
    });
    expect(catalog.activeFor(base)?.topicTitle).toBe('补写的标题');

    // An empty-string title is not persisted as a value.
    const fresh = new SessionCatalog(await path());
    fresh.upsertActive({
      ...base,
      sessionId: 'sess-1',
      now: 1000,
      topicTitle: '',
    });
    expect(fresh.entries()[0]?.topicTitle).toBeUndefined();
    await Promise.all([catalog.flush(), fresh.flush()]);
  });

  it('persists topicTitle across save/load and ignores non-string values on load', async () => {
    const file = await path();
    const catalog = new SessionCatalog(file);
    const base = {
      scopeId: 'chat-1:thread-1',
      agentId: 'claude' as const,
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
    };
    catalog.upsertActive({
      ...base,
      sessionId: 'sess-1',
      now: 1000,
      topicTitle: '落盘标题',
    });
    await catalog.flush();

    const reloaded = new SessionCatalog(file);
    await reloaded.load();
    expect(reloaded.activeFor(base)?.topicTitle).toBe('落盘标题');

    // Legacy files without the field still load fine; malformed values are dropped.
    const legacy = [
      {
        key: sessionCatalogKey(base),
        scopeId: base.scopeId,
        agentId: 'claude',
        cwdRealpath: base.cwdRealpath,
        policyFingerprint: base.policyFingerprint,
        sessionId: 'sess-legacy',
        status: 'active',
        updatedAt: 1,
      },
      {
        ...entry('chat-2:thread-2', 'sess-bad', 2),
        topicTitle: 123,
      },
      {
        ...entry('chat-2:thread-3', 'sess-empty', 3),
        topicTitle: '',
      },
    ];
    await writeFile(file, `${JSON.stringify(legacy)}\n`, 'utf8');
    const legacyCatalog = new SessionCatalog(file);
    await legacyCatalog.load();
    const loaded = legacyCatalog.entries();
    expect(loaded).toHaveLength(3);
    expect(loaded.every((item) => item.topicTitle === undefined)).toBe(true);
  });

  it('garbage-collects old archived entries, per-scope overflow, and profile overflow', async () => {
    const catalog = new SessionCatalog(await path());
    await catalog.replaceForTest([
      ...Array.from({ length: 25 }, (_, i) =>
        entry(`chat-1`, `sess-${i}`, 50_000 + i, `fp-${i}`),
      ),
      ...Array.from({ length: 981 }, (_, i) =>
        entry(`chat-${i + 2}`, `other-${i}`, 20_000 + i, `fp-other-${i}`),
      ),
      {
        ...entry('chat-old', 'old', 1),
        status: 'archived',
      },
    ]);

    catalog.gc({
      now: 100 * 24 * 60 * 60 * 1000,
      maxArchivedAgeMs: 90 * 24 * 60 * 60 * 1000,
      maxEntriesPerScope: 20,
      maxEntriesPerProfile: 1000,
    });

    expect(catalog.entries().some((item) => item.sessionId === 'old')).toBe(false);
    expect(catalog.entries().filter((item) => item.scopeId === 'chat-1')).toHaveLength(20);
    expect(catalog.entries()).toHaveLength(1000);
    await catalog.flush();
  });
});

async function path(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-catalog-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'catalog.json');
}

function entry(
  scopeId: string,
  sessionId: string,
  updatedAt: number,
  policyFingerprint = 'fp-1',
) {
  const identity = {
    scopeId,
    agentId: 'claude' as const,
    cwdRealpath: '/repo',
    policyFingerprint,
  };
  return {
    key: sessionCatalogKey(identity),
    ...identity,
    sessionId,
    status: 'active' as const,
    updatedAt,
  };
}
