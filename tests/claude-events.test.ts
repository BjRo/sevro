import { expect, test } from "bun:test";
import {
  ClaudeEventError,
  summarizeClaudeEvents,
} from "../src/hosts/claude-events";

function result(
  text: string,
  usage: unknown,
  cost?: number,
  subtype = "success",
) {
  return JSON.stringify({
    type: "result",
    subtype,
    is_error: subtype !== "success",
    result: text,
    usage,
    ...(cost === undefined ? {} : { total_cost_usd: cost }),
  });
}

test("Claude stream accounting sums cache buckets and keeps the final result", () => {
  const stream = [
    result(
      "Interim public result",
      {
        input_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 5,
        output_tokens: 7,
      },
      0.1,
    ),
    result(
      "Final public result",
      {
        input_tokens: 11,
        cache_creation_input_tokens: 13,
        cache_read_input_tokens: 17,
        output_tokens: 19,
      },
      0.2,
    ),
  ].join("\n");
  const summary = summarizeClaudeEvents(stream, 0);
  expect(summary).toMatchObject({
    complete: true,
    finalMessage: "Final public result",
    inputTokens: 51,
    outputTokens: 26,
    usageComplete: true,
  });
  expect(summary.costUsd).toBeCloseTo(0.3);
  expect(JSON.stringify(summary)).not.toContain("Interim public result");
});

test("a failed result or malformed event cannot complete a Claude turn", () => {
  const stream = [
    result("Interim", { input_tokens: 2, output_tokens: 3 }, 0.1),
    result(
      "Failed final",
      { input_tokens: 5, output_tokens: 7 },
      undefined,
      "error",
    ),
  ].join("\n");
  expect(summarizeClaudeEvents(stream, 1)).toEqual({
    complete: false,
    finalMessage: "Failed final",
    inputTokens: 7,
    outputTokens: 10,
    costUsd: null,
    usageComplete: true,
  });
  expect(summarizeClaudeEvents(stream + "\nnull", 1)).toMatchObject({
    complete: false,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    usageComplete: false,
  });
  expect(
    summarizeClaudeEvents(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Skill", input: {} }],
        },
      }) +
        "\n" +
        result("done", { input_tokens: 1, output_tokens: 1 }),
      0,
    ).complete,
  ).toBe(false);
});

test("missing usage stays unknown while the final answer remains available", () => {
  for (const badUsage of [
    undefined,
    { input_tokens: "wrong", output_tokens: 2 },
  ]) {
    expect(
      summarizeClaudeEvents(result("Public result", badUsage, 0.1), 0),
    ).toEqual({
      complete: true,
      finalMessage: "Public result",
      inputTokens: null,
      outputTokens: null,
      costUsd: 0.1,
      usageComplete: false,
    });
  }
  expect(summarizeClaudeEvents("", 0)).toEqual({
    complete: false,
    finalMessage: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    usageComplete: false,
  });
});

test("Claude event streams have a hard byte limit", () => {
  expect(() =>
    summarizeClaudeEvents("x".repeat(8 * 1024 * 1024 + 1), 0),
  ).toThrow(ClaudeEventError);
});
