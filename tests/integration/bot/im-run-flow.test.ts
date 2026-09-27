import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCapability } from '../../../src/agent/capability';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { startRunFlow } from '../../../src/bot/run-flow';
import { ProcessPool } from '../../../src/bot/process-pool';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('IM run flow', () => {
  it('rejects missing cwd without falling back to the user home', async () => {
    const h = await createHarness();

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result).toMatchObject({
      ok: false,
      rejectReason: {
        code: 'empty-requested-cwd',
      },
    });
    expect(h.agent.runOptions).toEqual([]);
  });

  it('submits cwd through RunExecutor and resumes matching sessions', async () => {
    const h = await createHarness();
    const workspaceRealpath = await realpath(h.tmp.workspace);
    h.workspaces.setCwd('chat-1', h.tmp.workspace);
    h.sessions.set('chat-1', 'sess-1', workspaceRealpath);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.cwdRealpath).toBe(workspaceRealpath);
    expect(result.resumeFrom).toBe('sess-1');
    expect(h.agent.runOptions[0]).toMatchObject({
      runId: 'run-1',
      cwd: workspaceRealpath,
      sessionId: 'sess-1',
    });
  });

  it('uses the profile default workspace when a scope has no explicit binding', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    const workspaceRealpath = await realpath(h.tmp.workspace);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.cwdRealpath).toBe(workspaceRealpath);
    expect(h.agent.runOptions[0]?.cwd).toBe(workspaceRealpath);
  });

  it('resolves the run model from scope > named workspace > profile', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    const workspaceRealpath = await realpath(h.tmp.workspace);

    // Each run must be drained before the next submit on the same scope,
    // otherwise the executor rejects it as run-already-active.
    const runOnce = async (): Promise<void> => {
      const result = await startRunFlow(h.flowInput());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected run flow to start');
      await drain(result.execution.subscribe());
    };

    // profile 级：直接生效
    h.profileConfig.preferences.model = 'sonnet';
    await runOnce();
    expect(h.agent.runOptions.at(-1)?.model).toBe('sonnet');

    // named workspace 级：绑定 cwd 的别名覆盖 profile
    h.workspaces.saveNamed('proj', workspaceRealpath);
    h.workspaces.setNamedModel('proj', 'opus');
    await runOnce();
    expect(h.agent.runOptions.at(-1)?.model).toBe('opus');

    // scope 级：最高优先
    h.workspaces.setModel('chat-1', 'haiku');
    await runOnce();
    expect(h.agent.runOptions.at(-1)?.model).toBe('haiku');

    // 清除后逐级回落
    h.workspaces.setModel('chat-1', null);
    await runOnce();
    expect(h.agent.runOptions.at(-1)?.model).toBe('opus');
  });

  it('omits model entirely when no level sets it', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    await startRunFlow(h.flowInput());
    expect(h.agent.runOptions.at(-1)?.model).toBeUndefined();
  });

});

async function createHarness(options: { defaultWorkspace?: boolean } = {}): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  flowInput: () => Parameters<typeof startRunFlow>[0];
}> {
  const tmp = await createTmpProfile('bridge-im-run-flow-');
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns: new ActiveRuns(),
    createRunId: () => 'run-1',
    now: () => 1000,
  });
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
  });
  // Single shared object: `flowInput` must capture the same instance the
  // test mutates via `h.profileConfig` (e.g. preferences.model).
  const profileConfig: ReturnType<typeof createDefaultProfileConfig> = {
    ...base,
    workspaces: {
      ...base.workspaces,
      ...(options.defaultWorkspace ? { default: tmp.workspace } : {}),
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const flowInput = () => ({
    scopeId: 'chat-1',
    scope: { source: 'im' as const, chatId: 'chat-1', actorId: 'ou_user' },
    prompt: 'hello',
    attachments: [],
    access: { ok: true, reason: 'allowed-user' as const },
    capability: claudeCapability(profileConfig),
    profileConfig,
    sessions,
    workspaces,
    executor,
    now: 1000,
  });
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    executor,
    sessions,
    workspaces,
    profileConfig,
    flowInput,
  };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
}
