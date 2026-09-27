import { expect, test } from "bun:test";
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
          prompt: "- phase: adaptive-delivery-owner\nPrivate owner task and answer",
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
  expect(observed).toEqual({
    id: "sevro.claude.tool-calls",
    completeness: "complete",
    data: {
      method: "stream_tool_calls",
      calls: [
        {
          ordinal: 1,
          actor: "parent",
          name: "Skill",
          skill: "assess-implementation-readiness",
          invocation: "darrow-readiness-gate:assess-implementation-readiness",
        },
        {
          ordinal: 2,
          actor: "parent",
          name: "Agent",
          toolUseId: "owner-call",
          subagentType:
            "darrow-adaptive-delivery:adaptive-delivery-sonnet-5-low",
          runInBackground: false,
          model: "claude-sonnet-5",
          promptSha256: createHash("sha256")
            .update("- phase: adaptive-delivery-owner\nPrivate owner task and answer")
            .digest("hex"),
          promptFirstLineSha256: createHash("sha256")
            .update("- phase: adaptive-delivery-owner")
            .digest("hex"),
        },
        {
          ordinal: 3,
          actor: "nested",
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
  expect(observed.data.calls[0]).toMatchObject({ promptSha256: null });
  expect(observed.data.calls[0]).toMatchObject({
    promptFirstLineSha256: null,
  });
});

test("a complete turn with no Skill or Agent call proves absence", () => {
  expect(claudeToolCallsObservation(result, 0)).toEqual({
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
    input: { skill: "skill-" + index },
  }));
  const observed = claudeToolCallsObservation(
    assistant(calls) + "\n" + result,
    0,
  );
  expect(observed.completeness).toBe("partial");
  expect(observed.data.truncated).toBe(true);
  expect(observed.data.calls).toHaveLength(128);
});
