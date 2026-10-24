import { afterEach, expect, test } from "bun:test";
import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codexNativeCallObservation,
  codexNativeSessionLastOrdinal,
} from "../../../src/hosts/codex-native-calls";
import { defined, expectUnknown } from "../../fixtures/assertions";
import {
  home,
  lines,
  result,
  session,
  spawn,
  started,
} from "../../fixtures/codex-native-calls";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("ambiguous, mismatched, and malformed spawn evidence cannot establish acceptance", async () => {
  const root = await home(roots);
  for (const payloads of [
    [spawn, started, started, result],
    [spawn, started, result, result],
    [spawn, spawn, started, result],
    [spawn, result, started],
    [spawn, started, { ...result, output: '{"task_name":"/root/other"}' }],
  ]) {
    await session(root, lines(payloads));
    expectUnknown(
      (await codexNativeCallObservation(root, "thread-1")).data.acceptedSpawns,
    ).toEqual([]);
  }
  await session(root, lines([spawn, started, result]) + "{bad\n");
  const partial = await codexNativeCallObservation(root, "thread-1");
  expect(partial.completeness).toBe("partial");
  expectUnknown(partial.data.acceptedSpawns).toEqual([]);
});

test("missing, ambiguous, and malformed native sessions cannot prove absence", async () => {
  const root = await home(roots);
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
  const root = await home(roots);
  await session(root, `${" ".repeat(8 * 1024 * 1024)}\n`);
  expect(await codexNativeCallObservation(root, "thread-1")).toMatchObject({
    completeness: "partial",
  });
  await rm(join(root, "sessions"), { recursive: true });
  const outside = await home(roots);
  await symlink(outside, join(root, "sessions"));
  expect(await codexNativeCallObservation(root, "thread-1")).toMatchObject({
    completeness: "partial",
  });
});

test.each([null, 42, "[]", "null"])(
  "native malformed serialized spawn arguments cannot establish acceptance: %s",
  async (argumentsValue) => {
    const root = await home(roots);
    await session(
      root,
      lines([{ ...spawn, arguments: argumentsValue }, started, result]),
    );
    const observed = await codexNativeCallObservation(root, "thread-1");
    expect(observed.completeness).toBe("complete");
    expect(observed.data.acceptedSpawns).toEqual([]);
    expect(observed.data.toolCalls).toMatchObject([{ name: "spawn_agent" }]);
  },
);

test("accepted spawn identity survives absent optional requested route fields", async () => {
  const root = await home(roots);
  await session(root, lines([{ ...spawn, arguments: "{}" }, started, result]));
  const observed = await codexNativeCallObservation(root, "thread-1");
  expect(observed.data.acceptedSpawns).toHaveLength(1);
  expect(defined(observed.data.acceptedSpawns[0])).toMatchObject({
    agentRef: "/root/reviewer",
    threadId: "thread-child",
  });
  expect(defined(observed.data.acceptedSpawns[0]).taskName).toBeUndefined();
});

test.each([
  { name: "nonarray", content: null },
  { name: "empty blocks", content: [] },
  { name: "nonstring text", content: [{ type: "Text", text: 42 }] },
  {
    name: "nontext block",
    content: [{ type: "Image", text: "private answer" }],
  },
])(
  "child completion cannot bind malformed final content: %j",
  async ({ content }) => {
    const root = await home(roots);
    await session(root, lines([spawn, started, result]));
    await session(
      root,
      lines([
        {
          type: "item_completed",
          turn_id: "turn-child",
          item: { type: "AgentMessage", phase: "final_answer", content },
        },
        {
          type: "task_complete",
          turn_id: "turn-child",
          last_agent_message: "private answer",
        },
      ]),
      "thread-child",
    );
    const observed = await codexNativeCallObservation(root, "thread-1");
    expect(defined(observed.data.childSessions[0])).toMatchObject({
      status: "available",
      resultStatus: "unavailable",
    });
    expect(JSON.stringify(observed)).not.toContain("private answer");
  },
);

test.each(["thread-1", "thread-child"])(
  "nested spawn cannot use its root or parent session as reader evidence: %s",
  async (threadId) => {
    const root = await home(roots);
    await session(root, lines([spawn, started, result]));
    await session(
      root,
      lines([
        { ...spawn, call_id: "nested", arguments: "{}" },
        {
          ...started,
          item: {
            ...started.item,
            id: "nested",
            agent_path: "/root/reviewer/reader",
            agent_thread_id: threadId,
          },
        },
        {
          ...result,
          call_id: "nested",
          output: JSON.stringify({ task_name: "/root/reviewer/reader" }),
        },
      ]),
      "thread-child",
    );
    const observed = await codexNativeCallObservation(root, "thread-1");
    expect(defined(observed.data.childSessions[0]).nestedSpawns).toMatchObject([
      {
        status: "accepted",
        sessionStatus: "partial",
        readerResultStatus: "unavailable",
      },
    ]);
  },
);

test("a spawn pointing back to the root cannot establish an independent child session", async () => {
  const root = await home(roots);
  await session(
    root,
    lines([
      spawn,
      { ...started, item: { ...started.item, agent_thread_id: "thread-1" } },
      result,
    ]),
  );
  expect(
    (await codexNativeCallObservation(root, "thread-1")).data.childSessions,
  ).toEqual([{ threadId: "thread-1", status: "partial" }]);
});

test("a nested invocation with malformed arguments records an unaccepted reader attempt", async () => {
  const root = await home(roots);
  await session(root, lines([spawn, started, result]));
  await session(
    root,
    lines([{ ...spawn, call_id: "nested", arguments: "[]" }]),
    "thread-child",
  );
  const observed = await codexNativeCallObservation(root, "thread-1");
  expect(defined(observed.data.childSessions[0]).nestedSpawns).toEqual([
    {
      requestedOrdinal: 0,
      status: "unaccepted",
      sessionStatus: "unavailable",
      readerResultStatus: "unavailable",
    },
  ]);
});

test("invalid UTF-8 and oversized child bytes preserve partial evidence without a completion", async () => {
  const root = await home(roots);
  await session(root, lines([spawn, started, result]));
  const path = join(root, "sessions/2026/09/27/rollout-thread-child.jsonl");
  for (const bytes of [
    new Uint8Array([255, 254]),
    Buffer.alloc(8 * 1024 * 1024 + 1, 32),
  ]) {
    await writeFile(path, bytes);
    expect(
      (await codexNativeCallObservation(root, "thread-1")).data.childSessions,
    ).toEqual([{ threadId: "thread-child", status: "partial" }]);
  }
  await session(root, " ".repeat(8 * 1024 * 1024 + 1));
  expect(await codexNativeSessionLastOrdinal(root, "thread-1")).toBeNull();
  await writeFile(
    join(root, "sessions/2026/09/27/rollout-thread-1.jsonl"),
    new Uint8Array([255, 254]),
  );
  expect(
    (await codexNativeCallObservation(root, "thread-1")).completeness,
  ).toBe("partial");
  expect(await codexNativeSessionLastOrdinal(root, "thread-1")).toBeNull();
});
