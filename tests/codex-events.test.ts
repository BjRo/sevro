import { expect, test } from "bun:test";
import {
  CodexEventError,
  summarizeCodexEvents,
} from "../src/hosts/codex-events";

const start = JSON.stringify({ type: "thread.started", thread_id: "thread-1" });
const completed = JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 12, output_tokens: 4 },
});

test("a complete Codex turn reports its identity and final cumulative usage", () => {
  const events = [
    start,
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "done" },
    }),
    completed,
  ].join("\n");
  expect(summarizeCodexEvents(events, 0)).toEqual({
    threadId: "thread-1",
    complete: true,
    inputTokens: 12,
    outputTokens: 4,
    usageComplete: true,
  });
});

test("exit failure, turn failure, and missing usage cannot become complete evidence", () => {
  expect(summarizeCodexEvents(`${start}\n${completed}`, 1).complete).toBe(
    false,
  );
  expect(
    summarizeCodexEvents(
      `${start}\n${completed}\n${JSON.stringify({ type: "turn.failed" })}`,
      0,
    ).complete,
  ).toBe(false);
  expect(
    summarizeCodexEvents(
      `${start}\n${JSON.stringify({ type: "turn.completed" })}`,
      0,
    ),
  ).toMatchObject({
    complete: true,
    inputTokens: null,
    outputTokens: null,
    usageComplete: false,
  });
});

test("malformed, ambiguous, and oversized event streams fail closed", () => {
  expect(() => summarizeCodexEvents(`${start}\n{`, 0)).toThrow(CodexEventError);
  expect(() =>
    summarizeCodexEvents(`${start}\n${start}\n${completed}`, 0),
  ).toThrow(/thread start/);
  expect(() => summarizeCodexEvents(completed, 0)).toThrow(/turn completion/);
  expect(summarizeCodexEvents(start, 0)).toMatchObject({ complete: false });
  expect(() =>
    summarizeCodexEvents("x".repeat(8 * 1024 * 1024 + 1), 0),
  ).toThrow(/exceeds/);
});
