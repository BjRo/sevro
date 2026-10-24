import { expect, test } from "bun:test";
import { claudeSkillActivationsObservation } from "../../../src/hosts/claude-skill-activations";

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

test("invalid Skill inputs and primitive events cannot establish complete evidence", () => {
  for (const invalid of [null, { skill: "invalid name" }, { skill: 42 }]) {
    const observation = claudeSkillActivationsObservation(
      stream([event("assistant", { ...call(), input: invalid })]),
      0,
    );
    expect(observation.completeness).toBe("partial");
    expect(observation.data.calls).toEqual([]);
  }
  expect(
    claudeSkillActivationsObservation(stream([null]), 0).completeness,
  ).toBe("partial");
});

test("malformed blocks retain successful evidence while making collection partial", () => {
  const observation = claudeSkillActivationsObservation(
    stream([
      event("assistant", call()),
      event("assistant", null),
      event("user", { type: "text", text: "unrelated" }),
      event("user", { ...result(), tool_use_id: null }),
      event("user", { ...result(), is_error: undefined }),
    ]),
    0,
  );
  expect(observation.completeness).toBe("partial");
  expect(observation.data.observedSkills).toEqual(["plugin:read"]);
  expect(
    claudeSkillActivationsObservation(
      stream([
        event("assistant", call()),
        event("user", { ...result(), is_error: undefined }),
      ]),
      0,
    ).completeness,
  ).toBe("complete");
});

test("conflicting result statuses make collection partial and retain the latest status", () => {
  const observation = claudeSkillActivationsObservation(
    stream([
      event("assistant", call()),
      event("user", result()),
      event("user", result("call-a", true)),
    ]),
    0,
  );
  expect(observation.completeness).toBe("partial");
  expect(observation.data.calls[0]?.status).toBe("failed");
  expect(observation.data.observedSkills).toEqual([]);
});

test("Skill call overflow preserves the bounded prefix and reports partial evidence", () => {
  const events = [];
  for (let index = 0; index < 129; index++) {
    events.push(event("assistant", call(`call-${index}`, `skill-${index}`)));
    events.push(event("user", result(`call-${index}`)));
  }
  const observation = claudeSkillActivationsObservation(stream(events), 0);
  expect(observation.completeness).toBe("partial");
  expect(observation.data.truncated).toBe(true);
  expect(observation.data.calls).toHaveLength(128);
  expect(observation.data.observedSkills).toHaveLength(128);
  expect(observation.data.observedSkills).toContain("skill-127");
  expect(observation.data.observedSkills).not.toContain("skill-128");
});
