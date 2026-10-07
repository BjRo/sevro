#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
if (defined(process.argv[2]) === "sandbox") process.exit(0);
if (defined(process.argv[2]) !== "exec") process.exit(99);
await Bun.stdin.text();
const path = join(process.cwd(), ".agents/skills/probe/SKILL.md");
const body = await readFile(path, "utf8");
const mode = await readFile("read-mode.txt", "utf8");
const fabricated = mode === "fabricated";
const command = `cat ${path}`;
const commandCompletion = {
  ordinal: 2,
  payload: {
    type: "item_completed",
    item: {
      id: "command",
      type: "CommandExecution",
      source: "unified_exec_startup",
      process_id: "123",
      command: ["/bin/sh", "-c", command],
      cwd: process.cwd(),
      status: "completed",
      exit_code: 0,
      aggregated_output: "",
    },
  },
};
const entries = [
  {
    ordinal: 1,
    payload: {
      type: "custom_tool_call",
      name: "exec",
      namespace: "functions",
      call_id: "read",
      input: fabricated
        ? `const result = await tools.exec_command({cmd:${JSON.stringify(command)}}); text(${JSON.stringify(body)});`
        : `const result = await tools.exec_command({cmd:${JSON.stringify(command)}}); text(result.output);`,
    },
  },
  commandCompletion,
  {
    ordinal: 3,
    payload: {
      type: "custom_tool_call_output",
      call_id: "read",
      output: [
        {
          type: "input_text",
          text: "Script completed\nWall time 1 seconds\nOutput:\n",
        },
        { type: "input_text", text: body },
      ],
    },
  },
];
if (mode === "literal") {
  const result = defined(entries.pop());
  const completion = defined(entries.pop());
  entries.push({ ...result, ordinal: 2 }, { ...completion, ordinal: 3 });
}
if (mode === "native") {
  const completion = commandCompletion;
  entries.splice(0, entries.length, {
    ...completion,
    ordinal: 1,
    payload: {
      ...completion.payload,
      item: { ...completion.payload.item, aggregated_output: body },
    },
  });
}
await mkdir(join(defined(process.env.CODEX_HOME), "sessions"), {
  recursive: true,
});
await writeFile(
  join(defined(process.env.CODEX_HOME), "sessions/rollout-root.jsonl"),
  entries.map((row) => JSON.stringify(row)).join("\n"),
);
console.log(JSON.stringify({ type: "thread.started", thread_id: "root" }));
console.log(
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "command",
      type: "command_execution",
      command,
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
function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing peer fixture value");
  return value;
}
