# 按 profile / workspace / scope 设置模型 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 bridge 增加 model 配置源，优先级 scope > named workspace > profile > claude CLI 默认，通过 `/model` 命令和 `/config` 卡片设置。

**Architecture:** `WorkspaceStore`（`workspaces.json`）扩展存储 scope/workspace 两级 model；`AppPreferences` 增加 `model` 字段存 profile 级；`startRunFlow` 统一解析后经既有 `executor.submit({ model })` 管道传入 adapter 的 `--model`。PTY 池按 sessionId 复用，model 变更随新 session 天然生效，无需改池。

**Tech Stack:** TypeScript (ESM, tsx)、vitest。

**Spec:** `docs/superpowers/specs/2026-09-27-per-profile-workspace-model-design.md`

## Global Constraints

- 禁止 `vitest` watch 模式；只跑 `pnpm test:unit` / `pnpm test:integration` 等既有脚本或 `npx vitest run <file>`，且一次只跑最窄范围
- 不传 `--pool` / `--poolOptions`；并发跑测试的 subagent 一次只允许一个在跑 vitest
- model 值不校验（任意字符串透传），空串 = 未设置
- 用户可见文案用中文，与现有命令回复风格一致（`✅`/`✓` 前缀、反引号包值）
- 提交信息风格与仓库一致（如 `feat(model): ...`），结尾加 `Co-Authored-By: Claude Code <noreply@anthropic.com>`

---

### Task 1: WorkspaceStore 扩展（model 存储 + named 对象形态）

**Files:**
- Modify: `src/workspace/store.ts`
- Create: `tests/unit/workspace/store.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces（后续任务依赖的精确签名）:
  - `modelFor(chatId: string): string | undefined`
  - `setModel(chatId: string, model: string | null): void`（null = 清除；无 cwd 时允许 model-only 条目；清空后条目为空则删除 key）
  - `namedModelFor(name: string): string | undefined`
  - `setNamedModel(name: string, model: string | null): boolean`（false = 别名不存在）
  - `namedModelForCwd(cwdRealpath: string): string | undefined`（realpath 匹配，多个带 model 的别名命中同一目录时取第一个）
  - 既有 `getNamed`/`listNamed`/`saveNamed` 签名不变（named 值兼容旧字符串/新对象两形态）

- [ ] **Step 1: 写失败的单测**

创建 `tests/unit/workspace/store.test.ts`：

```ts
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
  });

  it('reads on-disk object named entries and mixed forms', async () => {
    const { store: s1, path } = await newStore();
    s1.saveNamed('plain', '/tmp/x');
    s1.setNamedModel('rich', 'sonnet');
    s1.saveNamed('rich', '/tmp/y');
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
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/workspace/store.test.ts`
Expected: FAIL（`modelFor`/`setModel`/`namedModelFor`/`setNamedModel`/`namedModelForCwd` 不存在）

- [ ] **Step 3: 实现 store 扩展**

修改 `src/workspace/store.ts`，完整新内容：

```ts
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/** Per-scope entry. `cwd` is absent for model-only entries (scope set a model
 *  via `/model` before any `/cd` binding); falls through to the profile
 *  default cwd in that case. */
interface ChatEntry {
  cwd?: string;
  model?: string;
}

/** Named alias entry. Legacy configs stored a bare cwd string; new writes use
 *  the object form so a model can ride along. Both read paths normalize. */
type NamedEntry = string | { cwd: string; model?: string };

interface WorkspaceData {
  chats: Record<string, ChatEntry>;
  named: Record<string, NamedEntry>;
}

export class WorkspaceStore {
  private data: WorkspaceData = { chats: {}, named: {} };
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.workspacesFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Partial<WorkspaceData>;
      this.data = {
        chats: parsed.chats ?? {},
        named: parsed.named ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  cwdFor(chatId: string): string | undefined {
    return this.data.chats[chatId]?.cwd;
  }

  setCwd(chatId: string, cwd: string): void {
    this.data.chats[chatId] = { ...this.data.chats[chatId], cwd };
    this.schedulePersist();
  }

  modelFor(chatId: string): string | undefined {
    return this.data.chats[chatId]?.model;
  }

  /** Set (or clear with null) the scope-level model override. Survives `/cd`
   *  switches; an entry left with neither cwd nor model is removed. */
  setModel(chatId: string, model: string | null): void {
    const prev = this.data.chats[chatId] ?? {};
    const next: ChatEntry = model === null ? { ...prev, model: undefined } : { ...prev, model };
    if (next.cwd === undefined && next.model === undefined) {
      delete this.data.chats[chatId];
    } else {
      this.data.chats[chatId] = next;
    }
    this.schedulePersist();
  }

  removeCwd(chatId: string): boolean {
    if (!(chatId in this.data.chats)) return false;
    delete this.data.chats[chatId];
    this.schedulePersist();
    return true;
  }

  listCwds(prefix?: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.data.chats)) {
      if (value.cwd === undefined) continue;
      if (prefix && !key.startsWith(prefix)) continue;
      out[key] = value.cwd;
    }
    return out;
  }

  listNamed(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.data.named)) {
      const cwd = this.namedCwd(value);
      if (cwd !== undefined) out[key] = cwd;
    }
    return out;
  }

  getNamed(name: string): string | undefined {
    return this.namedCwd(this.data.named[name]);
  }

  namedModelFor(name: string): string | undefined {
    return typeof this.data.named[name] === 'object' ? this.data.named[name].model : undefined;
  }

  saveNamed(name: string, cwd: string): void {
    const prev = this.data.named[name];
    const prevModel = typeof prev === 'object' ? prev.model : undefined;
    this.data.named[name] = prevModel ? { cwd, model: prevModel } : { cwd };
    this.schedulePersist();
  }

  /** Set (or clear with null) the model on an existing named alias.
   *  Returns false when the alias does not exist. */
  setNamedModel(name: string, model: string | null): boolean {
    if (!(name in this.data.named)) return false;
    const cwd = this.namedCwd(this.data.named[name]) ?? '';
    this.data.named[name] = model === null ? { cwd } : { cwd, model };
    this.schedulePersist();
    return true;
  }

  /** Reverse lookup: the model of the first named alias whose cwd resolves to
   *  `cwdRealpath`. Aliases without a model are skipped so "first match with
   *  a model" wins regardless of insertion order of bare-cwd aliases. */
  namedModelForCwd(cwdRealpath: string): string | undefined {
    for (const entry of Object.values(this.data.named)) {
      const model = typeof entry === 'object' ? entry.model : undefined;
      if (!model) continue;
      const cwd = this.namedCwd(entry) ?? '';
      let resolved = cwd;
      try {
        resolved = realpathSync(cwd);
      } catch {
        // missing dir etc. — fall back to raw comparison
      }
      if (resolved === cwdRealpath) return model;
    }
    return undefined;
  }

  removeNamed(name: string): boolean {
    if (!(name in this.data.named)) return false;
    delete this.data.named[name];
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private namedCwd(entry: NamedEntry | undefined): string | undefined {
    if (entry === undefined) return undefined;
    return typeof entry === 'string' ? entry : entry.cwd;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => {
        log.fail('workspace', err, { step: 'persist' });
      });
  }
}
```

注意：`JSON.stringify` 会自动丢弃值为 `undefined` 的键，所以 model-only/cwd-only 条目落盘是干净的对象。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/workspace/store.test.ts`
Expected: PASS（5 个用例全过）

- [ ] **Step 5: 跑受影响的既有测试**

Run: `npx vitest run tests/integration/commands/commands-v1.test.ts`
Expected: PASS（`/cd`、`/ws` 契约不回归）

- [ ] **Step 6: Commit**

```bash
git add src/workspace/store.ts tests/unit/workspace/store.test.ts
git commit -m "feat(model): workspace store 支持 scope/named 两级 model 存储

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: preferences.model + getProfileModel + resolveRunModel 解析函数

**Files:**
- Modify: `src/config/schema.ts`（`AppPreferences` 加字段 + getter）
- Create: `src/workspace/model.ts`
- Create: `tests/unit/workspace/model.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `WorkspaceStore.modelFor` / `namedModelForCwd`
- Produces:
  - `AppPreferences.model?: string`（profile 级默认模型，任意字符串）
  - `getProfileModel(cfg: AppConfig): string | undefined`（trim，空 → undefined）
  - `resolveRunModel(input: { workspaces: WorkspaceStore; scopeId: string; cwdRealpath: string; profileModel?: string }): string | undefined`

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/workspace/model.test.ts`：

```ts
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
  cleanups.push(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });
  const store = new WorkspaceStore(join(dir, 'workspaces.json'));
  await store.load();
  return store;
}

describe('resolveRunModel precedence', () => {
  it('falls through scope > named-workspace > profile > unset', async () => {
    const workspaces = await newStore();
    workspaces.saveNamed('proj', '/tmp/proj');
    workspaces.setNamedModel('proj', 'ws-model');
    workspaces.setCwd('chat-1', '/tmp/proj');

    // 全部未设 → undefined（claude CLI 默认）
    expect(resolveRunModel({ workspaces, scopeId: 'chat-x', cwdRealpath: '/tmp/proj', profileModel: undefined })).toBeUndefined();

    // 仅 profile
    expect(resolveRunModel({ workspaces, scopeId: 'chat-x', cwdRealpath: '/tmp/proj', profileModel: 'sonnet' })).toBe('sonnet');

    // profile 空串按未设置处理
    expect(resolveRunModel({ workspaces, scopeId: 'chat-x', cwdRealpath: '/tmp/proj', profileModel: '  ' })).toBeUndefined();

    // named workspace 命中 cwd 覆盖 profile
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
```

（注：`/tmp/proj` 不存在不影响 —— `namedModelForCwd` 的 realpath 失败时回退字符串比较，正好覆盖该分支。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/workspace/model.test.ts`
Expected: FAIL（`src/workspace/model.ts` 不存在；`model` 字段/getter 未定义导致类型或断言失败）

- [ ] **Step 3: 实现**

3a. `src/config/schema.ts` — 在 `AppPreferences` 的 `claudeDriver` 字段后追加：

```ts
  /**
   * Profile-level default claude model, passed through as `--model`.
   * Free-form string (validated by the claude CLI itself). Empty / unset
   * means "let the claude CLI decide". Overridden per named workspace and
   * per scope — see `/model`.
   */
  model?: string;
```

并在 `getClaudeDriver` 同区域追加 getter：

```ts
/** Profile-level default model. Blank / unset ⇒ let the CLI decide. */
export function getProfileModel(cfg: AppConfig): string | undefined {
  const raw = cfg.preferences?.model?.trim();
  return raw ? raw : undefined;
}
```

3b. 创建 `src/workspace/model.ts`：

```ts
import type { WorkspaceStore } from './store';

export interface RunModelInput {
  workspaces: WorkspaceStore;
  scopeId: string;
  cwdRealpath: string;
  profileModel?: string;
}

/**
 * Resolve the claude model for a run: scope override > named-workspace entry
 * matching the run cwd (realpath) > profile default > unset (claude CLI
 * decides). Blank profile values count as unset.
 */
export function resolveRunModel(input: RunModelInput): string | undefined {
  const scopeModel = input.workspaces.modelFor(input.scopeId);
  if (scopeModel) return scopeModel;
  const wsModel = input.workspaces.namedModelForCwd(input.cwdRealpath);
  if (wsModel) return wsModel;
  const profileModel = input.profileModel?.trim();
  return profileModel ? profileModel : undefined;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/workspace/model.test.ts`
Expected: PASS

- [ ] **Step 5: 跑 config schema 既有测试**

Run: `npx vitest run tests/unit/config/schema.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts src/workspace/model.ts tests/unit/workspace/model.test.ts
git commit -m "feat(model): preferences.model 字段与三级优先级解析函数

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: startRunFlow 接线（解析并传给 executor.submit）

**Files:**
- Modify: `src/bot/run-flow.ts:96-99`（cwd 解析处）及 `:205-219`（submit 调用处）
- Modify: `tests/integration/bot/im-run-flow.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `resolveRunModel`；既有 `SubmitRunInput.model?: string`
- Produces: `startRunFlow` 产生的 run 其 `agent.run` options 带 `model`（FakeAgentAdapter 的 `runOptions[0].model` 可断言）

- [ ] **Step 1: 写失败的集成测试**

在 `tests/integration/bot/im-run-flow.test.ts` 的 `describe('IM run flow', ...)` 内追加（放在最后一个 `it` 之后）：

```ts
  it('resolves the run model from scope > named workspace > profile', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    const workspaceRealpath = await realpath(h.tmp.workspace);

    // profile 级：直接生效
    h.profileConfig.preferences.model = 'sonnet';
    await startRunFlow(h.flowInput());
    expect(h.agent.runOptions.at(-1)?.model).toBe('sonnet');

    // named workspace 级：绑定 cwd 的别名覆盖 profile
    h.workspaces.saveNamed('proj', workspaceRealpath);
    h.workspaces.setNamedModel('proj', 'opus');
    await startRunFlow(h.flowInput());
    expect(h.agent.runOptions.at(-1)?.model).toBe('opus');

    // scope 级：最高优先
    h.workspaces.setModel('chat-1', 'haiku');
    await startRunFlow(h.flowInput());
    expect(h.agent.runOptions.at(-1)?.model).toBe('haiku');

    // 清除后逐级回落
    h.workspaces.setModel('chat-1', null);
    await startRunFlow(h.flowInput());
    expect(h.agent.runOptions.at(-1)?.model).toBe('opus');
  });

  it('omits model entirely when no level sets it', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    await startRunFlow(h.flowInput());
    expect(h.agent.runOptions.at(-1)?.model).toBeUndefined();
  });
```

同时在文件底部 harness 返回对象和类型中补充一个 `flowInput` 便捷函数（在 `createHarness` 的 return 之前定义并加进返回值）：

```ts
  const flowInput = () => ({
    scopeId: 'chat-1',
    scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
    prompt: 'hello',
    attachments: [],
    access: { ok: true, reason: 'allowed-user' },
    capability: claudeCapability(profileConfig),
    profileConfig,
    sessions,
    workspaces,
    executor,
    now: 1000,
  });
```

返回类型相应加 `flowInput: () => Parameters<typeof startRunFlow>[0];`（harness 内既有变量名以文件实际为准：`profileConfig`、`sessions`、`workspaces`、`executor`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/integration/bot/im-run-flow.test.ts`
Expected: FAIL（新用例 `model` 为 `undefined` —— startRunFlow 尚未传 model）

- [ ] **Step 3: 实现 run-flow 接线**

`src/bot/run-flow.ts`：

3a. 顶部 import 增加：

```ts
import { resolveRunModel } from '../workspace/model';
```

3b. `startRunFlow` 中 `resolveWorkingDirectory` 成功后（`const workspace = ...` 的 if 块之后、`evaluateRunPolicy` 之前）加：

```ts
  const model = resolveRunModel({
    workspaces: input.workspaces,
    scopeId: input.scopeId,
    cwdRealpath: workspace.cwdRealpath,
    profileModel: input.profileConfig.preferences.model,
  });
```

3c. `executor.submit({...})` 调用中（`threadId` 之后）加一行：

```ts
      model,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/integration/bot/im-run-flow.test.ts`
Expected: PASS（含既有用例不回归）

- [ ] **Step 5: Commit**

```bash
git add src/bot/run-flow.ts tests/integration/bot/im-run-flow.test.ts
git commit -m "feat(model): startRunFlow 解析三级 model 并传入 executor

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: /model 命令 + help/README 文档

**Files:**
- Modify: `src/commands/index.ts`（handlers 注册 + `handleModel`）
- Modify: `src/card/templates.ts:259` 附近（help 命令清单）
- Modify: `README.md:157` 附近（命令表）
- Create: `tests/integration/commands/model-command.test.ts`

**Interfaces:**
- Consumes: Task 1 的 store API；Task 2 的 `getProfileModel`；既有 `effectiveWorkspaceCwd` / `workspaceAliasKeys` / `canRunAdminCommand` / `resolveWorkingDirectory` / `reply`
- Produces: `/model` 命令；scope 级非管理员可用，`ws` 子命令管理员可用（handler 内部 gate，不进 `ADMIN_COMMANDS`）

- [ ] **Step 1: 写失败的集成测试**

创建 `tests/integration/commands/model-command.test.ts`（harness 仿 `tests/integration/commands/commands-v1.test.ts`，含 `lastMarkdown`/`lastContent` 辅助——直接从该文件复制这两个 helper 与 `message` 函数）：

```ts
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs';
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
```

（`lastMarkdown` / `lastContent` 从 `commands-v1.test.ts` 原样复制。）

harness 与 helper 放同文件底部：

```ts
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

// lastMarkdown / lastContent：从 tests/integration/commands/commands-v1.test.ts 原样复制
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/integration/commands/model-command.test.ts`
Expected: FAIL（`/model` 未注册，`tryHandleCommand` 返回 false，无回复可断言）

- [ ] **Step 3: 实现 handleModel**

`src/commands/index.ts`：

3a. import 区补 `getProfileModel`（来自 `../config/schema`，查看该文件已有 schema import 行并合并）。

3b. `handlers` 表（`:206-226`）注册（放 `/timeout` 之后）：

```ts
  '/model': handleModel,
```

不加入 `ADMIN_COMMANDS`（scope 级操作对全体开放，与 `/timeout` 一致；`ws` 子命令在 handler 内部单独 gate）。

3c. 在 `handleTimeout` 附近新增：

```ts
async function handleModel(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';

  if (sub === '') return showModelStatus(ctx);

  if (sub === 'reset') {
    ctx.workspaces.setModel(ctx.scope, null);
    log.info('command', 'model-reset', { scope: ctx.scope });
    await reply(ctx, '✅ 已清除当前会话的模型设置,回退到工作目录/profile 默认。');
    return;
  }

  if (sub === 'ws') {
    if (!canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
      await reply(ctx, '❌ 设置工作目录的模型仅管理员可用。');
      return;
    }
    const name = parts[1] ?? '';
    const value = parts.slice(2).join(' ').trim();
    if (!name || !value) {
      await reply(ctx, '用法：`/model ws <name> <model>` 或 `/model ws <name> reset`');
      return;
    }
    const key = workspaceAliasKeys(ctx, name).find((k) => ctx.workspaces.getNamed(k) !== undefined);
    if (!key) {
      await reply(ctx, `未找到工作目录别名：\`${name}\``);
      return;
    }
    if (value === 'reset') {
      const cleared = ctx.workspaces.setNamedModel(key, null);
      log.info('command', 'model-ws-reset', { scope: ctx.scope, name });
      await reply(
        ctx,
        cleared ? `✅ 已清除 \`${name}\` 的模型设置。` : `\`${name}\` 本来就没设过模型。`,
      );
      return;
    }
    ctx.workspaces.setNamedModel(key, value);
    log.info('command', 'model-ws-set', { scope: ctx.scope, name });
    await reply(
      ctx,
      `✅ 已设置 \`${name}\` 的模型为 \`${value}\`\n（绑定它的新 session 生效;进行中的会话不受影响）`,
    );
    return;
  }

  const model = args.trim();
  ctx.workspaces.setModel(ctx.scope, model);
  log.info('command', 'model-set', { scope: ctx.scope });
  await reply(
    ctx,
    `✅ 已设置当前会话的模型为 \`${model}\`\n（进行中的会话仍用旧模型;新 session 生效,可用 \`/new\` 立即生效）`,
  );
}

async function showModelStatus(ctx: CommandContext): Promise<void> {
  const scopeModel = ctx.workspaces.modelFor(ctx.scope);
  let wsModel: string | undefined;
  const cwd = effectiveWorkspaceCwd(ctx);
  if (cwd) {
    const workspace = await resolveWorkingDirectory(cwd);
    if (workspace.ok) wsModel = ctx.workspaces.namedModelForCwd(workspace.cwdRealpath);
  }
  const profileModel = getProfileModel(ctx.controls.cfg);
  const effective =
    scopeModel ?? wsModel ?? profileModel ?? undefined;
  const lines = [
    `🤖 当前生效模型:${effective ? `\`${effective}\`` : 'claude 默认'}`,
    `- 会话覆盖:${scopeModel ? `\`${scopeModel}\`` : '未设置'}`,
    `- 工作目录:${wsModel ? `\`${wsModel}\`` : '未设置'}`,
    `- profile 默认:${profileModel ? `\`${profileModel}\`` : '未设置'}`,
  ];
  const source = scopeModel ? '会话' : wsModel ? '工作目录' : profileModel ? 'profile' : 'claude 默认';
  lines[0] = `🤖 当前生效模型:${effective ? `\`${effective}\`（来源:${source}）` : 'claude 默认'}`;
  const usage =
    '\n\n用法:\n- `/model <name>` 当前会话设置模型\n- `/model reset` 清除会话设置\n- `/model ws <name> <model>` 设置命名工作目录的模型(管理员)\n- `/model ws <name> reset` 清除工作目录模型\n\n_注:进行中的会话继续用旧模型,新 session 生效;`/new` 立即生效_';
  await reply(ctx, lines.join('\n') + usage);
}
```

3d. `src/card/templates.ts` help 命令清单 `/timeout` 行后加：

```ts
        '- `/model [name|reset]` — 设置/清除当前会话的模型;`/model ws <name> <model>` 设置命名工作目录模型',
```

3e. `README.md` 命令表 `/timeout` 行后加：

```markdown
| `/model [name\|reset]` | Set or clear the model for this session (scope > workspace > profile) |
| `/model ws <name> <model\|reset>` | Set or clear the model bound to a named workspace (admin) |
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/integration/commands/model-command.test.ts`
Expected: PASS

- [ ] **Step 5: 跑命令相关既有测试**

Run: `npx vitest run tests/integration/commands/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/commands/index.ts src/card/templates.ts README.md tests/integration/commands/model-command.test.ts
git commit -m "feat(model): /model 命令(会话/工作目录两级设置与查看)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: /config 卡片 model 字段（profile 级）

**Files:**
- Modify: `src/card/config-card.ts`（`ConfigFormOpts` + 表单 + 已保存卡片）
- Modify: `src/commands/index.ts:1950-1964`（showConfigForm 传参）、`:1997-2100`（submitConfig 解析与写回）
- Create: `tests/unit/card/config-form-model.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `getProfileModel`、`AppPreferences.model`
- Produces: 表单字段 `model`（input 文本框，name=`model`）；`ConfigFormOpts.model: string`（'' = 未设置）；提交空串 = 清除 profile model

- [ ] **Step 1: 写失败的单测**

创建 `tests/unit/card/config-form-model.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/card/config-form-model.test.ts`
Expected: FAIL（`ConfigFormOpts` 无 `model`，TS 报错）

- [ ] **Step 3: 实现**

3a. `src/card/config-card.ts`：`ConfigFormOpts` 的 `claudeDriver` 字段后加：

```ts
  /** Profile-level default model. '' means unset (claude CLI decides). */
  model: string;
```

表单 `claude_driver` select 之后追加元素：

```ts
            {
              tag: 'markdown',
              content:
                '\n**默认模型**\n' +
                '_profile 级默认模型,直接传给 claude 的 --model,如 `sonnet` / `opus` / 完整模型 ID_\n' +
                '_留空 = 不设置(使用 claude CLI 默认);会被会话级 `/model` 覆盖_',
            },
            {
              tag: 'input',
              name: 'model',
              default_value: opts.model,
              placeholder: { tag: 'plain_text', content: 'sonnet' },
              input_type: 'text',
            },
```

`configSavedCard` 的 `**Claude 驱动**` 行后加：

```ts
            `**默认模型**:\`${opts.model || '未设置'}\`\n` +
```

3b. `src/commands/index.ts` `showConfigForm`：`configFormCard({...})` 参数 `claudeDriver` 行后加：

```ts
    model: getProfileModel(ctx.controls.cfg) ?? '',
```

3c. `submitConfig`：`rawDriver` 解析之后加：

```ts
  // Free-form model string; empty clears the profile-level default.
  const rawModel = String(fv.model ?? '').trim();
  const model = rawModel === '' ? undefined : rawModel;
```

`nextPreferences` 对象中 `claudeDriver,` 之后加：

```ts
      model,
```

（`model: undefined` 会从落盘 JSON 中消失，等价于清除。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/card/config-form-model.test.ts`
Expected: PASS

- [ ] **Step 5: 跑 config 相关既有测试**

Run: `npx vitest run tests/unit/card/ tests/integration/commands/profile-config-command.test.ts`
Expected: PASS（若 `config-form-message-reply.test.ts` 对表单结构有精确断言导致失败，按其断言风格补上 model 字段后重跑）

- [ ] **Step 6: Commit**

```bash
git add src/card/config-card.ts src/commands/index.ts tests/unit/card/config-form-model.test.ts
git commit -m "feat(model): /config 卡片新增 profile 级默认模型字段

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 全量验证

- [ ] **Step 1: 类型检查**

Run: `pnpm typecheck`（若无此脚本则 `npx tsc --noEmit`）
Expected: 无错误

- [ ] **Step 2: 全量测试**

Run: `pnpm test`
Expected: 全部 PASS

- [ ] **Step 3: 如全部通过，收尾提交（若有残留改动）**

```bash
git status --short
# 若有未提交文件（不应有）按所属任务补提交
```
