import { isRecord } from "../value-guards";
import {
  summarizeClaudeEvents,
  parseClaudeEvents,
  type ClaudeEvents,
  type ClaudeEventLine,
} from "./claude-events";

const MAX_CALLS = 128;
type Entry = Record<string, unknown>;
interface SkillCall {
  sessionId: string;
  parentToolUseId: string | null;
  toolUseId: string;
  invocation: string;
  status: "unknown" | "succeeded" | "failed";
}
interface State {
  calls: Map<string, SkillCall>;
  partial: boolean;
  truncated: boolean;
}

function label(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)
    ? value
    : null;
}

function blocks(event: Entry): unknown[] {
  const content: unknown = isRecord(event.message)
    ? event.message.content
    : null;
  return Array.isArray(content) ? content : [];
}

function key(event: Entry, id: string): string {
  return JSON.stringify([
    event.session_id ?? event.sessionId,
    event.parent_tool_use_id ?? null,
    id,
  ]);
}

function call(event: Entry, block: Entry, state: State) {
  const id = label(block.id);
  const sessionId = label(event.session_id ?? event.sessionId);
  const invocation = skillInput(block.input);
  if (!id || !sessionId || !invocation) {
    state.partial = true;
    return;
  }
  addCall(
    key(event, id),
    {
      sessionId,
      parentToolUseId: label(event.parent_tool_use_id),
      toolUseId: id,
      invocation,
      status: "unknown",
    },
    state,
  );
}

function skillInput(input: unknown): string | null {
  return isRecord(input) ? label(input.skill) : null;
}

function addCall(id: string, value: SkillCall, state: State) {
  const previous = state.calls.get(id);
  if (previous) {
    state.partial ||= previous.invocation !== value.invocation;
    return;
  }
  if (state.calls.size >= MAX_CALLS) {
    state.truncated = true;
    return;
  }
  state.calls.set(id, value);
}

function result(event: Entry, block: Entry, state: State) {
  const id = label(block.tool_use_id);
  if (!id) return;
  const pending = state.calls.get(key(event, id));
  if (!pending) return;
  const status = resultStatus(block.is_error);
  if (!status) {
    state.partial = true;
    return;
  }
  state.partial ||= conflictingResult(pending.status, status);
  pending.status = status;
}

function resultStatus(value: unknown): "failed" | "succeeded" | null {
  if (value !== undefined && typeof value !== "boolean") return null;
  return value === true ? "failed" : "succeeded";
}

function conflictingResult(
  previous: SkillCall["status"],
  next: SkillCall["status"],
): boolean {
  return previous !== "unknown" && previous !== next;
}

function visit(line: ClaudeEventLine, state: State) {
  if (!line.parsed || !isRecord(line.value)) {
    state.partial = true;
    return;
  }
  for (const block of blocks(line.value)) visitBlock(line.value, block, state);
}

function visitBlock(event: Entry, block: unknown, state: State) {
  if (!isRecord(block)) return;
  switch (event.type) {
    case "assistant":
      if (isSkillCall(block)) call(event, block, state);
      break;
    case "user":
      if (block.type === "tool_result") result(event, block, state);
  }
}

function isSkillCall(block: Entry): boolean {
  return block.type === "tool_use" && block.name === "Skill";
}

function completeCollection(completed: boolean, state: State): boolean {
  return (
    completed &&
    !state.partial &&
    !state.truncated &&
    [...state.calls.values()].every((item) => item.status !== "unknown")
  );
}

/** Observe the native Skill seam and distinguish successful results from attempts. */
export function claudeSkillActivationsObservation(
  stream: string | ClaudeEvents,
  code: number,
) {
  const events = parseClaudeEvents(stream);
  const summary = summarizeClaudeEvents(events, code);
  const state: State = { calls: new Map(), partial: false, truncated: false };
  for (const line of events.lines) visit(line, state);
  const calls = [...state.calls.values()];
  const complete = completeCollection(summary.complete, state);
  return {
    id: "sevro.host.skill-activations",
    completeness: complete ? ("complete" as const) : ("partial" as const),
    data: {
      method: "skill_tool_result",
      visibility: "skill_tool",
      observedSkills: [
        ...new Set(
          calls
            .filter((item) => item.status === "succeeded")
            .map((item) => item.invocation),
        ),
      ],
      calls,
      truncated: state.truncated,
    },
  };
}
