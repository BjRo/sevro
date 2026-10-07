import { expectUnknown } from "./fixtures/assertions";
import { test, expect } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeRepositoryInvocationObservation,
  matchClaudeRepositoryInvocation,
  verifyClaudeRepositoryInvocation,
} from "../src/hosts/claude-repository-invocation";
import { claudeToolCallsObservation } from "../src/hosts/claude-tool-calls";
const invocation = {
  skillName: "probe",
  skillDir: "/fixture/.claude/skills/probe",
  skillText:
    "---\nname: probe\ndescription: Probe\n---\n# Probe\nReturn ready.\n",
  prompt: "/probe Return ready.",
};
const command = {
  type: "user",
  sessionId: "session-one",
  message: {
    content:
      "<command-message>probe</command-message>\n<command-name>/probe</command-name>\n<command-args>Return ready.</command-args>",
  },
};
const body = {
  type: "user",
  sessionId: "session-one",
  isMeta: true,
  message: {
    content:
      "Base directory for this skill: /fixture/.claude/skills/probe\n\n# Probe\nReturn ready.\n\nARGUMENTS: Return ready.",
  },
};
const assistant = {
  type: "assistant",
  sessionId: "session-one",
  message: { content: [] },
};
const transcript = (items: unknown[]) =>
  items.map((item) => JSON.stringify(item)).join("\n");
test("Claude repository dispatch binds exact arguments, session, body, and order", () => {
  const receipt = (items: unknown[]) =>
    matchClaudeRepositoryInvocation({
      ...invocation,
      sessionId: "session-one",
      transcript: transcript(items),
    });
  expect(receipt([command, body, assistant]).accepted).toBe(true);
  expect(JSON.stringify(receipt([command, body, assistant]))).not.toContain(
    "Return ready",
  );
  for (const items of [
    [command, assistant],
    [body, command, assistant],
    [command, body, body, assistant],
    [command, command, body, assistant],
    [command, assistant, body],
    [{ ...command, sessionId: "other" }, body, assistant],
    [command, { ...body, sessionId: "other" }, assistant],
    [command, { ...body, isMeta: false }, assistant],
    [command, { ...body, isSidechain: true }, assistant],
    [command, body, { ...assistant, sessionId: "other" }],
    [
      {
        ...command,
        message: {
          content: command.message.content.replace(
            "Return ready.",
            "Different arguments.",
          ),
        },
      },
      body,
      assistant,
    ],
    [
      command,
      {
        ...body,
        message: {
          content: body.message.content.replace(
            "Return ready.\n",
            "Return ready.extra\n",
          ),
        },
      },
      assistant,
    ],
    [
      command,
      {
        ...body,
        message: { content: body.message.content.replace("Return ready.", "") },
      },
      assistant,
    ],
  ])
    expect(receipt(items).accepted).toBe(false);
  expect(receipt([command, body]).accepted).toBeNull();
  expect(
    matchClaudeRepositoryInvocation({
      ...invocation,
      sessionId: "session-one",
      transcript: "{broken",
    }).accepted,
  ).toBeNull();
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("Claude repository observation refuses unavailable, duplicate, or redirected evidence", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-claude-project-")),
  );
  try {
    const workspace = join(root, "workspace");
    const configRoot = join(root, "config");
    await mkdir(join(workspace, ".claude/skills/probe"), { recursive: true });
    await writeFile(
      join(workspace, ".claude/skills/probe/SKILL.md"),
      invocation.skillText,
    );
    const verified = await verifyClaudeRepositoryInvocation({
      prompt: invocation.prompt,
      workspace,
      condition: "passive",
      explicitSkillInvocation: {
        scope: "repository",
        skillName: "probe",
        token: "/probe",
      },
    });
    const project = join(
      configRoot,
      "projects",
      workspace.replace(/[^A-Za-z0-9]/g, "-"),
    );
    await mkdir(project, { recursive: true });
    const path = join(project, "session-one.jsonl");
    const stream = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "session-one",
      result: "ready",
    });
    const tools = claudeToolCallsObservation(stream, 0);
    const observe = (selectedStream = stream) =>
      claudeRepositoryInvocationObservation({
        invocation: verified,
        stream: selectedStream,
        configRoot,
        workspace,
        tools,
      });
    expect((await observe()).completeness).toBe("partial");
    await writeFile(
      path,
      transcript([
        command,
        {
          ...body,
          message: {
            content: body.message.content.replace(
              invocation.skillDir,
              verified.skillDir,
            ),
          },
        },
        assistant,
      ]),
    );
    const accepted = await observe();
    expect(accepted.completeness).toBe("complete");
    expectUnknown(accepted.data.observedSkills).toEqual(["probe"]);
    expect(JSON.stringify(accepted)).not.toContain("Return ready");
    expect(
      (
        await observe(
          stream +
            "\n" +
            JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: "other",
            }),
        )
      ).completeness,
    ).toBe("partial");
    const target = join(root, "linked.jsonl");
    await writeFile(target, await Bun.file(path).text());
    await rm(path);
    await symlink(target, path);
    expect((await observe()).completeness).toBe("partial");
    const skill = join(workspace, ".claude/skills/probe/SKILL.md");
    await rm(skill);
    await symlink(target, skill);
    expect(
      verifyClaudeRepositoryInvocation({
        prompt: invocation.prompt,
        workspace,
        condition: "passive",
        explicitSkillInvocation: {
          scope: "repository",
          skillName: "probe",
          token: "/probe",
        },
      }),
    ).rejects.toThrow(/unavailable or unsafe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
