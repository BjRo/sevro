/**
 * Native filesystem isolation for evaluator-owned and hook commands.
 *
 * Callers describe the workspace, protected roots and owned state; this module
 * selects the platform sandbox, validates every declared path, and returns a
 * launchable command. Platform profiles are exposed only for runtime hooks,
 * which compose their own sandboxed launch.
 */
export { prepareIsolatedCommand } from "./isolation";
export {
  HostIsolationError,
  type IsolatedCommand,
  type IsolationOptions,
} from "./isolation-common";
export { evaluationProtectedRoots } from "./isolation-roots";
export { macSandboxProfile } from "./mac-sandbox";
export { prepareLinuxSandboxCommand } from "./linux-sandbox";
