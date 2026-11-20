/**
 * Native host adapters.
 *
 * The native host request interface owns shared admission, private state
 * lifetime, observations, diagnostics and retention. Claude and Codex are its
 * two native hosts and supply native preparation and turns. Tests cross this
 * same seam with a fake native host.
 *
 * Skill invocation preparation resolves extension declarations through the owning
 * host rules. Runtime admission reuses those names, tokens, counts and paths while
 * verifying materialized mounts before native state allocation.
 *
 * Each factory validates one route's options and returns a host adapter that
 * runs the native Claude or Codex executable inside private runtime state,
 * then reports its result with bounded native observations. Codex routes may
 * import one explicit agent-concurrency setting from a canonical configuration
 * root. Credential staging, event parsing, native call and skill tracking,
 * process supervision and the Codex app-server transport stay inside.
 */
export { createClaudeHost, type ClaudeHostOptions } from "./claude";
export { createCodexHost, type CodexHostOptions } from "./codex";
export {
  codexAgentConcurrency,
  configurationRoot,
} from "./codex-configuration";
export {
  runNativeHostRequest,
  type NativeHost,
  type NativeHostRequestContext,
  type NativeHostRequestOutcome,
} from "./native-host-request";
export { claudeHostSettings } from "./claude-settings";

export {
  prepareHostInvocation,
  renderSkillInvocation,
  type InvocationPreparation,
  type PreparedInvocation,
} from "./skill-invocation";
export { verifyCodexInvocation } from "./codex-invocation";
export {
  verifyClaudeRepositoryMount,
  verifyClaudePluginInvocation,
} from "./claude-invocation";
