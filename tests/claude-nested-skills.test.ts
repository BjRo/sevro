import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { claudeNestedSkillsObservation } from "../src/hosts/claude-nested-skills";

const sessionId = "session-1";
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
    expect(observed).toEqual({
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
