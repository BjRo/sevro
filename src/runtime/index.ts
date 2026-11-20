/**
 * Runtime configuration, role state and filesystem roots for evaluator processes.
 *
 * Callers load and snapshot the declared runtime policy, materialize per-role
 * state from seeds and shared caches, and validate the roots a sandboxed process
 * may read or write. It also owns the private native state namespace and the
 * per-trial candidate runtime, which retains candidate artifacts and any
 * private state a host binds to it. Seed
 * hashing, cache linking and path discovery stay inside.
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
export {
  allocateNativeState,
  nativeStateParent,
  nativeStatePath,
  nativeStateProtectedRoots,
  requireNativeHookRoots,
  requireNativeTranscriptView,
  requireNativeTranscriptViews,
} from "./native-transcript-state";
export {
  candidateGrantEnvironment,
  candidateGrantReadRoots,
  candidateTranscriptReadRoots,
  prepareRoleEnvironment,
  prepareRoleRuntime,
  rolePath,
  undeclaredRuntimePolicy,
  uvRuntimeEnvironment,
  type CandidateGrants,
  type RoleProcess,
  type RoleRuntime,
} from "./role-environment";
export {
  allocateCandidateRuntime,
  candidateArtifactEnvironment,
  candidateArtifactReadRoots,
  candidateArtifactRoots,
  candidatePrivateStateRetained,
  releaseCandidateRuntime,
  requireCandidateArtifactRoots,
  requireCandidateRuntime,
  retainCandidatePrivateState,
  type CandidateArtifactPath,
  type CandidateArtifactRoots,
} from "./candidate-artifacts";
