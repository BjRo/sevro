import {
  appendFileSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const mode = process.argv[2] ?? "success";
let turnCount = 0;
let historyReads = 0;
let boundaryNativeComplete = false;
const boundaryFiles = new Set<string>();
const send = (value: unknown) => {
  process.stdout.write(JSON.stringify(value) + "\n");
};
const goal = (status: unknown = "complete") => ({
  threadId: "root",
  objective: "PRIVATE_OBJECTIVE🙂",
  status,
});
function parseMessage(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Fixture expected message object");
  return value as Record<string, unknown>;
}
const badInitialize: Record<string, string> = {
  "malformed-json": "{broken",
  "array-message": "[]",
  "empty-message": "{}",
  "unmatched-response": '{"id":999,"result":{}}',
  "array-response": '{"id":1,"result":[]}',
  "rpc-error": '{"id":1,"error":{"code":-42}}',
  "server-request":
    '{"id":"approval","method":"item/commandExecution/requestApproval","params":{}}',
};
function initialize(id: unknown): void {
  diagnosticStderr();
  if (mode === "oversized-stream") {
    process.stdout.write("x".repeat(8 * 1024 * 1024 + 1) + "\n");
    return;
  }
  const bad = badInitialize[mode];
  if (bad !== undefined) {
    process.stdout.write(bad + "\n");
    return;
  }
  if (mode === "silent") return;
  if (mode === "exit") {
    process.exit(7);
  }
  process.stdout.write("\n");
  initializeResponse(id);
}
function initializeResponse(id: unknown): void {
  if (mode === "fail-after-initialize-response") {
    process.stdout.write(
      JSON.stringify({ id, result: {} }) +
        "\n" +
        JSON.stringify({ method: "turn/started", params: null }) +
        "\n",
    );
    return;
  }
  send({ id, result: {} });
}
function startThread(id: unknown): void {
  if (mode === "exit-pending-thread-start") process.exit(7);
  overloadNotifications();
  send({
    id,
    result: {
      thread: { id: mode === "missing-thread-id" ? "" : "root" },
      model: mode === "route-mismatch" ? "another-model" : "synthetic",
      reasoningEffort: "low",
      modelProvider: "openai",
    },
  });
}
function notify(method: string, params: Record<string, unknown>): void {
  send({ method, params: { threadId: "root", ...params } });
}
function retryErrors(): void {
  const count = mode === "many-errors" ? 34 : 1;
  for (let index = 0; index < count; index++)
    notify("error", {
      turnId: "first",
      willRetry: true,
      error: retryErrorValue({
        message:
          "Authorization: Bearer PRIVATE_TOKEN\napi_key=sk-PRIVATE_KEY " +
          "z".repeat(2100),
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
      }),
    });
}
function retryErrorValue(value: unknown): unknown {
  const alternatives: Record<string, unknown> = {
    "empty-error-errors": null,
    "invalid-message-errors": {
      message: 42,
      codexErrorInfo: { httpConnectionFailed: null },
    },
    "invalid-http-errors": {
      message: "Temporary failure",
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: "503" } },
    },
  };
  return Object.hasOwn(alternatives, mode) ? alternatives[mode] : value;
}
function goalNotifications(): void {
  extraGoalNotifications();
  if (mode === "goal-disappeared")
    notify("thread/goal/updated", { goal: goal("active") });
  if (mode === "cleared-goal") notify("thread/goal/cleared", {});
  if (mode === "invalid-goal-notification")
    notify("thread/goal/updated", { goal: { ...goal(), objective: "" } });
}
function extraGoalNotifications(): void {
  if (mode === "duplicate-goal") {
    for (let index = 0; index < 3; index++)
      notify("thread/goal/updated", { goal: goal(), turnId: "first" });
  }
  if (mode === "null-goal-notification")
    notify("thread/goal/updated", { goal: null });
}
function startTurn(id: unknown): void {
  turnCount++;
  const turnId = turnCount === 1 ? "first" : "follow-up";
  peerReceipt(`client-${turnId}`);
  send({ id, result: { turn: { id: turnId } } });
  if (exitAfterTurnResponse()) return;
  send({ method: "account/private", params: "PRIVATE_ACCOUNT" });
  notify("error", {
    threadId: "foreign",
    error: { message: "FOREIGN_SECRET" },
  });
  notify("turn/started", { turn: { id: turnId, status: "inProgress" } });
  goalNotifications();
  if (mode.endsWith("errors")) retryErrors();
  if (mode === "fatal-error") {
    notify("error", {
      turnId,
      willRetry: false,
      error: {
        message: "Bearer PRIVATE_FATAL",
        codexErrorInfo: "unauthorized",
      },
    });
    return;
  }
  notify("thread/tokenUsage/updated", {
    tokenUsage: { total: { inputTokens: 0, outputTokens: 7 } },
  });
  notify("item/completed", { item: commandItem() });
  notify("item/completed", { item: commandItem() });
  notify("item/completed", {
    item: { id: "reasoning", type: "reasoning", text: "PRIVATE_REASONING" },
  });
  completeTurnNotification(turnId);
}
function exitAfterTurnResponse(): boolean {
  if (mode !== "exit-after-turn-response") return false;
  process.stdout.write("", () => {
    process.exit(7);
  });
  return true;
}
function completeTurnNotification(turnId: string): void {
  notify("turn/completed", {
    turn: {
      id: turnId,
      status: mode === "failed-turn" ? "failed" : "completed",
      error: { message: "PRIVATE_FAILED", codexErrorInfo: {} },
    },
  });
}
function commandItem() {
  return {
    id: "command",
    type: "commandExecution",
    command: "printf public",
    status: mode === "failed-command-item" ? "failed" : "completed",
    exitCode: mode === "failed-command-item" ? 1 : 0,
    aggregatedOutput: "public",
  };
}
function finalItems(): unknown {
  if (mode === "missing-items") return null;
  if (mode === "missing-final")
    return [
      {
        id: "analysis",
        type: "agentMessage",
        phase: "commentary",
        text: "PRIVATE_COMMENTARY",
      },
    ];
  return [
    commandItem(),
    {
      id: "collab",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "completed",
      receiverThreadIds: ["child"],
    },
    {
      id: "answer",
      type: "agentMessage",
      phase: "final_answer",
      text: "ready",
    },
    {
      id: "second-answer",
      type: "agentMessage",
      phase: "final_answer",
      text: "done",
    },
  ];
}
function readThread(id: unknown): void {
  if (mode === "missing-history") {
    send({ id, result: { thread: { id: "root" } } });
    return;
  }
  const turnId = turnCount === 1 ? "first" : "follow-up";
  const turn = { id: turnId, status: "completed", items: finalItems() };
  const turns = retainedTurns(turn);
  send({
    id,
    result: {
      thread: { id: mode === "foreign-history" ? "foreign" : "root", turns },
    },
  });
  afterRead();
}
function retainedTurns(
  turn: Record<string, unknown>,
): Record<string, unknown>[] {
  historyReads++;
  if (mode === "duplicate-turn") return [turn, turn];
  if (mode === "later-failed-history")
    return [turn, { id: "native-2", status: "failed" }];
  return boundaryHistory(turn) ?? readbackRaceHistory(turn);
}
function readbackRaceHistory(
  turn: Record<string, unknown>,
): Record<string, unknown>[] {
  if (mode !== "native-read-race" || turnCount > 1) return [turn];
  return [turn, racedNativeTurn()];
}
function racedNativeTurn(): Record<string, unknown> {
  return {
    id: "native-2",
    status: historyReads === 1 ? "inProgress" : "completed",
    items: finalItems(),
  };
}
function afterRead(): void {
  const actions: Record<string, () => void> = {
    "settlement-fatal": () => {
      notify("error", {
        willRetry: false,
        error: { message: "Bearer PRIVATE_SETTLEMENT" },
      });
    },
    "settlement-cleared": () => {
      notify("thread/goal/cleared", {});
    },
    "settlement-active": () => {
      notify("thread/goal/updated", { goal: goal("active") });
    },
    "settlement-turn": () => {
      notify("turn/started", {
        turn: { id: "native-2", status: "inProgress" },
      });
    },
    "native-read-race": () => {
      announceNativeTurn();
    },
    "settlement-foreign": () => {
      notify("thread/goal/cleared", { threadId: "foreign" });
    },
  };
  actions[mode]?.();
}
function announceNativeTurn(): void {
  if (historyReads !== 1) return;
  notify("turn/started", { turn: { id: "native-2", status: "inProgress" } });
  setTimeout(() => {
    notify("turn/completed", { turn: { id: "native-2", status: "completed" } });
  }, 10);
}
function getGoal(id: unknown): void {
  const modes: Record<string, unknown> = {
    "array-goal-status": goal(["complete"]),
    "invalid-goal-status": goal("unknown"),
    "foreign-goal": { ...goal(), threadId: "foreign" },
    "invalid-goal-objective": { ...goal(), objective: 5 },
    "long-goal": { ...goal(), objective: "a".repeat(4001) },
    "complete-goal": goal(),
    "paused-goal": goal("paused"),
    "blocked-goal": goal("blocked"),
    "usageLimited-goal": goal("usageLimited"),
    "budgetLimited-goal": goal("budgetLimited"),
    "duplicate-goal": goal(),
    "boundary-goal-valid": goal(),
  };
  send({
    id,
    result: {
      goal:
        mode === "feedback-active-goal"
          ? goal(turnCount === 1 ? "active" : "complete")
          : (modes[mode] ?? null),
    },
  });
}
function dispatch(message: Record<string, unknown>): void {
  const handlers: Record<string, () => void> = {
    initialize: () => {
      initialize(message.id);
    },
    "thread/start": () => {
      startThread(message.id);
    },
    "turn/start": () => {
      startTurn(message.id);
    },
    "thread/goal/get": () => {
      getGoal(message.id);
    },
    "thread/read": () => {
      readThread(message.id);
    },
  };
  const handler =
    typeof message.method === "string" ? handlers[message.method] : undefined;
  handler?.();
}
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = parseMessage(line);
    appendFileSync(
      join(process.cwd(), ".git", "requests.jsonl"),
      JSON.stringify(message) + "\n",
    );
    if (message.id !== undefined) dispatch(message);
  })
  .on("close", () => {
    if (mode === "trailing-malformed-on-close") process.stdout.write("{broken");
    boundaryWatcher?.close();
    keepPeerAfterEof();
  });

function diagnosticStderr(): void {
  if (mode !== "large-stderr") return;
  process.stderr.write(
    "DISCARDED_DIAGNOSTIC_PREFIX" +
      "x".repeat(20000) +
      "RETAINED_DIAGNOSTIC_TAIL\n",
  );
}

function overloadNotifications(): void {
  if (mode !== "notification-backlog") return;
  for (let index = 0; index < 1025; index++)
    notify("thread/tokenUsage/updated", {
      tokenUsage: { total: { inputTokens: index, outputTokens: 0 } },
    });
}

function peerReceipt(event: string): void {
  appendFileSync(
    join(process.cwd(), ".git", "peer-events.jsonl"),
    JSON.stringify({ event, pid: process.pid }) + "\n",
  );
}

function keepPeerAfterEof(): void {
  if (!mode.startsWith("ignore-eof")) return;
  peerReceipt("stdin-eof");
  setInterval(() => {}, 1000);
}

function peerTermination(): void {
  peerReceipt("sigterm");
  if (mode !== "ignore-eof-and-term") process.exit(0);
}

if (mode.startsWith("ignore-eof")) process.on("SIGTERM", peerTermination);

function boundaryHistory(
  turn: Record<string, unknown>,
): Record<string, unknown>[] | undefined {
  if (
    mode !== "boundary-native-turn" ||
    !boundaryNativeComplete ||
    turnCount > 1
  )
    return undefined;
  return [turn, { id: "native-2", status: "completed", items: finalItems() }];
}

function boundaryEvents(): unknown[] {
  const params = { threadId: "root" };
  const rootEvents: Record<string, unknown> = {
    "boundary-fatal": {
      method: "error",
      params: {
        ...params,
        turnId: "first",
        willRetry: false,
        error: { message: "Authorization: Bearer boundary-credential" },
      },
    },
    "boundary-cleared": { method: "thread/goal/cleared", params },
    "boundary-native-turn": {
      method: "turn/started",
      params: { ...params, turn: { id: "native-2", status: "inProgress" } },
    },
    "boundary-goal-valid": {
      method: "thread/goal/updated",
      params: { ...params, goal: goal() },
    },
    "boundary-goal-invalid": {
      method: "thread/goal/updated",
      params: { ...params, goal: goal(["complete"]) },
    },
  };
  return [
    {
      method: "turn/started",
      params: {
        threadId: "foreign",
        turn: { id: "foreign-turn", status: "inProgress" },
      },
    },
    rootEvents[mode],
  ];
}

function boundaryTrace(event: string, details: Record<string, unknown>): void {
  appendFileSync(
    join(process.cwd(), ".git", "boundary-trace.jsonl"),
    JSON.stringify({ at: Date.now(), pid: process.pid, event, ...details }) +
      "\n",
  );
}

function emitBoundaryReceipt(events: unknown[], receipt: string): void {
  const payload = events.map((event) => JSON.stringify(event) + "\n").join("");
  boundaryTrace("stdout-queued", { receipt, events });
  process.stdout.write(payload, () => {
    boundaryTrace("stdout-write-completed", { receipt });
    peerReceipt(receipt);
    const path = join(process.cwd(), ".git", receipt);
    writeFileSync(path + ".pending", "emitted");
    renameSync(path + ".pending", path);
    boundaryTrace("receipt-committed", { receipt });
  });
}

function boundaryFileChanged(name: string): void {
  if (name === "capture-boundary") {
    boundaryTrace("command-observed", { name });
    emitBoundaryReceipt(boundaryEvents(), "boundary-emitted");
  }
  if (name === "release-native-turn") {
    boundaryTrace("command-observed", { name });
    boundaryNativeComplete = true;
    emitBoundaryReceipt(
      [
        {
          method: "turn/completed",
          params: {
            threadId: "root",
            turn: { id: "native-2", status: "completed" },
          },
        },
      ],
      "native-completed",
    );
  }
}

function boundaryCommandReady(name: string): boolean {
  try {
    return readFileSync(join(process.cwd(), ".git", name), "utf8") === "emit";
  } catch {
    return false;
  }
}

function inspectBoundaryCommands(): void {
  for (const name of ["capture-boundary", "release-native-turn"]) {
    if (boundaryFiles.has(name) || !boundaryCommandReady(name)) continue;
    boundaryFiles.add(name);
    boundaryFileChanged(name);
  }
}

const boundaryWatcher = mode.startsWith("boundary-")
  ? watch(join(process.cwd(), ".git"), () => {
      inspectBoundaryCommands();
    })
  : undefined;
if (boundaryWatcher) inspectBoundaryCommands();

function processOutputFixture(): void {
  if (!mode.startsWith("process-")) return;
  peerReceipt("process-started");
  const stream = mode === "process-stderr" ? process.stderr : process.stdout;
  stream.write(Buffer.alloc(Number(process.argv[3]), "x"), () => {
    peerReceipt("process-written");
    if (process.argv[4] !== "stay-open") process.exit(0);
  });
  if (process.argv[4] === "stay-open") setInterval(() => {}, 1000);
}
processOutputFixture();
