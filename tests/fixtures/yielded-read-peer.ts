#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
if (process.argv[2] === "sandbox") process.exit(0);
if (process.argv[2] !== "exec") process.exit(99);
await Bun.stdin.text();
const path = join(process.cwd(), ".agents/skills/probe/SKILL.md");
const body = await readFile(path, "utf8");
const entries = [
  {
    ordinal: 1,
    payload: {
      type: "custom_tool_call",
      name: "exec",
      namespace: "functions",
      call_id: "read",
      input: "PRIVATE_INPUT",
    },
  },
  {
    ordinal: 2,
    payload: {
      type: "custom_tool_call_output",
      call_id: "read",
      output: [
        {
          type: "input_text",
          text: JSON.stringify({
            chunk_id: "first",
            session_id: 123,
            wall_time_seconds: 1,
            output: body,
          }),
        },
      ],
    },
  },
  {
    ordinal: 3,
    payload: {
      type: "item_completed",
      item: {
        id: "command",
        type: "CommandExecution",
        source: "unified_exec_startup",
        process_id: "123",
        command: ["/bin/sh", "-c", `cat ${path}`],
        cwd: process.cwd(),
        status: "completed",
        exit_code: 0,
        aggregated_output: "",
      },
    },
  },
];
await mkdir(join(process.env.CODEX_HOME!, "sessions"), { recursive: true });
await writeFile(
  join(process.env.CODEX_HOME!, "sessions/rollout-root.jsonl"),
  entries.map((row) => JSON.stringify(row)).join("\n"),
);
console.log(JSON.stringify({ type: "thread.started", thread_id: "root" }));
console.log(
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "command",
      type: "command_execution",
      command: `cat ${path}`,
      status: "completed",
      exit_code: 0,
      aggregated_output: "",
    },
  }),
);
console.log(
  JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "ready" },
  }),
);
console.log(
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
);
