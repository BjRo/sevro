import type { Dirent } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_ENTRIES = 10_000;
const MAX_SESSION_FILES = 1024;
const MAX_RETAINED_CALLS = 128;
const THREAD_ID = /^[A-Za-z0-9._-]{1,128}$/;
const GOAL_CONTROLS = new Set(["create_goal", "get_goal", "update_goal"]);
const COLLABORATION_CONTROLS = new Set([
  "spawn_agent",
  "list_agents",
  "wait_agent",
  "followup_task",
  "send_message",
  "interrupt_agent",
]);

interface NativeCall {
  ordinal: number;
  namespace: "functions" | "collaboration";
  name: string;
  evidence: "invocation_attempt";
}

interface AcceptedSpawn {
  callId: string;
  agentRef: string;
  threadId: string;
  requestedOrdinal: number;
  startedOrdinal: number;
  acceptedOrdinal: number;
  taskName?: string;
  model?: string;
  reasoningEffort?: string;
  forkTurns?: string;
}

interface NativeCallObservation {
  id: "sevro.codex.native-calls";
  completeness: "complete" | "partial" | "unavailable";
  data: {
    method: "native_session";
    calls: NativeCall[];
    submittedExecCalls: number;
    acceptedSpawns: AcceptedSpawn[];
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unavailable(
  completeness: NativeCallObservation["completeness"],
): NativeCallObservation {
  return {
    id: "sevro.codex.native-calls",
    completeness,
    data: {
      method: "native_session",
      calls: [],
      submittedExecCalls: 0,
      acceptedSpawns: [],
    },
  };
}

async function sessionPath(home: string, threadId: string) {
  if (!THREAD_ID.test(threadId)) return { status: "partial" as const };
  const sessionsRoot = join(home, "sessions");
  try {
    const root = await lstat(sessionsRoot);
    if (!root.isDirectory() || root.isSymbolicLink())
      return { status: "partial" as const };
  } catch (error) {
    return {
      status:
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? ("unavailable" as const)
          : ("partial" as const),
    };
  }
  const pending = [sessionsRoot];
  const suffix = `-${threadId}.jsonl`;
  const matches: string[] = [];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return { status: "partial" as const };
    }
    for (const entry of entries) {
      visited++;
      if (visited > MAX_SESSION_FILES || entry.isSymbolicLink())
        return { status: "partial" as const };
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(suffix))
        matches.push(path);
      if (matches.length > 1) return { status: "partial" as const };
    }
  }
  return matches.length === 1
    ? { status: "found" as const, path: matches[0]! }
    : { status: "unavailable" as const };
}

function directCall(
  ordinal: number,
  payload: Record<string, unknown>,
): NativeCall | null {
  if (payload.type !== "function_call" || typeof payload.name !== "string")
    return null;
  if (
    (payload.namespace === "functions" || payload.namespace === undefined) &&
    GOAL_CONTROLS.has(payload.name)
  )
    return {
      ordinal,
      namespace: "functions",
      name: payload.name,
      evidence: "invocation_attempt",
    };
  if (
    payload.namespace === "collaboration" &&
    COLLABORATION_CONTROLS.has(payload.name)
  )
    return {
      ordinal,
      namespace: "collaboration",
      name: payload.name,
      evidence: "invocation_attempt",
    };
  return null;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const AGENT_REF =
  /^(?:\/root(?:\/[a-z0-9_]+)+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function bounded(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && value.length <= 128 && pattern.test(value)
    ? value
    : undefined;
}

function acceptedSpawns(
  entries: Array<{ ordinal: number; payload: Record<string, unknown> }>,
): AcceptedSpawn[] {
  const requests = entries.filter(
    ({ payload }) =>
      payload.type === "function_call" &&
      payload.namespace === "collaboration" &&
      payload.name === "spawn_agent",
  );
  const accepted: AcceptedSpawn[] = [];
  for (const request of requests) {
    const callId = bounded(request.payload.call_id, IDENTIFIER);
    if (
      !callId ||
      requests.filter(({ payload }) => payload.call_id === callId).length !==
        1 ||
      typeof request.payload.arguments !== "string"
    )
      continue;
    let args: unknown;
    try {
      args = JSON.parse(request.payload.arguments);
    } catch {
      continue;
    }
    if (!record(args)) continue;
    const starts = entries.filter(({ payload }) => {
      const item = record(payload.item) ? payload.item : undefined;
      return (
        payload.type === "item_completed" &&
        item?.type === "SubAgentActivity" &&
        item.id === callId &&
        item.kind === "started"
      );
    });
    const outputs = entries.filter(
      ({ payload }) =>
        payload.type === "function_call_output" && payload.call_id === callId,
    );
    if (starts.length !== 1 || outputs.length !== 1) continue;
    const start = starts[0]!;
    const result = outputs[0]!;
    const item = start.payload.item as Record<string, unknown>;
    const agentRef = bounded(item.agent_path, AGENT_REF);
    const threadId = bounded(item.agent_thread_id, IDENTIFIER);
    if (
      !agentRef ||
      !threadId ||
      !(request.ordinal < start.ordinal && start.ordinal < result.ordinal) ||
      typeof result.payload.output !== "string"
    )
      continue;
    let output: unknown;
    try {
      output = JSON.parse(result.payload.output);
    } catch {
      continue;
    }
    if (!record(output) || output.task_name !== agentRef) continue;
    accepted.push({
      callId,
      agentRef,
      threadId,
      requestedOrdinal: request.ordinal,
      startedOrdinal: start.ordinal,
      acceptedOrdinal: result.ordinal,
      ...(bounded(args.task_name, /^[a-z0-9][a-z0-9_]{0,63}$/)
        ? { taskName: args.task_name as string }
        : {}),
      ...(bounded(args.model, IDENTIFIER)
        ? { model: args.model as string }
        : {}),
      ...(bounded(
        args.reasoning_effort,
        /^(?:low|medium|high|xhigh|max|ultra)$/,
      )
        ? { reasoningEffort: args.reasoning_effort as string }
        : {}),
      ...(bounded(args.fork_turns, /^(?:none|all|[1-9][0-9]*)$/)
        ? { forkTurns: args.fork_turns as string }
        : {}),
    });
  }
  return accepted;
}

function parseSession(text: string): NativeCallObservation {
  const calls: NativeCall[] = [];
  const entries: Array<{ ordinal: number; payload: Record<string, unknown> }> =
    [];
  let submittedExecCalls = 0;
  let lastOrdinal = -1;
  let malformed = false;
  let entryCount = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    entryCount++;
    if (entryCount > MAX_SESSION_ENTRIES) {
      malformed = true;
      break;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      malformed = true;
      continue;
    }
    if (
      !record(entry) ||
      !Number.isSafeInteger(entry.ordinal) ||
      (entry.ordinal as number) <= lastOrdinal ||
      !record(entry.payload)
    ) {
      malformed = true;
      continue;
    }
    lastOrdinal = entry.ordinal as number;
    entries.push({ ordinal: lastOrdinal, payload: entry.payload });
    if (
      entry.payload.type === "custom_tool_call" &&
      entry.payload.name === "exec"
    )
      submittedExecCalls++;
    const call = directCall(lastOrdinal, entry.payload);
    if (call) calls.push(call);
    if (calls.length > MAX_RETAINED_CALLS) {
      calls.length = MAX_RETAINED_CALLS;
      malformed = true;
      break;
    }
  }
  return {
    id: "sevro.codex.native-calls",
    completeness: malformed || entryCount === 0 ? "partial" : "complete",
    data: {
      method: "native_session",
      calls,
      submittedExecCalls,
      acceptedSpawns:
        malformed || entries.length === 0 ? [] : acceptedSpawns(entries),
    },
  };
}

/** Bind one private native session to the completed public thread. */
export async function codexNativeCallObservation(
  home: string,
  threadId: string,
): Promise<NativeCallObservation> {
  const located = await sessionPath(home, threadId);
  if (located.status !== "found") return unavailable(located.status);
  try {
    const size = (await stat(located.path)).size;
    if (size > MAX_SESSION_BYTES) return unavailable("partial");
    const bytes = await readFile(located.path);
    if (bytes.byteLength > MAX_SESSION_BYTES) return unavailable("partial");
    return parseSession(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return unavailable("partial");
  }
}
