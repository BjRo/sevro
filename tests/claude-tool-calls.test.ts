import { expectUnknown } from "./fixtures/assertions";
import { defined } from "./fixtures/assertions";
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { claudeToolCallsObservation } from "../src/hosts/claude-tool-calls";
const result = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Complete",
  usage: { input_tokens: 1, output_tokens: 2 },
});
function assistant(content: object[], parentToolUseId?: string): string {
  return JSON.stringify({
    type: "assistant",
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    message: { content },
  });
}
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("Claude retains ordered Skill and Agent facts without their prompts", () => {
  const stream = [
    assistant([
      {
        type: "tool_use",
        name: "Skill",
        id: "skill-call",
        input: {
          skill: "darrow-readiness-gate:assess-implementation-readiness",
        },
      },
      {
        type: "tool_use",
        name: "Agent",
        id: "owner-call",
        input: {
          subagent_type:
            "darrow-adaptive-delivery:adaptive-delivery-sonnet-5-low",
          run_in_background: false,
          model: "claude-sonnet-5",
          prompt:
            "- phase: adaptive-delivery-owner\nPrivate owner task and answer",
        },
      },
    ]),
    assistant(
      [
        {
          type: "tool_use",
          name: "Skill",
          input: { skill: "independent-code-review" },
        },
      ],
      "owner-call",
    ),
    result,
  ].join("\n");
  const observed = claudeToolCallsObservation(stream, 0);
  expectUnknown(observed).toEqual({
    id: "sevro.claude.tool-calls",
    completeness: "complete",
    data: {
      method: "stream_tool_calls",
      calls: [
        {
          ordinal: 1,
          actor: "parent",
          parentToolUseId: null,
          name: "Skill",
          skill: "assess-implementation-readiness",
          invocation: "darrow-readiness-gate:assess-implementation-readiness",
        },
        {
          ordinal: 2,
          actor: "parent",
          parentToolUseId: null,
          name: "Agent",
          toolUseId: "owner-call",
          subagentType:
            "darrow-adaptive-delivery:adaptive-delivery-sonnet-5-low",
          runInBackground: false,
          model: "claude-sonnet-5",
          promptSha256: createHash("sha256")
            .update(
              "- phase: adaptive-delivery-owner\nPrivate owner task and answer",
            )
            .digest("hex"),
          promptFirstLineSha256: createHash("sha256")
            .update("- phase: adaptive-delivery-owner")
            .digest("hex"),
        },
        {
          ordinal: 3,
          actor: "nested",
          parentToolUseId: "owner-call",
          name: "Skill",
          skill: "independent-code-review",
          invocation: "independent-code-review",
        },
      ],
      truncated: false,
    },
  });
  expect(JSON.stringify(observed)).not.toContain("Private owner task");
});
test("Claude Agent prompt evidence stays a digest and requires a bounded string", () => {
  const missingPrompt = assistant([
    {
      type: "tool_use",
      name: "Agent",
      id: "owner-call",
      input: { subagent_type: "worker", run_in_background: false },
    },
  ]);
  const observed = claudeToolCallsObservation(missingPrompt + "\n" + result, 0);
  expect(observed.completeness).toBe("partial");
  expect(defined(observed.data.calls[0])).toMatchObject({
    promptSha256: null,
  });
  expect(defined(observed.data.calls[0])).toMatchObject({
    promptFirstLineSha256: null,
  });
});
test("Claude Task tool is normalized to an Agent receipt", () => {
  const stream = [
    assistant([
      {
        type: "tool_use",
        name: "Task",
        id: "owner-task",
        input: {
          subagent_type: "reviewer",
          run_in_background: false,
          prompt: "- phase: adaptive-delivery-owner\nPrivate contract",
        },
      },
    ]),
    result,
  ].join("\n");
  const observed = claudeToolCallsObservation(stream, 0);
  expect(observed.completeness).toBe("complete");
  expect(defined(observed.data.calls[0])).toMatchObject({
    actor: "parent",
    parentToolUseId: null,
    name: "Agent",
    toolUseId: "owner-task",
    subagentType: "reviewer",
    runInBackground: false,
  });
});
test("a complete turn with no Skill or Agent call proves absence", () => {
  expectUnknown(claudeToolCallsObservation(result, 0)).toEqual({
    id: "sevro.claude.tool-calls",
    completeness: "complete",
    data: { method: "stream_tool_calls", calls: [], truncated: false },
  });
  const topLevel = JSON.stringify({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [] },
  });
  expect(
    claudeToolCallsObservation(topLevel + "\n" + result, 0).completeness,
  ).toBe("complete");
});
test("invalid call metadata and incomplete turns cannot prove absence", () => {
  const malformed = [
    assistant([
      {
        type: "tool_use",
        name: "Skill",
        input: { skill: "../unbounded" },
      },
    ]),
    result,
  ].join("\n");
  expect(claudeToolCallsObservation(malformed, 0).completeness).toBe("partial");
  expect(claudeToolCallsObservation(result, 1).completeness).toBe("partial");
  expect(
    claudeToolCallsObservation("not-json\n" + result, 0).completeness,
  ).toBe("partial");
});
test("excessive call metadata is truncated and cannot prove absence", () => {
  const calls = Array.from({ length: 129 }, (_, index) => ({
    type: "tool_use",
    name: "Skill",
    input: { skill: `skill-${index}` },
  }));
  const observed = claudeToolCallsObservation(
    assistant(calls) + "\n" + result,
    0,
  );
  expect(observed.completeness).toBe("partial");
  expect(observed.data.truncated).toBe(true);
  expect(observed.data.calls).toHaveLength(128);
});

test.each([
  { type: "assistant", message: null },
  { type: "assistant", message: { content: "private" } },
  { type: "assistant", parent_tool_use_id: 42, message: { content: [] } },
  { type: "assistant", parent_tool_use_id: "", message: { content: [] } },
])(
  "malformed assistant or actor context cannot prove Claude tool absence: %j",
  (event) => {
    expect(
      claudeToolCallsObservation(JSON.stringify(event) + "\n" + result, 0),
    ).toMatchObject({ completeness: "partial", data: { calls: [] } });
  },
);

test("Claude tool ordinals include unrelated tool calls without retaining their input", () => {
  const stream =
    assistant([
      { type: "text", text: "private text" },
      {
        type: "tool_use",
        name: "Bash",
        id: "shell",
        input: { command: "private command" },
      },
      { type: "tool_use", name: "Skill", input: { skill: "example:read" } },
    ]) +
    "\n" +
    result;
  const observed = claudeToolCallsObservation(stream, 0);
  expect(observed.completeness).toBe("complete");
  expect(observed.data.calls).toMatchObject([
    { ordinal: 2, name: "Skill", skill: "read" },
  ]);
  expect(observed.data.calls).toHaveLength(1);
  expect(JSON.stringify(observed)).not.toContain("private");
});

test.each([{ input: [] }, { input: null }])(
  "Claude nonobject Agent input cannot establish a dispatch receipt: %s",
  ({ input }) => {
    const observed = claudeToolCallsObservation(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Agent", id: "agent", input }],
        },
      }) +
        "\n" +
        result,
      0,
    );
    expect(observed.completeness).toBe("partial");
    expect(defined(observed.data.calls[0])).toMatchObject({
      toolUseId: "agent",
      subagentType: null,
      runInBackground: null,
      promptSha256: null,
    });
  },
);

test("Claude accepts the serialized camel-case agent route while bounding UTF-8 prompts", () => {
  const call = {
    type: "tool_use",
    name: "Agent",
    id: "agent",
    input: {
      subagentType: "reviewer",
      run_in_background: false,
      prompt: "Private request",
    },
  };
  const observed = claudeToolCallsObservation(
    assistant([call]) + "\n" + result,
    0,
  );
  expect(observed.completeness).toBe("complete");
  expect(defined(observed.data.calls[0])).toMatchObject({
    subagentType: "reviewer",
    runInBackground: false,
  });
  const excessive = {
    ...call,
    input: { ...call.input, prompt: "🙂".repeat(262145) },
  };
  const partial = claudeToolCallsObservation(
    assistant([excessive]) + "\n" + result,
    0,
  );
  expect(partial.completeness).toBe("partial");
  expect(defined(partial.data.calls[0])).toMatchObject({
    promptSha256: null,
    promptFirstLineSha256: null,
  });
  expect(JSON.stringify(partial)).not.toContain("🙂");
});
