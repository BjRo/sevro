import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexNativeCallObservation } from "../../src/hosts/codex-native-calls";
import { codexNativeControls } from "../../src/hosts/native-controls";
import { createTemporaryFixtures } from "./filesystem";

export async function submittedProgram(
  roots: string[],
  input: string,
  ordinal: number,
) {
  const root = await home(roots);
  const padding = Array.from({ length: ordinal }, () => ({
    type: "event_msg",
  }));
  await session(
    root,
    lines([
      ...padding,
      { type: "custom_tool_call", name: "exec", call_id: "retained", input },
      {
        type: "custom_tool_call_output",
        call_id: "retained",
        output: [
          {
            type: "text",
            text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
          },
        ],
      },
    ]),
  );
  return codexNativeControls(
    await codexNativeCallObservation(root, "thread-1"),
  );
}

export async function home(roots: string[]) {
  const { temporaryFixture } = createTemporaryFixtures(roots);

  const root = await temporaryFixture(join(tmpdir(), "sevro-native-calls-"));

  return root;
}

export async function session(
  root: string,
  content: string,
  suffix = "thread-1",
) {
  const directory = join(root, "sessions", "2026", "09", "27");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `rollout-${suffix}.jsonl`), content);
}

export function lines(payloads: Array<Record<string, unknown>>) {
  return (
    payloads
      .map((payload, ordinal) => JSON.stringify({ ordinal, payload }))
      .join("\n") + "\n"
  );
}

export const spawn = {
  type: "function_call",
  namespace: "collaboration",
  name: "spawn_agent",
  call_id: "call_1",
  arguments: JSON.stringify({
    task_name: "reviewer",
    model: "gpt-6-sol",
    reasoning_effort: "high",
    fork_turns: "none",
    message: "private review task",
  }),
};

export const started = {
  type: "item_completed",
  item: {
    type: "SubAgentActivity",
    id: "call_1",
    kind: "started",
    agent_path: "/root/reviewer",
    agent_thread_id: "thread-child",
  },
};

export const result = {
  type: "function_call_output",
  call_id: "call_1",
  output: JSON.stringify({ task_name: "/root/reviewer" }),
};
