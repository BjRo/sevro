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

interface NativeCallObservation {
  id: "sevro.codex.native-calls";
  completeness: "complete" | "partial" | "unavailable";
  data: {
    method: "native_session";
    calls: NativeCall[];
    submittedExecCalls: number;
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
    data: { method: "native_session", calls: [], submittedExecCalls: 0 },
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

function parseSession(text: string): NativeCallObservation {
  const calls: NativeCall[] = [];
  let submittedExecCalls = 0;
  let lastOrdinal = -1;
  let malformed = false;
  let entries = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    entries++;
    if (entries > MAX_SESSION_ENTRIES) {
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
    completeness: malformed || entries === 0 ? "partial" : "complete",
    data: { method: "native_session", calls, submittedExecCalls },
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
