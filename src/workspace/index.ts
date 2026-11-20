/**
 * Runner-owned candidate workspaces in a private on-disk namespace.
 *
 * Allocation, retention, removal and expiry share one ownership record, and the
 * namespace path is the deny root that isolation and runtime policies protect.
 * The run owner record identifies the live process that owns a run and its
 * checkpoints.
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
export { clearWorkspaceContents, removeDisposableDirectory } from "./cleanup";
export { checkpointRunOwner, startRunOwner, type RunOwner } from "./run-owner";
export { workspaceFingerprint } from "./fingerprint";
