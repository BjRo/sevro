import { expect, test } from "bun:test";
import {
  claudeNativeControls,
  codexNativeControls,
} from "../src/hosts/native-controls";

const result = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ready",
});
const stream = (content: unknown[]) =>
  JSON.stringify({ type: "assistant", message: { content } }) + "\n" + result;

test("Claude retains all native call labels without arguments or results", () => {
  const observed = claudeNativeControls(
    stream([
      {
        type: "tool_use",
        id: "read-1",
        name: "Read",
        input: { file_path: "private source" },
      },
      {
        type: "tool_use",
        id: "goal-1",
        name: "create_goal",
        input: { objective: "private task" },
      },
      {
        type: "tool_use",
        id: "agent-1",
        name: "Agent",
        input: { prompt: "private contract" },
      },
      { type: "text", text: "private result Agent create_goal" },
    ]),
    0,
  );
  expect(observed).toEqual({
    id: "sevro.host.native-controls",
    completeness: "complete",
    data: {
      method: "native_control_calls",
      calls: [
        { ordinal: 0, namespace: "claude", name: "Read" },
        { ordinal: 1, namespace: "claude", name: "create_goal" },
        { ordinal: 2, namespace: "claude", name: "Agent" },
      ],
      acceptedAgentCount: null,
      submittedExecCalls: null,
      truncated: false,
    },
  });
  expect(JSON.stringify(observed)).not.toContain("private");
  expect(claudeNativeControls(result, 0).data.calls).toEqual([]);
  expect(claudeNativeControls(result, 0).completeness).toBe("complete");
});

test("Claude malformed and truncated native control evidence remains partial", () => {
  const tool = { type: "tool_use", id: "same-id", name: "Agent" };
  for (const candidate of [
    stream([tool, tool]),
    stream([{ ...tool, name: "bad name" }]),
    stream([{ type: "tool_use", name: "Agent" }]),
    "not-json\n" + result,
  ])
    expect(claudeNativeControls(candidate, 0).completeness).toBe("partial");
  expect(claudeNativeControls(result, 1).completeness).toBe("partial");
  const excessive = Array.from({ length: 129 }, (_, index) => ({
    ...tool,
    id: `call-${index}`,
    name: "Read",
  }));
  const truncated = claudeNativeControls(stream(excessive), 0);
  expect(truncated.completeness).toBe("partial");
  expect(truncated.data.truncated).toBeTrue();
  expect(truncated.data.calls).toHaveLength(128);
});

test("Codex projects bound labels and explicit acceptance and submitted-code counts", () => {
  const observation = {
    id: "sevro.codex.native-calls" as const,
    completeness: "complete" as const,
    data: {
      method: "native_session" as const,
      calls: [],
      toolCalls: [
        {
          ordinal: 4,
          namespace: "collaboration" as const,
          name: "spawn_agent",
          target: "private-target",
        },
      ],
      submittedExecCalls: 2,
      acceptedSpawns: [],
      feedbackCalls: [],
      childSessions: [],
      childrenTruncated: false,
    },
  };
  const projected = codexNativeControls(observation);
  expect(projected).toEqual({
    id: "sevro.host.native-controls",
    completeness: "complete",
    data: {
      method: "native_control_calls",
      calls: [{ ordinal: 4, namespace: "collaboration", name: "spawn_agent" }],
      acceptedAgentCount: 0,
      submittedExecCalls: 2,
      truncated: false,
    },
  });
  expect(JSON.stringify(projected)).not.toContain("private-target");
  expect(
    codexNativeControls({ ...observation, completeness: "unavailable" })
      .completeness,
  ).toBe("unavailable");
  expect(
    codexNativeControls({ ...observation, completeness: "partial" })
      .completeness,
  ).toBe("partial");
});
