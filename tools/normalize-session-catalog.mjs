#!/usr/bin/env node
/**
 * 归一化 session catalog 存量数据：按 scopeId（群）分组，每组只保留一个 active。
 *
 * 背景：历史上 /cd 与 /ws use 切换工作区时不归档旧 catalog 条目（已于 2026-08 修复），
 * 切走的旧条目会永远停留在 active，导致 admin 面板误标「活跃」。
 *
 * 规则（每 scope）：
 *   1. winner 优先取 sessions.json 中该 scope 当前 sessionId 命中的条目（运行时真相）；
 *   2. 命中不到再退回 updatedAt 最新的条目（catalog updatedAt 可能滞后，仅作兜底）；
 *   3. winner 置 active，其余全部置 archived。
 *
 * 用法：
 *   node tools/normalize-session-catalog.mjs --profile claude          # 干跑，只打印报告
 *   node tools/normalize-session-catalog.mjs --profile claude --apply  # 备份后写回
 *
 * 注意：--apply 前会检查 bridge daemon 是否在运行（catalog 在内存中，运行时改文件会被覆盖），
 *       在运行则拒绝执行。
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const profile = value('--profile', 'claude');
const apply = flag('--apply');
const profileDir = join(homedir(), '.lark-channel', 'profiles', profile);
const catalogPath = join(profileDir, 'sessions.json.catalog.json');
const sessionsPath = join(profileDir, 'sessions.json');

if (apply) {
  try {
    const ps = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' });
    const running = ps
      .split('\n')
      .filter((line) => line.includes('lark-channel-bridge') && line.includes(`--profile ${profile}`));
    if (running.length > 0) {
      console.error(`✗ bridge daemon 正在运行（--profile ${profile}），内存态会覆盖文件修改。`);
      console.error('  请先执行: lark-channel-bridge stop --profile ' + profile);
      process.exit(1);
    }
  } catch {
    // ps 失败不阻塞，仅失去保护
  }
}

let catalog;
try {
  catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
} catch (err) {
  console.error(`✗ 无法读取 catalog：${catalogPath}\n  ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(catalog)) {
  console.error(`✗ catalog 顶层不是数组，格式异常，拒绝处理。`);
  process.exit(1);
}

/** scope -> sessionId（运行时当前绑定） */
let currentSessions = {};
try {
  const raw = JSON.parse(readFileSync(sessionsPath, 'utf8'));
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) currentSessions = raw;
} catch {
  console.warn('! 未读到 sessions.json，winner 仅按 updatedAt 兜底判定');
}

// 按 scope 分组
const byScope = new Map();
for (const entry of catalog) {
  if (!entry || typeof entry !== 'object' || typeof entry.scopeId !== 'string') continue;
  if (!byScope.has(entry.scopeId)) byScope.set(entry.scopeId, []);
  byScope.get(entry.scopeId).push(entry);
}

const now = Date.now();
const changes = [];
for (const [scopeId, entries] of byScope) {
  const currentSessionId = currentSessions[scopeId]?.sessionId;
  let winner =
    (currentSessionId && entries.find((e) => e.sessionId === currentSessionId)) || undefined;
  let reason = currentSessionId ? 'sessions.json 当前绑定' : 'sessions.json 无记录，updatedAt 兜底';
  if (!winner) {
    winner = [...entries].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    reason = currentSessionId ? '当前 sessionId 未命中条目，updatedAt 兜底' : reason;
  }
  for (const entry of entries) {
    if (entry === winner) {
      if (entry.status !== 'active') {
        changes.push({ entry, from: entry.status, to: 'active', scopeId, reason: `${reason}（反向修复）` });
      }
      continue;
    }
    if (entry.status !== 'archived') {
      changes.push({ entry, from: entry.status, to: 'archived', scopeId, reason });
    }
  }
}

if (changes.length === 0) {
  console.log('✓ catalog 已是一致状态（每 scope 至多一个 active 且为当前绑定），无需修改。');
  process.exit(0);
}

for (const c of changes) {
  const t = new Date(c.entry.updatedAt).toISOString().slice(5, 16).replace('T', ' ');
  console.log(
    `${c.from} -> ${c.to}  scope=${c.scopeId.slice(0, 16)}…  ${t}  ${c.entry.cwdRealpath}  sess=${(c.entry.sessionId || '').slice(0, 8)}  (${c.reason})`,
  );
}

if (!apply) {
  console.log(`\n共 ${changes.length} 条待修改。干跑模式，加 --apply 写回。`);
  process.exit(0);
}

for (const c of changes) {
  // 归档不刷 updatedAt：保留真实最后活跃时间，保证按 updatedAt 兜底选 winner 的排序稳定（幂等）
  c.entry.status = c.to;
}
const backup = `${catalogPath}.bak-${now}`;
copyFileSync(catalogPath, backup);
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`\n✓ 已写入 ${changes.length} 条修改；备份：${backup}`);
