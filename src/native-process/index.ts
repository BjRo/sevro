/**
 * Native host processes.
 *
 * Supervises one native Claude or Codex child process: admission and
 * cancellation, the execution deadline, bounded event and stderr capture, and
 * termination of the owned process group. Failures carry the host, phase and
 * retained output. Execution budgets share one validity rule.
 */
export { runClaudeProcess } from "./claude-process";
export { CodexProcessFailure, runCodexProcess } from "./codex-process";
export {
  MAX_EVENT_BYTES,
  MAX_STDERR_BYTES,
  validHostTimeout,
} from "./process-lifecycle";
