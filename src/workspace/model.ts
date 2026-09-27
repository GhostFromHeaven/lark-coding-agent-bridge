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
