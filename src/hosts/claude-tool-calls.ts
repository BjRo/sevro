import { sha256 } from "../identity";
import { isRecord } from "../value-guards";
import { summarizeClaudeEvents } from "./claude-events";

const MAX_RETAINED_CALLS = 128;
type Entry = Record<string, unknown>;

function label(value: unknown, max = 256): string | null {
  return typeof value === "string" && boundedLabel(value, max) ? value : null;
}

interface SkillCall {
  ordinal: number;
  actor: "parent" | "nested";
  parentToolUseId: string | null;
  name: "Skill";
  skill: string;
  invocation: string;
}

interface AgentCall {
  ordinal: number;
  actor: "parent" | "nested";
  parentToolUseId: string | null;
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

interface CallState {
  calls: Array<SkillCall | AgentCall>;
  malformed: boolean;
  truncated: boolean;
  ordinal: number;
}
type Actor = { actor: "parent" | "nested"; parentToolUseId: string | null };

/** Retain ordered host call metadata, never tool prompts or results. */
export function claudeToolCallsObservation(
  stream: string,
  exitCode: number,
): ClaudeToolCallsObservation {
  const summary = summarizeClaudeEvents(stream, exitCode);
  const state: CallState = {
    calls: [],
    malformed: false,
    truncated: false,
    ordinal: 0,
  };
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    collectEvent(line, state);
    if (state.truncated) break;
  }
  return {
    id: "sevro.claude.tool-calls",
    completeness: callCompleteness(summary.complete, state),
    data: {
      method: "stream_tool_calls",
      calls: state.calls,
      truncated: state.truncated,
    },
  };
}

function callCompleteness(
  complete: boolean,
  state: CallState,
): "complete" | "partial" {
  return complete && !state.malformed && !state.truncated
    ? "complete"
    : "partial";
}

function collectEvent(line: string, state: CallState): void {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    state.malformed = true;
    return;
  }
  if (!isRecord(event) || event.type !== "assistant") return;
  collectAssistant(event, state);
}

function collectAssistant(event: Entry, state: CallState): void {
  const blocks: unknown = isRecord(event.message)
    ? event.message.content
    : null;
  if (!Array.isArray(blocks)) {
    state.malformed = true;
    return;
  }
  const actor = actorContext(event, state);
  for (const block of blocks) {
    collectBlock(block, actor, state);
    if (state.truncated) break;
  }
}

function actorContext(event: Entry, state: CallState): Actor {
  const parentToolUseId = label(event.parent_tool_use_id, 128);
  const actor = parentToolUseId ? "nested" : "parent";
  if (
    event.parent_tool_use_id !== undefined &&
    event.parent_tool_use_id !== null &&
    actor === "parent"
  )
    state.malformed = true;
  return { actor, parentToolUseId };
}

function collectBlock(value: unknown, actor: Actor, state: CallState): void {
  if (!isRecord(value) || value.type !== "tool_use") return;
  state.ordinal++;
  if (!["Skill", "Agent", "Task"].includes(String(value.name))) return;
  if (state.calls.length >= MAX_RETAINED_CALLS) {
    state.truncated = true;
    return;
  }
  collectSupportedCall(value, actor, state);
}

function collectSupportedCall(
  value: Entry,
  actor: Actor,
  state: CallState,
): void {
  const input = isRecord(value.input) ? value.input : {};
  if (value.name === "Skill") {
    collectSkill(input, actor, state);
    return;
  }
  const call = agentCall(value, input, actor, state.ordinal);
  if (!validAgentCall(call, input)) state.malformed = true;
  state.calls.push(call);
}

function collectSkill(input: Entry, actor: Actor, state: CallState): void {
  const invocation = label(input.skill);
  if (!invocation) {
    state.malformed = true;
    return;
  }
  state.calls.push({
    ordinal: state.ordinal,
    ...actor,
    name: "Skill",
    skill: invocation.slice(invocation.lastIndexOf(":") + 1),
    invocation,
  });
}

function boundedPrompt(input: Entry): string | null {
  if (typeof input.prompt !== "string") return null;
  return Buffer.byteLength(input.prompt, "utf8") <= 1024 * 1024
    ? input.prompt
    : null;
}

function promptDigest(prompt: string | null): string | null {
  return prompt ? sha256(prompt) : null;
}

function firstLineDigest(prompt: string | null): string | null {
  return prompt ? sha256(prompt.split(/\r?\n/, 1).join("")) : null;
}

function agentCall(
  value: Entry,
  input: Entry,
  actor: Actor,
  ordinal: number,
): AgentCall {
  const prompt = boundedPrompt(input);
  return {
    ordinal,
    ...actor,
    name: "Agent",
    toolUseId: label(value.id, 128),
    subagentType: label(input.subagent_type ?? input.subagentType),
    runInBackground:
      typeof input.run_in_background === "boolean"
        ? input.run_in_background
        : null,
    model: input.model === undefined ? null : label(input.model, 128),
    promptSha256: promptDigest(prompt),
    promptFirstLineSha256: firstLineDigest(prompt),
  };
}

function validAgentCall(call: AgentCall, input: Entry): boolean {
  const required = [call.toolUseId, call.subagentType, call.promptSha256];
  return (
    required.every(Boolean) &&
    call.runInBackground !== null &&
    validAgentModel(input, call.model)
  );
}

function validAgentModel(input: Entry, model: string | null): boolean {
  return input.model === undefined || model !== null;
}

function boundedLabel(value: string, max: number): boolean {
  return (
    value.length >= 1 && value.length <= max && /^[A-Za-z0-9_.:-]+$/.test(value)
  );
}
