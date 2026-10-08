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
    finalMessage: "done",
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

test("the last completed agent message is the final response", () => {
  const events = [
    start,
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "first" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "last" },
    }),
    completed,
  ].join("\n");
  expect(summarizeCodexEvents(events, 0).finalMessage).toBe("last");
  expect(
    summarizeCodexEvents(
      `${start}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message" } })}\n${completed}`,
      0,
    ).finalMessage,
  ).toBeNull();
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

test.each([
  { input_tokens: -1, output_tokens: 4 },
  { input_tokens: 1.5, output_tokens: 4 },
  { input_tokens: "12", output_tokens: 4 },
  { input_tokens: 12, output_tokens: -1 },
  { input_tokens: 12, output_tokens: "4" },
])("malformed final cumulative usage stays unknown: %j", (usage) => {
  const finish = JSON.stringify({ type: "turn.completed", usage });
  expect(summarizeCodexEvents(`${start}\n${finish}`, 0)).toMatchObject({
    complete: true,
    inputTokens: null,
    outputTokens: null,
    usageComplete: false,
  });
});

test.each([{ value: null }, { value: [] }, { value: { type: 42 } }])(
  "nonobject or untyped serialized Codex event cannot complete: %j",
  ({ value }) => {
    expect(() =>
      summarizeCodexEvents(
        `${start}\n${JSON.stringify(value)}\n${completed}`,
        0,
      ),
    ).toThrow("Codex event stream contains an invalid event");
  },
);

test("a stream without any root start cannot claim a participant thread", () => {
  expect(() => summarizeCodexEvents("\n", 0)).toThrow(
    "Codex event stream has no thread start",
  );
  expect(() =>
    summarizeCodexEvents(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      }),
      0,
    ),
  ).toThrow("Codex event stream has no thread start");
});
