import { isRecord } from "../value-guards";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
interface HarnessRunRequest {
  repoDir: string;
  prompt: string;
  model: string;
  effort: string;
  signal?: AbortSignal;
  control?: { followUpPrompt?: string; appServerTimeoutMs?: number };
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed app-server object");
  return value as RecordValue;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error("Missing app-server identifier");
  return value;
}

function protocolMessage(line: string): RecordValue {
  try {
    return record(JSON.parse(line));
  } catch {
    throw new Error("Malformed app-server JSON message");
  }
}

interface AppServerErrorEvidence {
  source: "error" | "turn/completed";
  threadId: string;
  turnId: string | null;
  willRetry: boolean | null;
  message: string | null;
  messageTruncated?: boolean;
  code: string | null;
  httpStatusCode?: number;
}

/** Lifecycle and bounded public errors; normal Codex readers retain tool evidence. */
export interface AppServerEvidence {
  type: "sevro.codex.app-server";
  threadId?: string;
  model?: string;
  effort?: string;
  clientTurns: number;
  turns: { id: string; status: string; at: string }[];
  goals: {
    status: string;
    characters: number;
    turnId: string | null;
    at: string;
    source: "notification" | "readback";
  }[];
  finalTurnId?: string;
  goalStatus?: string | null;
  failure?: string;
  errors?: AppServerErrorEvidence[];
  errorsDropped?: number;
}

function publicErrorMessage(value: unknown): {
  message: string | null;
  messageTruncated?: boolean;
} {
  if (typeof value !== "string") return { message: null };
  const redacted = value
    .slice(0, 20000)
    .replace(/(authorization\s*:\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)\S+/gi,
      "$1[redacted]",
    );
  return {
    message: redacted.slice(0, 2000),
    ...(value.length > 20000 || redacted.length > 2000
      ? { messageTruncated: true }
      : {}),
  };
}

function errorClassification(value: unknown): {
  code: string | null;
  httpStatusCode?: number;
} {
  const tag = (s: unknown): s is string =>
    typeof s === "string" && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(s);
  if (tag(value)) return { code: value };
  if (!isRecord(value)) return { code: null };
  return classifiedErrorEntry(value, tag);
}

function classifiedErrorEntry(
  value: RecordValue,
  tag: (value: unknown) => value is string,
) {
  const entries = Object.entries(value);
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined || !tag(entry[0]))
    return { code: null };
  const [code, details] = entry;
  return { code, ...errorHttpStatus(details) };
}

function validHttpStatus(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 65535
  );
}

function errorHttpStatus(details: unknown): { httpStatusCode?: number } {
  const status =
    details && typeof details === "object"
      ? (details as RecordValue).httpStatusCode
      : undefined;
  return {
    ...(validHttpStatus(status) ? { httpStatusCode: status } : {}),
  };
}

interface Notification {
  method: string;
  params: RecordValue;
}

/** JSON-RPC transport only: no goal mutation, retries or synthesized user turns. */
class AppServerRpc {
  readonly process: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  readonly queue: Notification[] = [];
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: RecordValue) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private wake?: () => void;
  private failure?: Error;
  private closing = false;
  private receivedBytes = 0;
  private reads: Promise<void>;
  private errors: Promise<void>;
  stderr = "";

  constructor(argv: string[], cwd: string, env: Record<string, string>) {
    this.process = spawn(identifier(argv[0]), argv.slice(1), {
      detached: process.platform !== "win32",
      cwd,
      env,
      stdio: "pipe",
    });
    this.exited = new Promise((resolve) => {
      this.process.once("exit", resolve);
      this.process.once("error", (error) => {
        this.fail(error);
        resolve(null);
      });
    });
    this.reads = this.readLines().catch((error: unknown) => {
      this.fail(error);
    });
    this.process.stdin.on("error", (error) => {
      this.fail(error);
    });
    this.errors = new Promise((resolve) => {
      this.process.stderr.on("data", (chunk) => {
        this.stderr = (this.stderr + String(chunk)).slice(-16000);
      });
      this.process.stderr.on("end", resolve);
      this.process.stderr.on("error", (error) => {
        this.fail(error);
        resolve();
      });
    });
    void this.exited.then((code) => {
      if (!this.closing)
        this.fail(new Error(`App-server exited before settlement (${code})`));
    });
  }

  fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
    this.wake?.();
  }

  assertHealthy(): void {
    if (this.failure) throw this.failure;
  }

  private send(value: unknown): void {
    this.process.stdin.write(JSON.stringify(value) + "\n");
  }

  private readLines(): Promise<void> {
    return new Promise((resolve) => {
      const lines = createInterface({ input: this.process.stdout });
      lines.on("line", (line) => {
        try {
          this.receivedBytes += Buffer.byteLength(line);
          if (this.receivedBytes > 8 * 1024 * 1024)
            throw new Error("App-server stream exceeds limit");
          if (!line.trim()) return;
          this.receive(protocolMessage(line));
        } catch (error) {
          this.fail(error);
        }
      });
      lines.on("close", () => {
        if (!this.closing)
          this.fail(new Error("App-server stdout closed before settlement"));
        resolve();
      });
    });
  }

  private receive(message: RecordValue): void {
    this.refuseServerRequest(message);
    if (typeof message.id === "number")
      this.receiveResponse(message, message.id);
    else if (typeof message.method === "string")
      this.receiveNotification(message.method, message.params);
    else throw new Error("Malformed app-server message");
  }

  private refuseServerRequest(message: RecordValue): void {
    if (typeof message.method !== "string" || message.id === undefined) return;
    this.send({
      id: message.id,
      error: {
        code: -32601,
        message: "Unattended eval cannot answer this server request",
      },
    });
    throw new Error(`Unsupported app-server request: ${message.method}`);
  }

  private receiveResponse(message: RecordValue, id: number): void {
    const pending = this.pending.get(id);
    if (!pending) throw new Error("Unmatched app-server response");
    // Validate before removing the waiter so malformed responses reject it.
    const value = record(message.error ?? message.result);
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error)
      pending.reject(
        new Error(`App-server RPC failed (${String(value.code)})`),
      );
    else pending.resolve(value);
  }

  private receiveNotification(method: string, value: unknown): void {
    // Drop reasoning, account metadata, deltas and private raw events at ingress.
    if (
      ![
        "turn/started",
        "turn/completed",
        "thread/goal/updated",
        "thread/goal/cleared",
        "thread/tokenUsage/updated",
        "item/completed",
        "error",
      ].includes(method)
    )
      return;
    const params = record(value);
    if (!allowedNotificationItem(method, params)) return;
    if (this.queue.length >= 1024)
      throw new Error("App-server notification queue exceeds limit");
    this.queue.push({ method, params });
    this.wake?.();
  }

  async call(method: string, params: RecordValue): Promise<RecordValue> {
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`App-server RPC timeout: ${method}`));
      }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.fail(error);
      }
    });
  }

  async initialize(): Promise<void> {
    await this.call("initialize", {
      clientInfo: { name: "sevro_eval", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: "initialized", params: {} });
  }

  async next(): Promise<Notification> {
    while (!this.failure && !this.queue.length)
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    this.wake = undefined;
    if (this.failure) throw this.failure;
    const notification = this.queue.shift();
    if (!notification) throw new Error("Missing app-server notification");
    return notification;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.process.stdin.end();
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (this.process.pid) process.kill(-this.process.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const term = setTimeout(() => {
      terminate("SIGTERM");
    }, 5000);
    const kill = setTimeout(() => {
      terminate("SIGKILL");
    }, 6000);
    try {
      await this.exited;
      await this.reads;
      await this.errors;
    } finally {
      clearTimeout(term);
      clearTimeout(kill);
    }
  }
}

function allowedNotificationItem(method: string, params: RecordValue): boolean {
  return (
    method !== "item/completed" ||
    ["commandExecution", "collabAgentToolCall"].includes(
      String(record(params.item).type),
    )
  );
}

/** Convert only public tool items used by the existing bounded evidence readers. */
function toolEvent(value: unknown): unknown {
  const item = record(value);
  if (item.type === "commandExecution")
    return {
      type: "item.completed",
      item: {
        id: item.id,
        type: "command_execution",
        command: item.command,
        status: item.status === "completed" ? "completed" : item.status,
        exit_code: item.exitCode,
        aggregated_output: item.aggregatedOutput,
      },
    };
  if (item.type === "collabAgentToolCall")
    return {
      type: "item.completed",
      item: {
        id: item.id,
        type: "collab_tool_call",
        tool:
          typeof item.tool === "string"
            ? item.tool.replace(
                /[A-Z]/g,
                (letter) => `_${letter.toLowerCase()}`,
              )
            : item.tool,
        status: item.status,
        sender_thread_id: item.senderThreadId,
        receiver_thread_ids: item.receiverThreadIds,
        prompt: item.prompt,
        model: item.model,
        reasoning_effort: item.reasoningEffort,
      },
    };
  return undefined;
}

/** Require the exact terminal turn, not a previous checkpoint or child response. */
export function appServerFinal(thread: unknown, turnId: string): string {
  const items = completedAppServerTurn(thread, turnId).items;
  if (!Array.isArray(items))
    throw new Error("Completed app-server turn has no items");
  const finals = items
    .map(record)
    .filter(
      (item) =>
        item.type === "agentMessage" &&
        item.phase === "final_answer" &&
        typeof item.text === "string",
    );
  if (!finals.length)
    throw new Error("Completed app-server turn has no final response");
  return finals.map((item) => item.text).join("\n\n");
}

function completedAppServerTurn(thread: unknown, turnId: string): RecordValue {
  const turns: unknown = record(thread).turns;
  if (!Array.isArray(turns))
    throw new Error("App-server thread has no retained turns");
  const matches = turns.map(record).filter((turn) => turn.id === turnId);
  const [turn] = matches;
  if (matches.length !== 1 || turn === undefined || turn.status !== "completed")
    throw new Error("Missing completed app-server turn");
  return turn;
}

const GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
];

export function appServerGoalStatus(
  value: unknown,
  threadId: string,
): string | null {
  if (value === null) return null;
  const goal = record(value);
  requireGoalIdentity(goal, threadId);
  requireGoalObjective(goal.objective);
  return String(goal.status);
}

function requireGoalIdentity(goal: RecordValue, threadId: string): void {
  if (
    goal.threadId !== threadId ||
    typeof goal.status !== "string" ||
    !GOAL_STATUSES.includes(goal.status)
  )
    throw new Error("Invalid native goal readback");
}
function requireGoalObjective(objective: unknown): void {
  if (
    typeof objective !== "string" ||
    !objective.length ||
    Array.from(objective).length > 4000
  )
    throw new Error("Invalid native goal readback");
}

export function codexAppServerArgv(): string[] {
  return ["codex", "app-server", "--stdio"];
}

export interface AppServerRunOptions {
  request: HarnessRunRequest;
  argv: string[];
  env: Record<string, string>;
  /** Existing observer captures the actual boundary before an explicit follow-up. */
  followUpBoundary: (
    threadId: string,
    goal: { nativeGoalObserved: boolean; nativeGoalStatus: string | null },
  ) => Promise<string>;
  permissionProfile: string;
}

/** Observe one original host thread. Capability coordination stays in its skill. */
class AppServerSession {
  readonly evidence: AppServerEvidence = {
    type: "sevro.codex.app-server",
    clientTurns: 0,
    turns: [],
    goals: [],
  };
  readonly out: string[] = [];
  private threadId = "";
  private goalSeen = false;
  private usage: unknown;
  private emittedItems = new Set<string>();
  private followUp?: string;

  constructor(
    readonly rpc: AppServerRpc,
    readonly options: AppServerRunOptions,
  ) {
    this.followUp = options.request.control?.followUpPrompt;
  }
  emit(event: unknown): void {
    this.out.push(JSON.stringify(event));
  }

  private async start(): Promise<void> {
    const { request } = this.options;
    await this.rpc.initialize();
    const started = await this.rpc.call("thread/start", {
      cwd: request.repoDir,
      model: request.model,
      modelProvider: "openai",
      config: {
        model_reasoning_effort: request.effort,
        default_permissions: this.options.permissionProfile,
      },
      approvalPolicy: "never",
      allowProviderModelFallback: false,
      ephemeral: false,
    });
    this.threadId = identifier(record(started.thread).id);
    this.evidence.threadId = this.threadId;
    this.evidence.model = String(started.model);
    this.evidence.effort = String(started.reasoningEffort);
    if (
      started.model !== request.model ||
      started.reasoningEffort !== request.effort ||
      started.modelProvider !== "openai"
    )
      throw new Error("App-server effective root route mismatch");
    this.emit({ type: "thread.started", thread_id: this.threadId });
    await this.startUserTurn(request.prompt);
  }

  private async startUserTurn(prompt: string): Promise<void> {
    const { request } = this.options;
    const response = await this.rpc.call("turn/start", {
      threadId: this.threadId,
      model: request.model,
      effort: request.effort,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    identifier(record(response.turn).id);
    this.evidence.clientTurns++;
  }

  private emitItem(value: unknown): void {
    const item = record(value);
    const key = identifier(item.id);
    const event = toolEvent(item);
    if (event && !this.emittedItems.has(key)) {
      this.emittedItems.add(key);
      this.emit(event);
    }
  }

  private observeGoal(
    params: RecordValue,
    source: "notification" | "readback" = "notification",
  ): void {
    const status = requiredGoalStatus(params.goal, this.threadId);
    this.goalSeen = true;
    const observation = {
      status,
      characters: Array.from(String(record(params.goal).objective)).length,
      turnId: typeof params.turnId === "string" ? params.turnId : null,
      at: new Date().toISOString(),
      source,
    };
    const previous = this.evidence.goals.at(-1);
    if (!sameGoalObservation(previous, observation))
      this.evidence.goals.push(observation);
  }

  private observeTurn(value: unknown, status?: string): string {
    const turn = record(value);
    const id = identifier(turn.id);
    this.evidence.turns.push({
      id,
      status: status ?? String(turn.status),
      at: new Date().toISOString(),
    });
    return id;
  }

  private observeError(
    source: AppServerErrorEvidence["source"],
    turnId: unknown,
    willRetry: unknown,
    value: unknown,
  ): void {
    const errors = (this.evidence.errors ??= []);
    if (errors.length === 32) {
      errors.shift();
      this.evidence.errorsDropped = (this.evidence.errorsDropped ?? 0) + 1;
    }
    errors.push(errorReceipt(source, this.threadId, turnId, willRetry, value));
  }

  private async onNotification({
    method,
    params,
  }: Notification): Promise<boolean> {
    if (params.threadId !== this.threadId) return false;
    switch (method) {
      case "error":
        this.observeError(
          "error",
          params.turnId,
          params.willRetry,
          params.error,
        );
        if (params.willRetry !== true)
          throw new Error("App-server reported a fatal turn error");
        break;
      case "thread/tokenUsage/updated": {
        const total = record(record(params.tokenUsage).total);
        this.usage = {
          input_tokens: total.inputTokens,
          output_tokens: total.outputTokens,
        };
        break;
      }
      case "item/completed":
        this.emitItem(params.item);
        break;
      case "thread/goal/updated":
        this.observeGoal(params);
        break;
      case "thread/goal/cleared":
        throw new Error("Participant cleared the observed native goal");
      case "turn/started":
        this.observeTurn(params.turn, "started");
        this.emit({ type: "turn.started" });
        break;
      case "turn/completed":
        return this.onCompletedTurn(record(params.turn));
    }
    return false;
  }

  private async onCompletedTurn(turn: RecordValue): Promise<boolean> {
    const turnId = this.observeTurn(turn);
    this.requireCompletedTurn(turn, turnId);
    const status = await this.completedGoal(turnId);
    this.emit({
      type: "turn.completed",
      ...(this.usage ? { usage: this.usage } : {}),
    });
    if (this.followUp !== undefined)
      return this.deliverFeedback(turnId, status, this.followUp);
    return status !== "active" && (await this.saveFinal(turnId));
  }

  private requireCompletedTurn(turn: RecordValue, turnId: string): void {
    if (turn.status === "completed") return;
    this.observeError("turn/completed", turnId, null, turn.error);
    throw new Error(`App-server turn ${String(turn.status)}`);
  }

  private async completedGoal(turnId: string): Promise<string | null> {
    const goal = await this.rpc.call("thread/goal/get", {
      threadId: this.threadId,
    });
    const status = appServerGoalStatus(goal.goal, this.threadId);
    this.evidence.goalStatus = status;
    if (this.goalSeen && status === null)
      throw new Error("Observed native goal disappeared");
    if (status !== null)
      this.observeGoal({ goal: goal.goal, turnId }, "readback");
    return status;
  }

  private async deliverFeedback(
    turnId: string,
    status: string | null,
    prompt: string,
  ): Promise<boolean> {
    // User input does not require a terminal goal. Preserve the completed
    // response and actual boundary before delivering the declared follow-up.
    if (!(await this.saveFinal(turnId, true))) return false;
    const boundary = protocolMessage(
      await this.options.followUpBoundary(this.threadId, {
        nativeGoalObserved: this.goalSeen,
        nativeGoalStatus: status,
      }),
    );
    if (!this.responseBoundaryReady(turnId)) return false;
    this.emit({
      ...boundary,
      native_goal_observed: this.goalSeen,
      native_goal_status: status,
    });
    this.followUp = undefined;
    await this.startUserTurn(prompt);
    return false;
  }

  private async saveFinal(
    turnId: string,
    forFeedback = false,
  ): Promise<boolean> {
    const snapshot = await this.rpc.call("thread/read", {
      threadId: this.threadId,
      includeTurns: true,
    });
    const { thread, turns } = retainedThread(snapshot, this.threadId);
    const latest = record(turns.at(-1));
    // A later native turn can start while readback is pending. Wait for it.
    if (!latestTurnReady(latest, turnId)) return false;
    const final = appServerFinal(thread, turnId);
    for (const value of turns) this.backfillItems(record(value));
    await writeFile(
      join(this.options.request.repoDir, ".git", "last-message.md"),
      final,
    );
    this.evidence.finalTurnId = turnId;
    this.emit({
      type: "item.completed",
      item: { type: "agent_message", text: final },
    });
    if (forFeedback) return this.responseBoundaryReady(turnId);
    this.assertSettled();
    return true;
  }

  /** Continuation may race feedback capture; errors still stop delivery. */
  private responseBoundaryReady(turnId: string): boolean {
    this.rpc.assertHealthy();
    let ready = true;
    for (const event of this.rpc.queue) {
      const { params } = event;
      if (params.threadId !== this.threadId) continue;
      this.validateResponseEvent(event);
      if (laterRootTurn(event, turnId)) ready = false;
    }
    return ready;
  }

  private validateResponseEvent(event: Notification): void {
    if (event.method === "error" || event.method === "thread/goal/cleared")
      this.checkPendingSettlement(event);
    if (event.method === "thread/goal/updated")
      appServerGoalStatus(event.params.goal, this.threadId);
  }

  /** Readback and file I/O can race with a terminal protocol event. */
  assertSettled(): void {
    this.rpc.assertHealthy();
    for (const event of this.rpc.queue) {
      if (event.params.threadId !== this.threadId) continue;
      this.checkPendingSettlement(event);
    }
  }

  private checkPendingSettlement({ method, params }: Notification): void {
    this.requireNonfatalPendingError(method, params);
    if (method === "thread/goal/cleared")
      throw new Error("Native goal cleared during settlement");
    this.requireSettledGoal(method, params);
    if (laterRootTurn({ method, params }, this.evidence.finalTurnId))
      throw new Error("Another root turn appeared during settlement");
  }

  private requireNonfatalPendingError(
    method: string,
    params: RecordValue,
  ): void {
    if (method === "error" && params.willRetry !== true) {
      this.observeError("error", params.turnId, params.willRetry, params.error);
      throw new Error("App-server reported a fatal error during settlement");
    }
  }
  private requireSettledGoal(method: string, params: RecordValue): void {
    if (
      method === "thread/goal/updated" &&
      appServerGoalStatus(params.goal, this.threadId) === "active"
    )
      throw new Error("Native goal became active during settlement");
  }

  private backfillItems(turn: RecordValue): void {
    if (Array.isArray(turn.items))
      for (const item of turn.items) this.emitItem(item);
  }

  async run(): Promise<void> {
    await this.start();
    while (!(await this.onNotification(await this.rpc.next()))) {
      /* Native host owns continuation. */
    }
  }
}

function requiredGoalStatus(value: unknown, threadId: string): string {
  const status = appServerGoalStatus(value, threadId);
  if (status === null) throw new Error("Malformed app-server object");
  return status;
}
function sameGoalObservation(
  previous: AppServerEvidence["goals"][number] | undefined,
  observation: AppServerEvidence["goals"][number],
): boolean {
  return (
    previous?.status === observation.status &&
    previous.turnId === observation.turnId &&
    previous.source === observation.source
  );
}
function errorReceipt(
  source: AppServerErrorEvidence["source"],
  threadId: string,
  turnId: unknown,
  willRetry: unknown,
  value: unknown,
): AppServerErrorEvidence {
  const error = isRecord(value) ? value : {};
  return {
    source,
    threadId,
    turnId: typeof turnId === "string" ? turnId.slice(0, 200) : null,
    willRetry: typeof willRetry === "boolean" ? willRetry : null,
    ...publicErrorMessage(error.message),
    ...errorClassification(error.codexErrorInfo),
  };
}
function retainedThread(snapshot: RecordValue, threadId: string) {
  const thread = record(snapshot.thread);
  if (thread.id !== threadId)
    throw new Error("App-server returned another thread");
  const turns: unknown = thread.turns;
  if (!Array.isArray(turns)) throw new Error("Missing app-server history");
  return { thread, turns: turns as unknown[] };
}
function latestTurnReady(latest: RecordValue, turnId: string): boolean {
  if (latest.id === turnId) return true;
  if (latest.status === "inProgress" || latest.status === "completed")
    return false;
  throw new Error("Later app-server turn did not complete");
}
function laterRootTurn(
  event: Notification,
  turnId: string | undefined,
): boolean {
  return (
    ["turn/started", "turn/completed"].includes(event.method) &&
    record(event.params.turn).id !== turnId
  );
}
function requireAppServerRun(request: HarnessRunRequest, bound: number): void {
  if (request.signal?.aborted) throw new Error("Codex run cancelled");
  if (!Number.isFinite(bound) || bound <= 0)
    throw new Error("Invalid app-server time bound");
}
function sessionFailure(session: AppServerSession, error: unknown): void {
  session.evidence.failure =
    error instanceof Error ? error.message : String(error);
  session.emit({ type: "turn.failed" });
}
async function completeSession(
  session: AppServerSession,
  rpc: AppServerRpc,
  request: HarnessRunRequest,
  bound: number,
): Promise<number> {
  const cancel = () => {
    rpc.fail(new Error("Codex run cancelled"));
  };
  request.signal?.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(() => {
    rpc.fail(new Error("App-server evaluation time bound reached"));
  }, bound);
  try {
    await session.run();
    session.assertSettled();
    return 0;
  } catch (error) {
    sessionFailure(session, error);
    return 1;
  } finally {
    clearTimeout(deadline);
    request.signal?.removeEventListener("abort", cancel);
    await rpc.close();
  }
}
function settlementCode(session: AppServerSession, code: number): number {
  if (code !== 0) return code;
  try {
    session.assertSettled();
    return 0;
  } catch (error) {
    sessionFailure(session, error);
    return 1;
  }
}

export async function runCodexAppServer(options: AppServerRunOptions): Promise<{
  out: string;
  err: string;
  code: number;
  evidence: AppServerEvidence;
}> {
  const { request, argv, env } = options;
  const bound = request.control?.appServerTimeoutMs ?? 3600000;
  requireAppServerRun(request, bound);
  const rpc = new AppServerRpc(argv, request.repoDir, env);
  const session = new AppServerSession(rpc, options);
  const code = await completeSession(session, rpc, request, bound);
  // Flush stdout before accepting success, including trailing data and terminal errors.
  const finalCode = settlementCode(session, code);
  return {
    out: session.out.join("\n"),
    err: rpc.stderr,
    code: finalCode,
    evidence: session.evidence,
  };
}
