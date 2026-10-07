import {
  locateNativeSession as sessionPath,
  readNativeSession,
  readNativeSessionText,
} from "./codex-session-files";
import { isUnknownArray } from "../value-guards";
import { nativeCommandOutputs } from "./codex-command-output";
import {
  codexNativeReadDiagnostic,
  type NativeReadDiagnostic,
} from "./codex-skill-reads";

const MAX_SESSION_ENTRIES = 10_000;
const MAX_RETAINED_CALLS = 128;
const MAX_CHILD_SESSIONS = 8;
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

interface NativeToolCall {
  ordinal: number;
  namespace: "functions" | "collaboration" | "clock" | "other";
  name: string;
  target?: string;
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

interface NativeFeedbackCall {
  ordinal: number;
  tool: "followup_task" | "send_message" | "interrupt_agent";
  target: string | null;
  responseObserved: boolean;
  messageRepresentation: "plaintext" | "encrypted" | "unavailable";
  messageMatchesFollowUpPrompt: boolean | null;
}

interface ChildSession {
  threadId: string;
  status: "available" | "unavailable" | "ambiguous" | "partial";
  resultStatus?: "completed" | "unavailable";
  readDiagnostics?: NativeReadDiagnostic;
  nestedSpawns?: NestedSpawn[];
  requestsTruncated?: boolean;
}

interface NestedSpawn {
  requestedOrdinal: number;
  status: "accepted" | "unaccepted";
  taskName?: string;
  model?: string;
  reasoningEffort?: string;
  forkTurns?: string;
  agentRef?: string;
  threadId?: string;
  sessionStatus: ChildSession["status"];
  readerResultStatus: "completed" | "unavailable";
}

interface NativeSkillContext {
  workspace: string;
  installedPluginRoots: string[];
  followUpPrompt?: string;
}

interface NativeCallObservation {
  id: "sevro.codex.native-calls";
  completeness: "complete" | "partial" | "unavailable";
  data: {
    method: "native_session";
    calls: NativeCall[];
    toolCalls: NativeToolCall[];
    submittedExecCalls: number;
    acceptedSpawns: AcceptedSpawn[];
    feedbackCalls: NativeFeedbackCall[];
    parentReadDiagnostics?: NativeReadDiagnostic;
    childSessions: ChildSession[];
    childrenTruncated: boolean;
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
      toolCalls: [],
      submittedExecCalls: 0,
      acceptedSpawns: [],
      feedbackCalls: [],
      childSessions: [],
      childrenTruncated: false,
    },
  };
}

function nativeControlNamespace(
  payload: Record<string, unknown> & { name: string },
): NativeCall["namespace"] | null {
  if (goalNamespace(payload.namespace) && GOAL_CONTROLS.has(payload.name))
    return "functions";
  if (
    payload.namespace === "collaboration" &&
    COLLABORATION_CONTROLS.has(payload.name)
  )
    return "collaboration";
  return null;
}
function goalNamespace(value: unknown): boolean {
  return value === "functions" || value === undefined;
}
function directCall(
  ordinal: number,
  payload: Record<string, unknown>,
): NativeCall | null {
  if (payload.type !== "function_call" || typeof payload.name !== "string")
    return null;
  const namespace = nativeControlNamespace({ ...payload, name: payload.name });
  return namespace
    ? { ordinal, namespace, name: payload.name, evidence: "invocation_attempt" }
    : null;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const AGENT_REF =
  /^(?:\/root(?:\/[a-z0-9_]+)+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function bounded(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && value.length <= 128 && pattern.test(value)
    ? value
    : undefined;
}

function toolNamespace(value: unknown): NativeToolCall["namespace"] {
  return value === "functions" || value === "collaboration" || value === "clock"
    ? value
    : "other";
}
function parsedObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  try {
    const value: unknown = JSON.parse(text);
    return record(value) ? value : null;
  } catch {
    return null;
  }
}
function feedbackTarget(
  args: Record<string, unknown> | null,
): string | undefined {
  if (!args) return undefined;
  return (
    bounded(args.target, AGENT_REF) ??
    bounded(args.target, /^[a-z0-9][a-z0-9_]{0,63}$/)
  );
}
function nativeToolTarget(
  payload: Record<string, unknown>,
  namespace: NativeToolCall["namespace"],
  name: string,
): string | undefined {
  if (
    namespace !== "collaboration" ||
    !["followup_task", "send_message", "interrupt_agent"].includes(name)
  )
    return undefined;
  return feedbackTarget(parsedObject(payload.arguments));
}
function toolCallType(value: unknown): boolean {
  return value === "function_call" || value === "custom_tool_call";
}
function nativeToolCall(
  ordinal: number,
  payload: Record<string, unknown>,
): NativeToolCall | null {
  if (!toolCallType(payload.type)) return null;
  const namespace = toolNamespace(payload.namespace);
  const name =
    bounded(payload.name, /^[A-Za-z_][A-Za-z0-9_]{0,63}$/) ?? "other";
  const target = nativeToolTarget(payload, namespace, name);
  return { ordinal, namespace, name, ...(target ? { target } : {}) };
}

type NativeEntry = { ordinal: number; payload: Record<string, unknown> };
function spawnRequest(payload: Record<string, unknown>): boolean {
  return (
    payload.type === "function_call" &&
    payload.namespace === "collaboration" &&
    payload.name === "spawn_agent"
  );
}
function acceptedSpawns(entries: NativeEntry[]): AcceptedSpawn[] {
  const requests = entries.filter(({ payload }) => spawnRequest(payload));
  const accepted: AcceptedSpawn[] = [];
  for (const request of requests) {
    const spawn = acceptedSpawn(request, requests, entries);
    if (spawn) accepted.push(spawn);
  }
  return accepted;
}
function spawnArguments(request: NativeEntry, requests: NativeEntry[]) {
  const callId = bounded(request.payload.call_id, IDENTIFIER);
  if (
    !callId ||
    requests.filter(({ payload }) => payload.call_id === callId).length !== 1
  )
    return null;
  const args = parsedObject(request.payload.arguments);
  return args ? { callId, args } : null;
}
function startedSpawn(
  payload: Record<string, unknown>,
  callId: string,
): boolean {
  const item = record(payload.item) ? payload.item : {};
  return (
    payload.type === "item_completed" &&
    item.type === "SubAgentActivity" &&
    item.id === callId &&
    item.kind === "started"
  );
}
function spawnBoundaries(entries: NativeEntry[], callId: string) {
  const starts = entries.filter(({ payload }) => startedSpawn(payload, callId));
  const outputs = entries.filter(
    ({ payload }) =>
      payload.type === "function_call_output" && payload.call_id === callId,
  );
  const [start] = starts,
    [result] = outputs;
  if (
    starts.length !== 1 ||
    outputs.length !== 1 ||
    start === undefined ||
    result === undefined
  )
    return null;
  return { start, result };
}
function spawnIdentity(
  request: NativeEntry,
  start: NativeEntry,
  result: NativeEntry,
) {
  const item = record(start.payload.item) ? start.payload.item : {};
  const agentRef = bounded(item.agent_path, AGENT_REF),
    threadId = bounded(item.agent_thread_id, IDENTIFIER);
  if (!agentRef || !threadId || !spawnOrdered(request, start, result))
    return null;
  return { agentRef, threadId };
}
function spawnOrdered(
  request: NativeEntry,
  start: NativeEntry,
  result: NativeEntry,
): boolean {
  return request.ordinal < start.ordinal && start.ordinal < result.ordinal;
}
function acceptedSpawn(
  request: NativeEntry,
  requests: NativeEntry[],
  entries: NativeEntry[],
): AcceptedSpawn | null {
  const declaration = spawnArguments(request, requests);
  if (!declaration) return null;
  const boundaries = spawnBoundaries(entries, declaration.callId);
  if (!boundaries) return null;
  return correlatedSpawn(request, declaration, boundaries);
}
function correlatedSpawn(
  request: NativeEntry,
  declaration: { callId: string; args: Record<string, unknown> },
  boundaries: { start: NativeEntry; result: NativeEntry },
): AcceptedSpawn | null {
  const { start, result } = boundaries;
  const identity = spawnIdentity(request, start, result);
  if (!identity) return null;
  const output = parsedObject(result.payload.output);
  if (!output || output.task_name !== identity.agentRef) return null;
  return {
    callId: declaration.callId,
    ...identity,
    requestedOrdinal: request.ordinal,
    startedOrdinal: start.ordinal,
    acceptedOrdinal: result.ordinal,
    ...requestFields(declaration.args),
  };
}
function requestFields(args: Record<string, unknown>) {
  const taskName = bounded(args.task_name, /^[a-z0-9][a-z0-9_]{0,63}$/);
  const model = bounded(args.model, IDENTIFIER);
  const reasoningEffort = bounded(
    args.reasoning_effort,
    /^(?:low|medium|high|xhigh|max|ultra)$/,
  );
  const forkTurns = bounded(args.fork_turns, /^(?:none|all|[1-9][0-9]*)$/);
  return {
    ...(taskName ? { taskName } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(forkTurns ? { forkTurns } : {}),
  };
}

function feedbackRepresentation(
  message: unknown,
): NativeFeedbackCall["messageRepresentation"] {
  if (typeof message !== "string") return "unavailable";
  return /^gAAAAA[A-Za-z0-9_-]+={0,2}$/.test(message)
    ? "encrypted"
    : "plaintext";
}
function feedbackMessageEvidence(
  payload: Record<string, unknown>,
  followUpPrompt?: string,
) {
  const message = parsedObject(payload.arguments)?.message;
  const messageRepresentation = feedbackRepresentation(message);
  return {
    messageRepresentation,
    messageMatchesFollowUpPrompt:
      messageRepresentation === "plaintext" && followUpPrompt !== undefined
        ? message === followUpPrompt
        : null,
  };
}

function feedbackPayload(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & { name: NativeFeedbackCall["tool"] } {
  return (
    payload.type === "function_call" &&
    payload.namespace === "collaboration" &&
    typeof payload.name === "string" &&
    ["followup_task", "send_message", "interrupt_agent"].includes(payload.name)
  );
}
function feedbackResponses(
  entries: NativeEntry[],
  callId: string | undefined,
  ordinal: number,
) {
  return callId
    ? entries.filter(
        (entry) =>
          entry.ordinal > ordinal &&
          entry.payload.type === "function_call_output" &&
          entry.payload.call_id === callId,
      )
    : [];
}
function responseObserved(outputs: NativeEntry[]): boolean {
  return outputs.length === 1 && typeof outputs[0]?.payload.output === "string";
}
function nativeFeedbackCalls(
  entries: NativeEntry[],
  followUpPrompt?: string,
): NativeFeedbackCall[] {
  return entries.flatMap((entry) =>
    feedbackCall(entry, entries, followUpPrompt),
  );
}
function feedbackCall(
  { ordinal, payload }: NativeEntry,
  entries: NativeEntry[],
  followUpPrompt: string | undefined,
): NativeFeedbackCall[] {
  if (!feedbackPayload(payload)) return [];
  const outputs = feedbackResponses(
    entries,
    bounded(payload.call_id, IDENTIFIER),
    ordinal,
  );
  return [
    {
      ordinal,
      tool: payload.name,
      target: nativeToolCall(ordinal, payload)?.target ?? null,
      responseObserved: responseObserved(outputs),
      ...feedbackMessageEvidence(payload, followUpPrompt),
    },
  ];
}

interface ParseState {
  calls: NativeCall[];
  toolCalls: NativeToolCall[];
  entries: NativeEntry[];
  submittedExecCalls: number;
  lastOrdinal: number;
  malformed: boolean;
  entryCount: number;
}
function parseSession(
  text: string,
  followUpPrompt?: string,
): { observation: NativeCallObservation; entries: NativeEntry[] } {
  const state: ParseState = {
    calls: [],
    toolCalls: [],
    entries: [],
    submittedExecCalls: 0,
    lastOrdinal: -1,
    malformed: false,
    entryCount: 0,
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (!consumeSessionLine(line, state)) break;
  }
  return {
    entries: state.entries,
    observation: sessionObservation(state, followUpPrompt),
  };
}
function consumeSessionLine(line: string, state: ParseState): boolean {
  state.entryCount++;
  if (state.entryCount > MAX_SESSION_ENTRIES) {
    state.malformed = true;
    return false;
  }
  const entry = parsedSessionEntry(line, state);
  if (!entry) return true;
  state.lastOrdinal = entry.ordinal;
  state.entries.push(entry);
  retainSessionCalls(entry, state);
  return !truncateSessionCalls(state);
}
function sessionOrdinal(
  entry: Record<string, unknown>,
  lastOrdinal: number,
): entry is Record<string, unknown> & { ordinal: number } {
  return (
    typeof entry.ordinal === "number" &&
    Number.isSafeInteger(entry.ordinal) &&
    entry.ordinal > lastOrdinal
  );
}
function parsedSessionEntry(
  line: string,
  state: ParseState,
): NativeEntry | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    state.malformed = true;
    return null;
  }
  if (
    !record(entry) ||
    !sessionOrdinal(entry, state.lastOrdinal) ||
    !record(entry.payload)
  ) {
    state.malformed = true;
    return null;
  }
  return { ordinal: entry.ordinal, payload: entry.payload };
}
function retainSessionCalls(entry: NativeEntry, state: ParseState): void {
  if (
    entry.payload.type === "custom_tool_call" &&
    entry.payload.name === "exec"
  )
    state.submittedExecCalls++;
  const call = directCall(entry.ordinal, entry.payload);
  if (call) state.calls.push(call);
  const tool = nativeToolCall(entry.ordinal, entry.payload);
  if (tool) state.toolCalls.push(tool);
}
function truncateSessionCalls(state: ParseState): boolean {
  if (
    state.calls.length <= MAX_RETAINED_CALLS &&
    state.toolCalls.length <= MAX_RETAINED_CALLS
  )
    return false;
  state.calls.length = MAX_RETAINED_CALLS;
  state.toolCalls.length = MAX_RETAINED_CALLS;
  state.malformed = true;
  return true;
}
function sessionReceipts(
  state: ParseState,
  followUpPrompt: string | undefined,
) {
  if (state.malformed || state.entries.length === 0)
    return { acceptedSpawns: [], feedbackCalls: [] };
  return {
    acceptedSpawns: acceptedSpawns(state.entries),
    feedbackCalls: nativeFeedbackCalls(state.entries, followUpPrompt),
  };
}
function sessionObservation(
  state: ParseState,
  followUpPrompt: string | undefined,
): NativeCallObservation {
  return {
    id: "sevro.codex.native-calls",
    completeness:
      state.malformed || state.entryCount === 0 ? "partial" : "complete",
    data: {
      method: "native_session",
      calls: state.calls,
      toolCalls: state.toolCalls,
      submittedExecCalls: state.submittedExecCalls,
      ...sessionReceipts(state, followUpPrompt),
      childSessions: [],
      childrenTruncated: false,
    },
  };
}

/** Bind a private final answer to the same turn's later native completion. */

function finalAgentMessage(payload: Record<string, unknown>): boolean {
  const item = record(payload.item) ? payload.item : {};
  return (
    payload.type === "item_completed" &&
    item.type === "AgentMessage" &&
    item.phase === "final_answer"
  );
}
function childResultCompleted(entries: NativeEntry[]): boolean {
  const finals = entries.filter(({ payload }) => finalAgentMessage(payload));
  const completions = entries.filter(
    ({ payload }) => payload.type === "task_complete",
  );
  const boundaries = childResultBoundaries(finals, completions, entries);
  return (
    boundaries !== null &&
    childFinalMatched(boundaries.final, boundaries.complete)
  );
}
function childResultBoundaries(
  finals: NativeEntry[],
  completions: NativeEntry[],
  entries: NativeEntry[],
) {
  if (!uniqueChildCompletion(finals, completions, entries)) return null;
  const [final] = finals,
    [complete] = completions;
  return final && complete ? { final, complete } : null;
}

function uniqueChildCompletion(
  finals: NativeEntry[],
  completions: NativeEntry[],
  entries: NativeEntry[],
): boolean {
  return (
    finals.length === 1 &&
    completions.length === 1 &&
    !entries.some(
      ({ payload }) =>
        payload.type === "turn_aborted" || payload.type === "turn_failed",
    )
  );
}
function childFinalMatched(final: NativeEntry, complete: NativeEntry): boolean {
  if (!childCompletionOrdered(final, complete)) return false;
  const item = record(final.payload.item) ? final.payload.item : {};
  const message = childMessage(item.content);
  return (
    message !== null &&
    message.trim().length > 0 &&
    complete.payload.last_agent_message === message
  );
}
function childCompletionOrdered(
  final: NativeEntry,
  complete: NativeEntry,
): boolean {
  return (
    !!bounded(final.payload.turn_id, IDENTIFIER) &&
    complete.payload.turn_id === final.payload.turn_id &&
    final.ordinal < complete.ordinal
  );
}
function childTextBlock(part: unknown): part is { type: "Text"; text: string } {
  return record(part) && part.type === "Text" && typeof part.text === "string";
}
function childMessage(content: unknown): string | null {
  if (
    !isUnknownArray(content) ||
    content.length === 0 ||
    !content.every(childTextBlock)
  )
    return null;
  return content.map((part) => part.text).join("");
}

function nestedRequestFields(payload: Record<string, unknown>) {
  const args = parsedObject(payload.arguments);
  return args ? requestFields(args) : {};
}

async function nestedSpawnReceipts(
  home: string,
  rootThread: string,
  parentThread: string,
  entries: Array<{ ordinal: number; payload: Record<string, unknown> }>,
) {
  const requests = entries.filter(
    ({ payload }) =>
      payload.type === "function_call" &&
      payload.namespace === "collaboration" &&
      payload.name === "spawn_agent",
  );
  const accepted = acceptedSpawns(entries);
  const nestedSpawns: NestedSpawn[] = await Promise.all(
    requests
      .slice(0, MAX_CHILD_SESSIONS)
      .map((request) =>
        nestedSpawnReceipt(home, rootThread, parentThread, accepted, request),
      ),
  );
  return {
    nestedSpawns,
    requestsTruncated: requests.length > MAX_CHILD_SESSIONS,
  };
}

async function nestedSpawnReceipt(
  home: string,
  rootThread: string,
  parentThread: string,
  accepted: AcceptedSpawn[],
  { ordinal, payload }: NativeEntry,
): Promise<NestedSpawn> {
  const receipt = accepted.find((spawn) => spawn.requestedOrdinal === ordinal);
  const session = await nestedReaderSession(
    home,
    rootThread,
    parentThread,
    receipt,
  );
  return {
    requestedOrdinal: ordinal,
    status: receipt ? "accepted" : "unaccepted",
    ...nestedRequestFields(payload),
    ...(receipt
      ? { agentRef: receipt.agentRef, threadId: receipt.threadId }
      : {}),
    ...nestedReaderStatus(session),
  };
}
function nestedReaderStatus(session: ChildSession | null) {
  return {
    sessionStatus: session?.status ?? "unavailable",
    readerResultStatus: session?.resultStatus ?? "unavailable",
  };
}
async function nestedReaderSession(
  home: string,
  rootThread: string,
  parentThread: string,
  receipt: AcceptedSpawn | undefined,
): Promise<ChildSession | null> {
  if (!receipt) return null;
  if (receipt.threadId === rootThread)
    return { threadId: receipt.threadId, status: "partial" };
  return childSessionStatus(home, parentThread, receipt.threadId);
}

async function childSessionStatus(
  home: string,
  parentThread: string,
  threadId: string,
  skillContext?: NativeSkillContext,
  rootThread?: string,
): Promise<ChildSession> {
  if (threadId === parentThread) return { threadId, status: "partial" };
  const located = await sessionPath(home, threadId);
  if (located.status !== "found") return { threadId, status: located.status };
  try {
    const text = await readNativeSession(located.path);
    if (text === null) return { threadId, status: "partial" };
    return await availableChildSession(
      home,
      threadId,
      text,
      skillContext,
      rootThread,
    );
  } catch {
    return { threadId, status: "partial" };
  }
}

async function readDiagnostics(
  entries: NativeEntry[],
  context: NativeSkillContext | undefined,
) {
  return context
    ? codexNativeReadDiagnostic(
        entries,
        context.workspace,
        context.installedPluginRoots,
      )
    : undefined;
}
async function availableChildSession(
  home: string,
  threadId: string,
  text: string,
  context: NativeSkillContext | undefined,
  rootThread: string | undefined,
): Promise<ChildSession> {
  const parsed = parseSession(text);
  if (parsed.observation.completeness !== "complete")
    return { threadId, status: "partial" };
  const diagnostics = await readDiagnostics(parsed.entries, context);
  const nested = rootThread
    ? await nestedSpawnReceipts(home, rootThread, threadId, parsed.entries)
    : undefined;
  return {
    threadId,
    status: "available",
    resultStatus: childResultCompleted(parsed.entries)
      ? "completed"
      : "unavailable",
    ...(diagnostics ? { readDiagnostics: diagnostics } : {}),
    ...nested,
  };
}

/** Last validated native event before a follow-up prompt enters this thread. */
export async function codexNativeSessionLastOrdinal(
  home: string,
  threadId: string,
): Promise<number | null> {
  const located = await sessionPath(home, threadId);
  if (located.status !== "found") return null;
  try {
    const text = await readNativeSession(located.path);
    return text === null ? null : lastSessionOrdinal(text);
  } catch {
    return null;
  }
}

function lastSessionOrdinal(text: string): number | null {
  const parsed = parseSession(text);
  if (parsed.observation.completeness !== "complete") return null;
  return parsed.entries.at(-1)?.ordinal ?? null;
}

/** Bind one private native session to the completed public thread. */
export async function codexNativeCallObservation(
  home: string,
  threadId: string,
  skillContext?: NativeSkillContext,
): Promise<NativeCallObservation> {
  const located = await sessionPath(home, threadId);
  if (located.status !== "found")
    return unavailable(
      located.status === "ambiguous" ? "partial" : located.status,
    );
  try {
    return await nativeSessionObservation(
      home,
      threadId,
      located.path,
      skillContext,
    );
  } catch {
    return unavailable("partial");
  }
}

async function nativeSessionObservation(
  home: string,
  threadId: string,
  path: string,
  skillContext: NativeSkillContext | undefined,
): Promise<NativeCallObservation> {
  const text = await readNativeSession(path);
  if (text === null) return unavailable("partial");
  const { observation, entries } = parseSession(
    text,
    skillContext?.followUpPrompt,
  );
  if (observation.completeness !== "complete") return observation;
  const parentReadDiagnostics = await readDiagnostics(entries, skillContext);
  const children = [
    ...new Set(observation.data.acceptedSpawns.map((spawn) => spawn.threadId)),
  ];
  const childSessions = await Promise.all(
    children
      .slice(0, MAX_CHILD_SESSIONS)
      .map((child) =>
        childSessionStatus(home, threadId, child, skillContext, threadId),
      ),
  );
  return {
    ...observation,
    data: {
      ...observation.data,
      ...(parentReadDiagnostics ? { parentReadDiagnostics } : {}),
      childSessions,
      childrenTruncated: children.length > MAX_CHILD_SESSIONS,
    },
  };
}

/** Actor-local recovery stays in host memory and never enters public observations. */
export async function codexNativeSkillReadRecovery(
  home: string,
  threadId: string,
): Promise<Map<string, { command: string; output: string }>> {
  const found = await sessionPath(home, threadId);
  if (found.status !== "found") return new Map();
  try {
    const text = await readNativeSessionText(found.path);
    if (text === null) return new Map();
    const parsed = parseSession(text);
    if (parsed.observation.completeness !== "complete") return new Map();
    return recoveredSessionReads(parsed.entries);
  } catch {
    return new Map();
  }
}

function completedCommandItem(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (payload.type !== "item_completed") return null;
  if (!record(payload.item) || payload.item.type !== "CommandExecution")
    return null;
  return payload.item;
}
function commandIdentityCounts(entries: NativeEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { payload } of entries) {
    const item = completedCommandItem(payload);
    if (typeof item?.id === "string")
      counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  }
  return counts;
}
function uniqueRecoveryItem(
  payload: Record<string, unknown>,
  counts: Map<string, number>,
) {
  const item = completedCommandItem(payload);
  if (!item || typeof item.id !== "string" || counts.get(item.id) !== 1)
    return null;
  return { id: item.id, command: item.command };
}
function recoveredLiteralCommand(command: unknown): string | null {
  if (!isUnknownArray(command) || command.length !== 3) return null;
  if (
    !["-c", "-lc"].includes(String(command[1])) ||
    typeof command[2] !== "string"
  )
    return null;
  return command[2];
}
function recoveredSessionReads(
  entries: NativeEntry[],
): Map<string, { command: string; output: string }> {
  const output = nativeCommandOutputs(entries);
  const counts = commandIdentityCounts(entries);
  const recovered = new Map<string, { command: string; output: string }>();
  for (const { ordinal, payload } of entries) {
    const item = uniqueRecoveryItem(payload, counts);
    if (!item) continue;
    const read = recoveredCommandRead(
      item.command,
      output.get(ordinal)?.output,
    );
    if (read) recovered.set(item.id, read);
  }
  return recovered;
}
function recoveredCommandRead(value: unknown, output: string | undefined) {
  if (output === undefined) return null;
  const command = recoveredLiteralCommand(value);
  return command === null ? null : { command, output };
}
