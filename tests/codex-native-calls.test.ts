import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexNativeCallObservation } from "../src/hosts/codex-native-calls";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function home() {
  const root = await mkdtemp(join(tmpdir(), "sevro-native-calls-"));
  roots.push(root);
  return root;
}

async function session(root: string, content: string, suffix = "thread-1") {
  const directory = join(root, "sessions", "2026", "09", "27");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `rollout-${suffix}.jsonl`), content);
}

test("native goal and agent calls retain names and order without private arguments", async () => {
  const root = await home();
  await session(
    root,
    [
      {
        ordinal: 0,
        payload: {
          type: "function_call",
          namespace: "functions",
          name: "create_goal",
          arguments: '{"objective":"private objective"}',
        },
      },
      {
        ordinal: 1,
        payload: {
          type: "custom_tool_call",
          name: "exec",
          input: "private code",
        },
      },
      {
        ordinal: 2,
        payload: {
          type: "function_call",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: '{"message":"private task"}',
        },
      },
      {
        ordinal: 3,
        payload: { type: "function_call_output", output: "private result" },
      },
      {
        ordinal: 4,
        payload: { type: "function_call", name: "get_goal" },
      },
      {
        ordinal: 5,
        payload: {
          type: "function_call",
          namespace: "other",
          name: "update_goal",
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const observed = await codexNativeCallObservation(root, "thread-1");
  expect(observed).toEqual({
    id: "sevro.codex.native-calls",
    completeness: "complete",
    data: {
      method: "native_session",
      calls: [
        {
          ordinal: 0,
          namespace: "functions",
          name: "create_goal",
          evidence: "invocation_attempt",
        },
        {
          ordinal: 2,
          namespace: "collaboration",
          name: "spawn_agent",
          evidence: "invocation_attempt",
        },
        {
          ordinal: 4,
          namespace: "functions",
          name: "get_goal",
          evidence: "invocation_attempt",
        },
      ],
      submittedExecCalls: 1,
    },
  });
  expect(JSON.stringify(observed)).not.toContain("private");
});

test("missing, ambiguous, and malformed native sessions cannot prove absence", async () => {
  const root = await home();
  expect(await codexNativeCallObservation(root, "thread-1")).toMatchObject({
    completeness: "unavailable",
    data: { calls: [] },
  });
  await session(root, "{broken\n");
  expect(await codexNativeCallObservation(root, "thread-1")).toMatchObject({
    completeness: "partial",
    data: { calls: [] },
  });
  await session(
    root,
    '{"ordinal":0,"payload":{"type":"function_call","name":"get_goal"}}\n',
    "other-thread-1",
  );
  expect(await codexNativeCallObservation(root, "thread-1")).toMatchObject({
    completeness: "partial",
  });
});

test("native session traversal refuses links and oversized content", async () => {
  const root = await home();
  await session(root, `${" ".repeat(8 * 1024 * 1024)}\n`);
  expect(await codexNativeCallObservation(root, "thread-1")).toMatchObject({
    completeness: "partial",
  });
  await rm(join(root, "sessions"), { recursive: true });
  const outside = await home();
  await symlink(outside, join(root, "sessions"));
  expect(await codexNativeCallObservation(root, "thread-1")).toMatchObject({
    completeness: "partial",
  });
});
