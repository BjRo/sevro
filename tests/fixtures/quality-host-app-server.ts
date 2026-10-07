import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const mode = process.argv[2] ?? "success";
let turnCount = 0;
let historyReads = 0;
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
  send({ id, result: {} });
}
function startThread(id: unknown): void {
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
      error: {
        message:
          "Authorization: Bearer PRIVATE_TOKEN\napi_key=sk-PRIVATE_KEY " +
          "z".repeat(2100),
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
      },
    });
}
function goalNotifications(): void {
  if (mode === "goal-disappeared")
    notify("thread/goal/updated", { goal: goal("active") });
  if (mode === "cleared-goal") notify("thread/goal/cleared", {});
  if (mode === "invalid-goal-notification")
    notify("thread/goal/updated", { goal: { ...goal(), objective: "" } });
}
function startTurn(id: unknown): void {
  turnCount++;
  const turnId = turnCount === 1 ? "first" : "follow-up";
  send({ id, result: { turn: { id: turnId } } });
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
    status: "completed",
    exitCode: 0,
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
  };
  send({ id, result: { goal: modes[mode] ?? null } });
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
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = parseMessage(line);
  appendFileSync(
    join(process.cwd(), ".git", "requests.jsonl"),
    JSON.stringify(message) + "\n",
  );
  if (message.id !== undefined) dispatch(message);
});
