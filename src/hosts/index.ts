/**
 * Native host adapters.
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
