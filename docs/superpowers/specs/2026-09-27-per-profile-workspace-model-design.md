# 设计：按 profile / workspace / scope 设置模型

日期：2026-09-27
状态：已与用户确认（brainstorming 完成）

## 背景与目标

`model` 的透传管道已存在（`run-flow.ts` → `executor.submit({ model })` → PTY/headless 两条路径拼 `--model`），但上游没有任何配置源提供该值。本设计补齐配置源，支持三级粒度：

- **profile 级**：每个 profile 一个默认模型（`preferences.model`）
- **workspace 级**：named workspace（目录别名）绑定模型，任何 scope 绑定该 workspace 即生效
- **scope 级**：单个 chat / chat:thread 话题独立覆盖

优先级：**scope > workspace > profile > claude CLI 自身默认**。

## 现状要点（调研结论）

- `AgentRunOptions.model?: string`（`src/agent/types.ts`）与 `SubmitRunInput.model?: string`（`src/runtime/run-executor.ts`）已存在，两条 adapter 路径均已拼 `--model`
- workspace 存储：`profiles/<profile>/workspaces.json`，`{ chats: Record<scopeId, { cwd }>, named: Record<alias, string> }`（`src/workspace/store.ts`）
- PTY 池按 `sessionId` 复用（`src/agent/claude/pty-pool.ts`），model 只在 PTY spawn 时生效；scope 的 sessionId 存于 sessions.json
- `/cd`、`/ws use` 切换目录时会清空该 scope 的 session
- 已有 per-scope 配置先例：`/timeout`（`SessionEntry.idleTimeoutMinutes`）

## 数据结构与存储（向后兼容）

1. **profile 级**：`AppPreferences`（`src/config/schema.ts`）新增可选字段 `model?: string`。无默认值、不校验（任意字符串透传 `--model`，claude CLI 对非法值自行报错并按现有错误路径透传）。
2. **named workspace 级**：`WorkspaceData.named` 从 `Record<string, string>` 扩展为 `Record<string, string | { cwd: string; model?: string }>`。读取时归一化（旧字符串 → `{ cwd }`），写入统一用对象形态；旧数据文件无需迁移即可读取。
3. **scope 级**：`WorkspaceData.chats[scopeId]` 从 `{ cwd }` 扩展为 `{ cwd: string; model?: string }`，与 `/cd` 共用同一文件。

`WorkspaceStore` 新增 API：

- `modelFor(scopeId): string | undefined`
- `setModel(scopeId, model: string | null): void`（null = 清除，回落下一级）
- `namedModelFor(alias): string | undefined`
- `setNamedModel(alias, model: string | null): void`

## 解析链路

在 `src/bot/run-flow.ts` 现有 cwd 解析处（约 97-99 行）同步解析 model：

```
chats[scopeId].model
  → 反查 named 表：scope 的 cwd（realpath）命中的 named 条目的 model
  → profile preferences.model
  → 不传（claude CLI 默认）
```

named 反查规则：遍历 `named` 表比对 cwd（realpath）；多个别名指向同一目录时，取**第一个带 model 的条目**。`/cd`、`/ws use` 本身会清 session，因此切换 workspace 后新会话自然使用新 workspace 的 model。

解析结果通过 `startRunFlow` → `executor.submit({ model })` 传入，管道其余部分不变。

## /model 命令（多子命令式）

| 命令 | 行为 |
|---|---|
| `/model` | 显示当前生效 model 及来源（scope / workspace 别名 / profile / CLI 默认） |
| `/model <name>` | 设置当前 scope 的 model |
| `/model reset` | 清除 scope 设置（回落 workspace/profile） |
| `/model ws <alias> <name>` | 设置 named workspace 的 model |
| `/model ws <alias> reset` | 清除 workspace 的 model |

- model 值不校验，任意字符串
- 设置成功的回复附提示：进行中的会话仍用旧 model，新会话（或 `/reset` 后）生效
- 查看全员可用；设置类操作（设置/清除/ws 子命令）仅管理员，与 `/cd`、`/ws` 一致

## /config 卡片

`src/card/config-card.ts` 新增 `model` 文本输入框（profile 级默认，留空 = 不设置），保存走现有 `handleConfig` 回写逻辑。

## 生效语义

- **PTY 路径**：已有 PTY（同 sessionId）不受影响；session 重置 / 超时回收后新 PTY 使用新 model。无需修改 pty-pool。
- **headless 路径**：每次 run 新进程，立即生效。

## 测试

- `WorkspaceStore` 单测：named 字符串/对象两形态归一化、model set/clear、realpath 反查（含多别名同目录取第一个）
- 解析优先级单测：scope > workspace > profile > 默认 四级回落
- `/model` 命令处理单测：各子命令、来源显示、清除
- config 卡片 model 字段读写单测
