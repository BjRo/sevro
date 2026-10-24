import { afterEach, expect, test } from "bun:test";
import { codexNativeCallObservation } from "../../../src/hosts/codex-native-calls";
import { expectUnknown } from "../../fixtures/assertions";
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

test("native tool calls retain order and feedback target without private input", async () => {
  const root = await home(roots);
  await session(
    root,
    lines([
      spawn,
      started,
      result,
      {
        type: "function_call",
        namespace: "collaboration",
        name: "send_message",
        arguments: JSON.stringify({
          target: "/root/reviewer",
          message: "private feedback",
        }),
      },
      { type: "custom_tool_call", name: "exec", input: "private code" },
      { type: "function_call", namespace: "collaboration", name: "wait_agent" },
    ]),
  );
  const observed = await codexNativeCallObservation(root, "thread-1");
  expectUnknown(observed.data.toolCalls).toEqual([
    { ordinal: 0, namespace: "collaboration", name: "spawn_agent" },
    {
      ordinal: 3,
      namespace: "collaboration",
      name: "send_message",
      target: "/root/reviewer",
    },
    { ordinal: 4, namespace: "other", name: "exec" },
    { ordinal: 5, namespace: "collaboration", name: "wait_agent" },
  ]);
  expect(JSON.stringify(observed)).not.toContain("private feedback");
  expect(JSON.stringify(observed)).not.toContain("private code");
});

// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("native feedback retains target and unique response without message text", async () => {
  const root = await home(roots);
  const feedback = {
    type: "function_call",
    namespace: "collaboration",
    name: "followup_task",
    call_id: "feedback-1",
    arguments: JSON.stringify({ target: "owner", message: "private feedback" }),
  };
  const response = {
    type: "function_call_output",
    call_id: "feedback-1",
    output: "private tool result",
  };
  await session(root, lines([feedback, response]));
  const observed = await codexNativeCallObservation(root, "thread-1");
  expectUnknown(observed.data.feedbackCalls).toEqual([
    {
      ordinal: 0,
      tool: "followup_task",
      target: "owner",
      responseObserved: true,
      messageRepresentation: "plaintext",
      messageMatchesFollowUpPrompt: null,
    },
  ]);
  const context = {
    followUpPrompt: "private feedback",
  };
  expect(
    (await codexNativeCallObservation(root, "thread-1", context)).data
      .feedbackCalls,
  ).toMatchObject([{ messageMatchesFollowUpPrompt: true }]);
  expect(
    (
      await codexNativeCallObservation(root, "thread-1", {
        ...context,
        followUpPrompt: "different feedback",
      })
    ).data.feedbackCalls,
  ).toMatchObject([{ messageMatchesFollowUpPrompt: false }]);
  expect(JSON.stringify(observed)).not.toContain("private feedback");
  expect(JSON.stringify(observed)).not.toContain("private tool result");
  await session(root, lines([feedback]));
  expect(
    (await codexNativeCallObservation(root, "thread-1")).data.feedbackCalls,
  ).toMatchObject([{ responseObserved: false }]);
  await session(root, lines([feedback, response, response]));
  expect(
    (await codexNativeCallObservation(root, "thread-1")).data.feedbackCalls,
  ).toMatchObject([{ responseObserved: false }]);
  await session(root, lines([{ ...feedback, arguments: "{broken" }, response]));
  expect(
    (await codexNativeCallObservation(root, "thread-1")).data.feedbackCalls,
  ).toMatchObject([
    {
      target: null,
      messageRepresentation: "unavailable",
      messageMatchesFollowUpPrompt: null,
    },
  ]);
  await session(
    root,
    lines([
      {
        ...feedback,
        arguments: JSON.stringify({
          target: "owner",
          message: "gAAAAABencrypted-feedback-token",
        }),
      },
      response,
    ]),
  );
  expect(
    (await codexNativeCallObservation(root, "thread-1", context)).data
      .feedbackCalls,
  ).toMatchObject([
    {
      messageRepresentation: "encrypted",
      messageMatchesFollowUpPrompt: null,
    },
  ]);
});

test("native feedback requires string labels in retained evidence", async () => {
  const root = await home(roots);
  const feedback = {
    type: "function_call",
    namespace: "collaboration",
    name: "followup_task",
    arguments: JSON.stringify({ target: "owner", message: "private feedback" }),
  };
  await session(
    root,
    lines([
      { ...feedback, name: ["followup_task"], call_id: "array-label" },
      { ...feedback, call_id: "string-label" },
    ]),
  );
  const observed = await codexNativeCallObservation(root, "thread-1");
  expect(observed.completeness).toBe("complete");
  expect(observed.data.toolCalls.map((call) => call.name)).toEqual([
    "other",
    "followup_task",
  ]);
  expect(observed.data.feedbackCalls.map((call) => call.tool)).toEqual([
    "followup_task",
  ]);
  expect(JSON.stringify(observed)).not.toContain("private feedback");
});
