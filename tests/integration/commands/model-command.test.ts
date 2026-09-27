import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { saveRootConfig, createRootConfig } from '../../../src/config/profile-store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: Controls;
  run(content: string, senderId?: string): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

describe('/model command', () => {
  it('shows effective model with source and falls through levels', async () => {
    const h = await createHarness();
    await h.run('/model');
    expect(lastMarkdown(h.channel)).toContain('claude 默认');

    h.controls.cfg.preferences!.model = 'sonnet';
    await h.run('/model');
    expect(lastMarkdown(h.channel)).toContain('`sonnet`');
    expect(lastMarkdown(h.channel)).toContain('profile');

    const real = await realpath(h.tmp.workspace);
    h.workspaces.saveNamed('proj', real);
    h.workspaces.setNamedModel('proj', 'opus');
    h.workspaces.setCwd('chat-1', real);
    await h.run('/model');
    expect(lastMarkdown(h.channel)).toContain('`opus`');
    expect(lastMarkdown(h.channel)).toContain('工作目录');
  });

  it('sets and resets the scope model', async () => {
    const h = await createHarness();
    await h.run('/model haiku');
    expect(lastMarkdown(h.channel)).toContain('`haiku`');
    expect(h.workspaces.modelFor('chat-1')).toBe('haiku');

    await h.run('/model');
    expect(lastMarkdown(h.channel)).toContain('会话');
    expect(lastMarkdown(h.channel)).toContain('`haiku`');

    await h.run('/model reset');
    expect(lastMarkdown(h.channel)).toContain('已清除');
    expect(h.workspaces.modelFor('chat-1')).toBeUndefined();
  });

  it('gates /model ws behind admin and manages workspace models', async () => {
    const h = await createHarness();
    const real = await realpath(h.tmp.workspace);
    h.workspaces.setCwd('chat-1', real);
    await h.run('/ws save proj');

    await h.run('/model ws proj sonnet', 'ou-not-admin');
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');

    await h.run('/model ws proj sonnet');
    expect(lastMarkdown(h.channel)).toContain('`proj`');
    expect(lastMarkdown(h.channel)).toContain('`sonnet`');

    // 别名以 scoped key 存储,通过反查 scoped key 断言
    const scopedKey = Object.keys(h.workspaces.listNamed()).find((k) => k.endsWith('proj'))!;
    expect(h.workspaces.namedModelFor(scopedKey)).toBe('sonnet');

    await h.run('/model ws proj reset');
    expect(h.workspaces.namedModelFor(scopedKey)).toBeUndefined();

    await h.run('/model ws nosuch sonnet');
    expect(lastMarkdown(h.channel)).toContain('未找到工作目录别名');
  });

  it('shows usage for malformed input', async () => {
    const h = await createHarness();
    await h.run('/model ws');
    expect(lastMarkdown(h.channel)).toContain('用法');
  });
});

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('model-cmd-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const workspaceRealpath = await realpath(tmp.workspace);
  const profileConfig = appConfig(workspaceRealpath);
  const configPath = join(tmp.root, 'config.json');
  await saveRootConfig(createRootConfig('claude', profileConfig), configPath);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  workspaces.setCwd('chat-1', workspaceRealpath);

  const run = (content: string, senderId = 'ou-admin'): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content, { chatId: 'chat-1', senderId }),
      scope: 'chat-1',
      chatMode: 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      controls,
    });

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, sessions, workspaces, controls, run };
}

function appConfig(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
    preferences: { maxConcurrentRuns: 2 },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(content: string, opts: { chatId: string; senderId: string }): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: opts.chatId,
    chatType: 'p2p',
    senderId: opts.senderId,
    senderName: 'User',
    content,
    resources: [],
    mentions: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = lastContent(channel);
  expect(content.markdown).toBeTypeOf('string');
  return content.markdown as string;
}
