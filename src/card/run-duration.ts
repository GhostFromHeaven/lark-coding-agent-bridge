import type { RunState } from './run-state';

export function runDurationText(state: RunState): string | undefined {
  const ms = state.durationMs;
  if (state.terminal === 'running' || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return undefined;
  }
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const label = hours > 0
    ? `${hours}h ${minutes}m ${seconds % 60}s`
    : minutes > 0
      ? `${minutes}m ${seconds % 60}s`
      : `${seconds % 60}s`;
  return `耗时${label}`;
}
