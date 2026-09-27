import { createHash } from "node:crypto";
import { summarizeClaudeEvents } from "./claude-events";

const MAX_RETAINED_CALLS = 128;
type Entry = Record<string, unknown>;

function record(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function label(value: unknown, max = 256): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= max &&
    /^[A-Za-z0-9_.:-]+$/.test(value)
    ? value
    : null;
}

interface SkillCall {
  ordinal: number;
  actor: "parent" | "nested";
  name: "Skill";
  skill: string;
  invocation: string;
}

interface AgentCall {
  ordinal: number;
  actor: "parent" | "nested";
  name: "Agent";
  toolUseId: string | null;
  subagentType: string | null;
  runInBackground: boolean | null;
  model: string | null;
  promptSha256: string | null;
  promptFirstLineSha256: string | null;
}

export interface ClaudeToolCallsObservation {
  id: "sevro.claude.tool-calls";
  completeness: "complete" | "partial";
  data: {
    method: "stream_tool_calls";
    calls: Array<SkillCall | AgentCall>;
    truncated: boolean;
  };
}

/** Retain ordered host call metadata, never tool prompts or results. */
export function claudeToolCallsObservation(
  stream: string,
  exitCode: number,
): ClaudeToolCallsObservation {
  const summary = summarizeClaudeEvents(stream, exitCode);
  const calls: Array<SkillCall | AgentCall> = [];
  let malformed = false;
  let truncated = false;
  let ordinal = 0;
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      malformed = true;
      continue;
    }
    if (!record(event) || event.type !== "assistant") continue;
    const blocks = record(event.message) ? event.message.content : null;
    if (!Array.isArray(blocks)) {
      malformed = true;
      continue;
    }
    const actor = label(event.parent_tool_use_id, 128) ? "nested" : "parent";
    if (
      event.parent_tool_use_id !== undefined &&
      event.parent_tool_use_id !== null &&
      actor === "parent"
    )
      malformed = true;
    for (const value of blocks) {
      if (!record(value) || value.type !== "tool_use") continue;
      ordinal++;
      if (!["Skill", "Agent", "Task"].includes(String(value.name))) continue;
      if (calls.length >= MAX_RETAINED_CALLS) {
        truncated = true;
        break;
      }
      const input = record(value.input) ? value.input : null;
      if (value.name === "Skill") {
        const invocation = label(input?.skill);
        if (!invocation) {
          malformed = true;
          continue;
        }
        calls.push({
          ordinal,
          actor,
          name: "Skill",
          skill: invocation.split(":").at(-1)!,
          invocation,
        });
        continue;
      }
      const toolUseId = label(value.id, 128);
      const subagentType = label(input?.subagent_type ?? input?.subagentType);
      const runInBackground =
        typeof input?.run_in_background === "boolean"
          ? input.run_in_background
          : null;
      const model = input?.model === undefined ? null : label(input.model, 128);
      const boundedPrompt =
        typeof input?.prompt === "string" &&
        Buffer.byteLength(input.prompt, "utf8") <= 1024 * 1024
          ? input.prompt
          : null;
      const promptSha256 = boundedPrompt
        ? createHash("sha256").update(boundedPrompt).digest("hex")
        : null;
      const promptFirstLineSha256 = boundedPrompt
        ? createHash("sha256")
            .update(boundedPrompt.split(/\r?\n/, 1)[0]!)
            .digest("hex")
        : null;
      if (
        !toolUseId ||
        !subagentType ||
        runInBackground === null ||
        (input?.model !== undefined && !model) ||
        !promptSha256
      )
        malformed = true;
      calls.push({
        ordinal,
        actor,
        name: "Agent",
        toolUseId,
        subagentType,
        runInBackground,
        model,
        promptSha256,
        promptFirstLineSha256,
      });
    }
    if (truncated) break;
  }
  return {
    id: "sevro.claude.tool-calls",
    completeness:
      summary.complete && !malformed && !truncated ? "complete" : "partial",
    data: { method: "stream_tool_calls", calls, truncated },
  };
}
