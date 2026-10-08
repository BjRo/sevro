import { expectUnknown } from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { claudeNestedSkillsObservation } from "../src/hosts/claude-nested-skills";
const sessionId = "session-1";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const entry = (agentId: string | null, type: string, content: object[]) => ({
  sessionId,
  ...(agentId ? { agentId } : {}),
  type,
  message: { content },
});
const use = (name: string, id: string, input: object) => ({
  type: "tool_use",
  name,
  id,
  input,
});
const result = (toolUseId: string, agentId: string) => ({
  ...entry(null, "user", [{ type: "tool_result", tool_use_id: toolUseId }]),
  toolUseResult: { status: "completed", agentId },
});
const jsonl = (rows: object[]) =>
  rows.map((row) => JSON.stringify(row)).join("\n");
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("Claude nested Skill receipts follow only completed bound Agent sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-claude-nested-"));
  try {
    const workspace = join(root, "workspace");
    const config = join(root, "config");
    await Promise.all([workspace, config].map((path) => mkdir(path)));
    const canonical = await realpath(workspace);
    const project = join(
      config,
      "projects",
      canonical.replace(/[^A-Za-z0-9]/g, "-"),
    );
    const children = join(project, sessionId, "subagents");
    await mkdir(children, { recursive: true });
    await writeFile(
      join(project, `${sessionId}.jsonl`),
      jsonl([
        entry(null, "assistant", [use("Agent", "owner-tool", {})]),
        result("owner-tool", "owner-agent"),
      ]),
    );
    await writeFile(
      join(children, "agent-owner-agent.jsonl"),
      jsonl([
        entry("owner-agent", "assistant", [
          use("Skill", "verify-tool", {
            skill: "darrow-verification:verify-change",
            args: "private",
          }),
        ]),
        entry("owner-agent", "assistant", [use("Agent", "review-tool", {})]),
        {
          ...entry("owner-agent", "user", [
            { type: "tool_result", tool_use_id: "review-tool" },
          ]),
          toolUseResult: { status: "completed", agentId: "review-agent" },
        },
      ]),
    );
    await writeFile(
      join(children, "agent-review-agent.jsonl"),
      jsonl([
        entry("review-agent", "assistant", [
          use("Skill", "independent-tool", {
            skill: "independent-code-review",
            args: "private",
          }),
        ]),
      ]),
    );
    const stream = JSON.stringify({ type: "result", session_id: sessionId });
    const observed = await claudeNestedSkillsObservation(
      stream,
      config,
      workspace,
    );
    expectUnknown(observed).toEqual({
      id: "sevro.claude.nested-skills",
      completeness: "complete",
      data: {
        method: "native_session_graph",
        calls: [
          {
            ancestorToolUseId: "owner-tool",
            skill: "verify-change",
            invocation: "darrow-verification:verify-change",
          },
          {
            ancestorToolUseId: "owner-tool",
            skill: "independent-code-review",
            invocation: "independent-code-review",
          },
        ],
      },
    });
    expect(JSON.stringify(observed)).not.toContain("private");
    await writeFile(
      join(children, "agent-review-agent.jsonl"),
      jsonl([entry("foreign", "assistant", [])]),
    );
    expect(
      (await claudeNestedSkillsObservation(stream, config, workspace))
        .completeness,
    ).toBe("partial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function sidecarFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-claude-sidecar-")),
  );
  roots.push(root);
  const workspace = join(root, "workspace"),
    config = join(root, "config");
  await Promise.all([workspace, config].map((path) => mkdir(path)));
  const project = join(
    config,
    "projects",
    workspace.replace(/[^A-Za-z0-9]/g, "-"),
  );
  const children = join(project, sessionId, "subagents");
  await mkdir(children, { recursive: true });
  const parentPath = join(project, `${sessionId}.jsonl`);
  await writeFile(
    parentPath,
    jsonl([
      entry(null, "assistant", [use("Agent", "owner-tool", {})]),
      entry(null, "user", [{ type: "tool_result", tool_use_id: "owner-tool" }]),
    ]),
  );
  const childPath = join(children, "agent-owner-agent.jsonl");
  await writeFile(
    childPath,
    jsonl([
      entry("owner-agent", "assistant", [
        use("Skill", "read", { skill: "example:read" }),
      ]),
    ]),
  );
  await writeFile(
    join(children, "agent-owner-agent.meta.json"),
    JSON.stringify({ toolUseId: "owner-tool", parentAgentId: null }),
  );
  return {
    workspace,
    config,
    children,
    parentPath,
    childPath,
    stream: JSON.stringify({ type: "result", session_id: sessionId }),
  };
}

test("Claude sidecar lookup accepts the declared agent bound and refuses overflow", async () => {
  const fixture = await sidecarFixture();
  await Promise.all(
    Array.from({ length: 63 }, (_, index) =>
      writeFile(join(fixture.children, `agent-extra-${index}.meta.json`), "{}"),
    ),
  );
  expect(
    await claudeNestedSkillsObservation(
      fixture.stream,
      fixture.config,
      fixture.workspace,
    ),
  ).toMatchObject({
    completeness: "complete",
    data: { calls: [{ ancestorToolUseId: "owner-tool", skill: "read" }] },
  });
  await writeFile(join(fixture.children, "agent-overflow.meta.json"), "{}");
  expect(
    await claudeNestedSkillsObservation(
      fixture.stream,
      fixture.config,
      fixture.workspace,
    ),
  ).toMatchObject({ completeness: "partial", data: { calls: [] } });
});

test.each(["directory", "oversized"])(
  "Claude refuses a %s persisted parent transcript",
  async (mode) => {
    const fixture = await sidecarFixture();
    if (mode === "directory") {
      await rm(fixture.parentPath);
      await mkdir(fixture.parentPath);
    } else await writeFile(fixture.parentPath, " ".repeat(8 * 1024 * 1024 + 1));
    expect(
      await claudeNestedSkillsObservation(
        fixture.stream,
        fixture.config,
        fixture.workspace,
      ),
    ).toMatchObject({ completeness: "partial", data: { calls: [] } });
  },
);

test("Claude nested Skill input must be an object even in a bound child session", async () => {
  const fixture = await sidecarFixture();
  await writeFile(
    fixture.childPath,
    jsonl([
      {
        ...entry("owner-agent", "assistant", []),
        message: {
          content: [
            { type: "tool_use", name: "Skill", id: "read", input: null },
          ],
        },
      },
    ]),
  );
  expect(
    await claudeNestedSkillsObservation(
      fixture.stream,
      fixture.config,
      fixture.workspace,
    ),
  ).toMatchObject({ completeness: "partial", data: { calls: [] } });
});

test("Claude message-free user metadata does not invent a nested Skill receipt", async () => {
  const fixture = await sidecarFixture();
  await writeFile(fixture.parentPath, jsonl([{ sessionId, type: "user" }]));
  expect(
    await claudeNestedSkillsObservation(
      fixture.stream,
      fixture.config,
      fixture.workspace,
    ),
  ).toMatchObject({ completeness: "complete", data: { calls: [] } });
});
