/**
 * Runtime configuration, role state and filesystem roots for evaluator processes.
 *
 * Callers load and snapshot the declared runtime policy, materialize per-role
 * state from seeds and shared caches, and validate the roots a sandboxed process
 * may read or write. Seed hashing, cache linking and path discovery stay inside.
 */
export {
  RUNTIME_ROLES,
  type RuntimeConfiguration,
  type RuntimePolicy,
  type RuntimeRole,
} from "./policy";
export {
  loadRuntimeConfiguration,
  runtimeLocalHttpEnabled,
  runtimeNativeGoalEnabled,
  runtimePolicySnapshot,
  runtimeSeedSources,
} from "./config";
export {
  canonicalRuntimeRoot,
  insideRuntimeRoot,
  isRuntimeHomeRoot,
  requireRuntimeReadRoots,
  runtimeExecutableProtection,
} from "./paths";
export {
  requireWritableCacheRoots,
  sharedCacheDenyRoots,
  sharedCacheRoots,
} from "./shared-cache";
export {
  requireArtifactDirectories,
  type RuntimeArtifactDirectory,
} from "./artifact-directories";
export { runtimeSeedDigest } from "./seeds";
export { prepareRuntimeState, runtimeObservations } from "./state";
