/**
 * Runner-owned candidate workspaces in a private on-disk namespace.
 *
 * Allocation, retention, removal and expiry share one ownership record, and the
 * namespace path is the deny root that isolation and runtime policies protect.
 */
export {
  allocateWorkspace,
  cleanupExpiredWorkspaces,
  removeWorkspace,
  retainWorkspace,
  workspaceBoundaryException,
  workspaceStateParent,
  workspaceStatePath,
} from "./workspace-state";
export { clearFixtureContents, removeDisposableDirectory } from "./cleanup";
