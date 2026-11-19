/**
 * Native host event streams.
 *
 * Parses the bounded JSON-lines event output of Claude and Codex and
 * summarizes one execution: its session or thread, completion, final message
 * and token usage. Malformed or oversized streams fail with a host-specific
 * event error instead of yielding a partial summary. The Claude stream also
 * yields bounded tool-call and skill-activation observations that never
 * retain prompts or tool results.
 */
export {
  ClaudeEventError,
  parseClaudeEvents,
  summarizeClaudeEvents,
  type ClaudeEvents,
} from "./claude-events";
export { claudeSkillActivationsObservation } from "./claude-skill-activations";
export {
  claudeToolCallsObservation,
  type ClaudeToolCallsObservation,
} from "./claude-tool-calls";
export {
  CodexEventError,
  summarizeCodexEvents,
  type CodexEventSummary,
} from "./codex-events";
