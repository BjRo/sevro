/**
 * Codex thread-tree usage.
 *
 * Measures token usage for one Codex root thread and every subagent it
 * spawned, from the native rollouts in a private Codex home, and returns the
 * bounded `sevro.codex.usage` observation that states its scope. Session
 * discovery, spawn linkage, cumulative-total handling and completeness rules
 * stay inside.
 */
export { codexTreeUsage, type CodexTreeUsage } from "./codex-tree-usage";
