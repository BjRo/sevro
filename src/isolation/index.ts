/**
 * Build a validated isolation policy from workspace, evaluator protection, and
 * role grants. Policy renderers preserve SBPL and bwrap precedence; native
 * platform selection and command resource lifetimes stay inside this module.
 * Feature modules consume the same value for Codex TOML and Claude settings.
 */
export { prepareIsolatedCommand } from "./isolation";
export { HostIsolationError, type IsolatedCommand } from "./isolation-common";
export { evaluationProtectedRoots } from "./isolation-roots";
export { macSandboxProfile } from "./mac-sandbox";
export { linuxSandboxArguments } from "./linux-sandbox";
export {
  createIsolationPolicy,
  type IsolationOptions,
  type IsolationDescription,
  type IsolationPolicy,
  type IsolationProtection,
  type IsolationNetwork,
} from "./policy";
