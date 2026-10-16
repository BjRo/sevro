import { expect, test } from "bun:test";
import { claudeSkillActivationsObservation } from "../src/hosts/claude-skill-activations";

function event(type: string, block: unknown, parent: string | null = null) {
  return {
    type,
    session_id: "session-a",
    parent_tool_use_id: parent,
    message: { content: [block] },
  };
}
function call(id = "call-a", skill = "plugin:read") {
  return {
    type: "tool_use",
    id,
    name: "Skill",
    input: { skill, args: "private arguments" },
  };
}
function result(id = "call-a", failed = false) {
  return {
    type: "tool_result",
    tool_use_id: id,
    is_error: failed,
    content: "private result",
  };
}
function stream(events: unknown[]) {
  return [
    ...events,
    { type: "result", subtype: "success", is_error: false, result: "done" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
}

test("successful Skill results identify qualified activations without retaining private text", () => {
  const observation = claudeSkillActivationsObservation(
    stream([
      event("assistant", call()),
      event("user", result()),
      event("assistant", call("nested", "other:read"), "agent-a"),
      event("user", result("nested"), "agent-a"),
    ]),
    0,
  );
  expect(observation.completeness).toBe("complete");
  expect(observation.data.observedSkills).toEqual([
    "plugin:read",
    "other:read",
  ]);
  expect(observation.data.calls[1]?.parentToolUseId).toBe("agent-a");
  expect(JSON.stringify(observation)).not.toContain("private");
});

test("failed Skill tools and mentions do not become activations", () => {
  const observation = claudeSkillActivationsObservation(
    stream([
      event("assistant", { type: "text", text: "I used plugin:read" }),
      event("assistant", call()),
      event("user", result("call-a", true)),
    ]),
    0,
  );
  expect(observation.completeness).toBe("complete");
  expect(observation.data.observedSkills).toEqual([]);
  expect(observation.data.calls[0]?.status).toBe("failed");
});

test("unmatched attempts and results from another actor remain partial", () => {
  const observation = claudeSkillActivationsObservation(
    stream([
      event("assistant", call()),
      event("user", result(), "other-agent"),
    ]),
    0,
  );
  expect(observation.completeness).toBe("partial");
  expect(observation.data.observedSkills).toEqual([]);
});

test("repeated messages are idempotent and conflicting invocations remain partial", () => {
  const repeated = [
    event("assistant", call()),
    event("assistant", call()),
    event("user", result()),
  ];
  expect(
    claudeSkillActivationsObservation(stream(repeated), 0).data.calls,
  ).toHaveLength(1);
  const conflict = claudeSkillActivationsObservation(
    stream([...repeated, event("assistant", call("call-a", "other:read"))]),
    0,
  );
  expect(conflict.completeness).toBe("partial");
});

test("missing identity and malformed result status cannot establish complete activation evidence", () => {
  const invalid = { ...event("assistant", call()), session_id: null };
  expect(
    claudeSkillActivationsObservation(stream([invalid]), 0).completeness,
  ).toBe("partial");
  const observation = claudeSkillActivationsObservation(
    stream([
      event("assistant", call()),
      event("user", { ...result(), is_error: "false" }),
    ]),
    0,
  );
  expect(observation.completeness).toBe("partial");
  expect(observation.data.observedSkills).toEqual([]);
});

test("malformed streams and failed execution remain partial", () => {
  expect(
    claudeSkillActivationsObservation(stream([]) + "\n{", 0).completeness,
  ).toBe("partial");
  expect(claudeSkillActivationsObservation(stream([]), 1).completeness).toBe(
    "partial",
  );
});
