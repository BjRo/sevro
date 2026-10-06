#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

if (process.argv[2] === "sandbox") process.exit(0);
if (process.argv[2] !== "app-server") process.exit(99);
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
const begin = (id: string) => {
  turns.push({ id, status: "inProgress", items: [] });
  send({
    method: "turn/started",
    params: { threadId: "root", turn: { id, status: "inProgress" } },
  });
};
const finish = (id: string, text: string) => {
  const turn = turns.find((row) => row.id === id)!;
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
  const message = JSON.parse(line);
  appendFileSync(
    join(process.cwd(), ".git", "requests.jsonl"),
    JSON.stringify(message) + "\n",
  );
  if (message.id === undefined) return;
  const reply = (result: unknown) => send({ id: message.id, result });
  if (message.method === "initialize") reply({});
  else if (message.method === "thread/start")
    reply({
      thread: { id: "root" },
      model: "synthetic",
      modelProvider: "openai",
      reasoningEffort: "low",
    });
  else if (message.method === "turn/start") {
    clientTurns++;
    reply({ turn: { id: "first", status: "inProgress" } });
    begin("first");
    if (clientTurns === 1 && existsSync(join(process.cwd(), "feedback.txt"))) {
      finish("first", "waiting");
      return;
    }
    if (existsSync(join(process.cwd(), "failure.txt"))) {
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
  } else if (message.method === "thread/goal/get") {
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
        setTimeout(() => finish("native-2", "ready"), 30);
      }, 10);
    }
  } else if (message.method === "thread/read")
    reply({ thread: { id: "root", turns } });
  else
    send({
      id: message.id,
      error: { code: -32601, message: "Unexpected operation" },
    });
});
