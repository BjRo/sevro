import { afterEach, expect, test } from "bun:test";
import {
  codexNativeCallObservation,
  codexNativeSessionLastOrdinal,
} from "../../../src/hosts/codex-native-calls";
import { expectUnknown } from "../../fixtures/assertions";
import { home, session } from "../../fixtures/codex-native-calls";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("native boundary uses only a complete, unique session", async () => {
  const root = await home(roots);
  expect(await codexNativeSessionLastOrdinal(root, "thread-1")).toBeNull();
  await session(
    root,
    [0, 3]
      .map((ordinal) => JSON.stringify({ ordinal, payload: {} }))
      .join("\n") + "\n",
  );
  expect(await codexNativeSessionLastOrdinal(root, "thread-1")).toBe(3);
  await session(root, '{"ordinal":0,"payload":{}}\n{broken\n');
  expect(await codexNativeSessionLastOrdinal(root, "thread-1")).toBeNull();
  await session(root, '{"ordinal":0,"payload":{}}\n', "other-thread-1");
  expect(await codexNativeSessionLastOrdinal(root, "thread-1")).toBeNull();
});

// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("native goal and agent calls retain names and order without private arguments", async () => {
  const root = await home(roots);
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
  expectUnknown(observed).toEqual({
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
      toolCalls: [
        { ordinal: 0, namespace: "functions", name: "create_goal" },
        { ordinal: 1, namespace: "other", name: "exec" },
        { ordinal: 2, namespace: "collaboration", name: "spawn_agent" },
        { ordinal: 4, namespace: "other", name: "get_goal" },
        { ordinal: 5, namespace: "other", name: "update_goal" },
      ],
      submittedExecCalls: 1,
      execCalls: [
        {
          ordinal: 1,
          completeness: "partial",
          calls: [],
          inspectionReason: "malformed_source",
          execution: "incomplete",
          output: "unavailable",
        },
      ],
      acceptedSpawns: [],
      feedbackCalls: [],
      childSessions: [],
      childrenTruncated: false,
    },
  });
  expect(JSON.stringify(observed)).not.toContain("private");
});
