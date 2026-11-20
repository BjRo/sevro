#!/usr/bin/env bun
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
if (defined(process.argv[2]) === "sandbox") process.exit(0);
if (defined(process.argv[2]) !== "app-server") process.exit(99);
const send = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
const goal = (status: string) => ({
  threadId: "root",
  objective: "PRIVATE_GOAL_OBJECTIVE",
  status,
});
const turns: Array<Record<string, unknown>> = [];
let continued = false;
let clientTurns = 0;
// Persist cumulative root totals and one subagent rollout, as Codex does.
const sessions = join(defined(process.env.CODEX_HOME), "sessions/2026/09/27");
let rootOrdinal = 0;
const rootUsage = { inputTokens: 0, outputTokens: 0 };
const tokenCount = (ordinal: number, input: number, output: number) =>
  JSON.stringify({
    ordinal,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: input, output_tokens: output },
      },
    },
  }) + "\n";
const meta = (id: string, source: unknown) =>
  JSON.stringify({
    ordinal: 0,
    type: "session_meta",
    payload: { id, source },
  }) + "\n";
const reportUsage = (input: number, output: number) => {
  mkdirSync(sessions, { recursive: true });
  const root = join(sessions, "rollout-2026-09-27T00-00-00-root.jsonl");
  if (rootOrdinal === 0) writeFileSync(root, meta("root", "vscode"));
  rootUsage.inputTokens += input;
  rootUsage.outputTokens += output;
  appendFileSync(
    root,
    tokenCount(++rootOrdinal, rootUsage.inputTokens, rootUsage.outputTokens),
  );
  writeFileSync(
    join(sessions, "rollout-2026-09-27T00-00-01-child.jsonl"),
    meta("child", {
      subagent: { thread_spawn: { parent_thread_id: "root", depth: 1 } },
    }) + tokenCount(1, 9, 1),
  );
};
const begin = (id: string) => {
  turns.push({ id, status: "inProgress", items: [] });
  send({
    method: "turn/started",
    params: { threadId: "root", turn: { id, status: "inProgress" } },
  });
  const skill = clientTurns === 1 ? "initial" : "follow-up";
  const path = join(process.cwd(), ".agents/skills", skill, "SKILL.md");
  if (existsSync(path)) {
    const item = {
      type: "commandExecution",
      id: "read-" + id,
      command: "cat " + path,
      status: "completed",
      exitCode: 0,
      aggregatedOutput: readFileSync(path, "utf8"),
    };
    send({
      method: "item/completed",
      params: { threadId: "root", turnId: id, item },
    });
  }
};
const finish = (id: string, text: string) => {
  reportUsage(100, 10);
  const turn = defined(turns.find((row) => row.id === id));
  turn.status = "completed";
  turn.items = [
    { type: "agentMessage", id: "final-" + id, phase: "final_answer", text },
  ];
  send({
    method: "turn/completed",
    params: { threadId: "root", turn: { id, status: "completed" } },
  });
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = parseRecord(line);
  appendFileSync(
    join(process.cwd(), ".git", "requests.jsonl"),
    JSON.stringify(message) + "\n",
  );
  if (message.id === undefined) return;
  const reply = (result: unknown) => send({ id: message.id, result });
  dispatchMessage(message, reply);
});
function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing peer fixture value");
  return value;
}
function parseRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a peer message object");
  return value as Record<string, unknown>;
}
function startTurn(reply: (result: unknown) => void) {
  clientTurns++;
  reply({ turn: { id: "first", status: "inProgress" } });
  begin("first");
  if (clientTurns === 1 && existsSync(join(process.cwd(), "feedback.txt"))) {
    finish("first", "waiting");
    return;
  }
  if (existsSync(join(process.cwd(), "failure.txt"))) {
    reportUsage(40, 4);
    send({
      method: "error",
      params: {
        threadId: "root",
        turnId: "first",
        willRetry: false,
        error: { message: "Access expired", codexErrorInfo: "unauthorized" },
      },
    });
    return;
  }
  send({
    method: "thread/goal/updated",
    params: { threadId: "root", turnId: "first", goal: goal("active") },
  });
  finish("first", "checkpoint");
}
function getGoal(reply: (result: unknown) => void) {
  if (clientTurns === 1 && existsSync(join(process.cwd(), "feedback.txt"))) {
    reply({ goal: null });
    return;
  }
  reply({ goal: goal(continued ? "complete" : "active") });
  if (!continued) {
    continued = true;
    setTimeout(() => {
      begin("native-2");
      send({
        method: "thread/goal/updated",
        params: {
          threadId: "root",
          turnId: "native-2",
          goal: goal("complete"),
        },
      });
      setTimeout(() => {
        finish("native-2", "ready");
      }, 30);
    }, 10);
  }
}
function dispatchMessage(
  message: Record<string, unknown>,
  reply: (result: unknown) => void,
) {
  const handlers: Record<string, () => void> = {
    initialize: () => {
      reply({});
    },
    "thread/start": () => {
      reply({
        thread: { id: "root" },
        model: "synthetic",
        modelProvider: "openai",
        reasoningEffort: "low",
      });
    },
    "turn/start": () => {
      startTurn(reply);
    },
    "thread/goal/get": () => {
      getGoal(reply);
    },
    "thread/read": () => {
      reply({ thread: { id: "root", turns } });
    },
  };
  const handler =
    typeof message.method === "string" ? handlers[message.method] : undefined;
  if (handler) handler();
  else
    send({
      id: message.id,
      error: { code: -32601, message: "Unexpected operation" },
    });
}
