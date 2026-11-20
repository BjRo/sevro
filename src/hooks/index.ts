/**
 * Declared runtime hooks for host sessions.
 *
 * Hosts ask whether hooks are enabled, prepare sandboxed hook mounts for a role,
 * observe hook executions after a session, and release hook processes. Hook
 * command generation, receipts and process ownership stay inside.
 */
export {
  prepareHookMounts,
  releaseRuntimeHooks,
  runtimeHookObservation,
  runtimeHooksEnabled,
  type HookMounts,
} from "./hooks";
