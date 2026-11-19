import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeHost } from "../../../src/hosts/index";
import { syntheticClaudeLogin } from "../../fixtures/claude-login";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

const isolatedNativeHost =
  process.platform === "darwin" ||
  (process.platform === "linux" && Boolean(Bun.which("bwrap")));

const skillText =
  "---\nname: probe\ndescription: Probe\n---\n# Probe\nReturn ready.\n";
const prompt = "/probe Return ready.";
const command = {
  type: "user",
  sessionId: "session-one",
  message: {
    content:
      "<command-message>probe</command-message>\n<command-name>/probe</command-name>\n<command-args>Return ready.</command-args>",
  },
};
// The synthetic Claude substitutes the mounted skill directory it observes.
const body = {
  type: "user",
  sessionId: "session-one",
  isMeta: true,
  message: {
    content:
      "Base directory for this skill: {SKILL_DIR}\n\n# Probe\nReturn ready.\n\nARGUMENTS: Return ready.",
  },
};
const assistant = {
  type: "assistant",
  sessionId: "session-one",
  message: { content: [] },
};
const completed = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "session-one",
  result: "ready",
};
const lines = (items: unknown[]) =>
  items.map((item) => JSON.stringify(item)).join("\n");

/** Writes the scenario's native session, then emits its declared stream. */
const syntheticClaude = `#!${process.execPath}
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
const workspace = await realpath(process.cwd());
const scenario = await Bun.file(join(workspace, "scenario.json")).json();
const skillDir = join(workspace, ".claude/skills/probe");
const project = join(process.env.CLAUDE_CONFIG_DIR, "projects", workspace.replace(/[^A-Za-z0-9]/g, "-"));
await mkdir(project, { recursive: true });
if (scenario.transcript !== null) {
  const text = scenario.transcript.replaceAll("{SKILL_DIR}", skillDir);
  const session = join(project, "session-one.jsonl");
  if (scenario.link) {
    const target = join(process.env.CLAUDE_CONFIG_DIR, "linked.jsonl");
    await writeFile(target, text);
    await symlink(target, session);
  } else await writeFile(session, text);
}
process.stdout.write(scenario.stream + "\\n");
`;

interface Scenario {
  transcript: string | null;
  stream?: string;
  link?: boolean;
  prompt?: string;
}

async function repositoryHost(mountedSkill = skillText) {
  const root = await temporaryFixture(
    join(tmpdir(), "sevro-claude-repository-"),
  );
  const workspace = join(root, "workspace");
  const projectRoot = join(root, "source");
  const resultsRoot = join(root, "results");
  const credentialFile = join(root, "credential.json");
  const binary = join(root, "fake-claude");
  const skill = join(workspace, ".claude/skills/probe/SKILL.md");
  await Promise.all(
    [join(workspace, ".claude/skills/probe"), projectRoot, resultsRoot].map(
      (path) => mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(credentialFile, syntheticClaudeLogin());
  await writeFile(skill, mountedSkill);
  await writeFile(binary, syntheticClaude, { mode: 0o755 });
  const host = createClaudeHost({
    binary,
    model: "synthetic",
    effort: "low",
    projectRoot,
    resultsRoot,
    additionalProtectedRoots: [],
    credentialFile,
    projectSettings: true,
  });
  const request = (selectedPrompt = prompt) => ({
    prompt: selectedPrompt,
    workspace,
    condition: "passive" as const,
    explicitSkillInvocation: {
      scope: "repository" as const,
      skillName: "probe",
      token: "/probe",
    },
  });
  async function observe(scenario: Scenario) {
    await writeFile(
      join(workspace, "scenario.json"),
      JSON.stringify({
        link: false,
        stream: lines([completed]),
        ...scenario,
      }),
    );
    const result = await host.run(request(scenario.prompt));
    expect(result.finalMessage).toBe("ready");
    const observation = result.observations?.find(
      (item) => item.id === "sevro.claude.repository-invocation",
    );
    if (!observation) throw new Error("missing repository observation");
    return observation;
  }
  return { root, host, request, observe, skill };
}

test("Claude repository dispatch accepts native text block arrays without retaining bodies", async () => {
  if (!isolatedNativeHost) return;
  const { observe } = await repositoryHost();
  const observation = await observe({
    transcript: lines([
      {
        ...command,
        message: { content: [{ type: "text", text: command.message.content }] },
      },
      {
        ...body,
        message: { content: [{ type: "text", text: body.message.content }] },
      },
      assistant,
    ]),
  });
  expect(observation).toEqual({
    id: "sevro.claude.repository-invocation",
    completeness: "complete",
    data: {
      method: "native_repository_command",
      accepted: true,
      reason: "native command and complete mounted body matched",
      skill: "probe",
    },
  });
  expect(JSON.stringify(observation)).not.toContain("Return ready");
});

test("Claude repository dispatch accepts a command with no arguments", async () => {
  if (!isolatedNativeHost) return;
  const { observe } = await repositoryHost();
  const observation = await observe({
    prompt: "/probe",
    transcript: lines([
      {
        ...command,
        message: {
          content:
            "<command-message>probe</command-message>\n<command-name>/probe</command-name>",
        },
      },
      {
        ...body,
        message: {
          content: body.message.content.replace(
            "ARGUMENTS: Return ready.",
            "ARGUMENTS: ",
          ),
        },
      },
      assistant,
    ]),
  });
  expect(observation).toMatchObject({
    completeness: "complete",
    data: { accepted: true },
  });
});

test("Claude repository dispatch does not accept a command embedded after ordinary prompt text", async () => {
  if (!isolatedNativeHost) return;
  const { host, request, root } = await repositoryHost();
  const pending = host.run(request("Please run /probe Return ready."));
  expect(pending).rejects.toThrow("invalid Claude repository skill invocation");
  await pending.catch(() => undefined);
  // Refused before execution: the synthetic Claude never read a scenario.
  expect(await Bun.file(join(root, "workspace/scenario.json")).exists()).toBe(
    false,
  );
});

test("Claude repository dispatch leaves a metadata-only mount unavailable", async () => {
  if (!isolatedNativeHost) return;
  const { observe } = await repositoryHost(
    "---\nname: probe\ndescription: Probe\n---\n",
  );
  expect(
    await observe({ transcript: lines([command, assistant]) }),
  ).toMatchObject({
    completeness: "partial",
    data: { accepted: null, reason: "empty mounted body", skill: "probe" },
  });
});

test("Claude repository mount accepts a newline-delimited leading command and refuses a missing skill", async () => {
  if (!isolatedNativeHost) return;
  const { observe, host, request, skill } = await repositoryHost();
  expect(
    await observe({
      prompt: "/probe\nReturn ready.",
      transcript: lines([command, body, assistant]),
    }),
  ).toMatchObject({ completeness: "complete", data: { accepted: true } });
  await rm(skill);
  expect(host.run(request("/probe\nReturn ready."))).rejects.toThrow(
    "invoked Claude repository skill is unavailable or unsafe",
  );
});

/** Each native session ordering or correlation fault and its refusal. */
const refused: Array<[unknown[], string]> = [
  [[command, assistant], "missing, partial, or duplicate mounted body"],
  [[body, command, assistant], "mounted body is uncorrelated"],
  [
    [command, body, body, assistant],
    "missing, partial, or duplicate mounted body",
  ],
  [[command, command, body, assistant], "missing or duplicate native command"],
  [[command, assistant, body], "missing, partial, or duplicate mounted body"],
  [
    [{ ...command, sessionId: "other" }, body, assistant],
    "command session or arguments differ",
  ],
  [
    [command, { ...body, sessionId: "other" }, assistant],
    "mounted body is uncorrelated",
  ],
  [
    [command, { ...body, isMeta: false }, assistant],
    "mounted body is uncorrelated",
  ],
  [
    [command, { ...body, isSidechain: true }, assistant],
    "mounted body is uncorrelated",
  ],
  [
    [command, body, { ...assistant, sessionId: "other" }],
    "assistant session differs",
  ],
  [
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
    "command session or arguments differ",
  ],
  [
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
    "missing, partial, or duplicate mounted body",
  ],
  [
    [
      command,
      {
        ...body,
        message: {
          content: body.message.content.replace("Return ready.", ""),
        },
      },
      assistant,
    ],
    "missing, partial, or duplicate mounted body",
  ],
];

test("Claude repository dispatch binds exact arguments, session, body, and order", async () => {
  if (!isolatedNativeHost) return;
  const { observe } = await repositoryHost();
  const accepted = await observe({
    transcript: lines([command, body, assistant]),
  });
  expect(accepted).toMatchObject({
    completeness: "complete",
    data: { accepted: true },
  });
  expect(JSON.stringify(accepted)).not.toContain("Return ready");
  for (const [items, reason] of refused)
    expect(await observe({ transcript: lines(items) })).toMatchObject({
      completeness: "partial",
      data: { accepted: false, reason },
    });
  expect(await observe({ transcript: lines([command, body]) })).toMatchObject({
    completeness: "partial",
    data: { accepted: null, reason: "missing assistant turn" },
  });
  expect(await observe({ transcript: "{broken" })).toMatchObject({
    completeness: "partial",
    data: { accepted: null, reason: "malformed native session" },
  });
}, 30_000);

test("Claude repository observation refuses unavailable, duplicate, or redirected evidence", async () => {
  if (!isolatedNativeHost) return;
  const { observe, host, request, root, skill } = await repositoryHost();
  const unavailable = {
    completeness: "partial",
    data: { accepted: null, reason: "native session evidence unavailable" },
  };
  expect(await observe({ transcript: null })).toMatchObject(unavailable);
  const transcript = lines([command, body, assistant]);
  const accepted = await observe({ transcript });
  expect(accepted.completeness).toBe("complete");
  expect(accepted.data).toMatchObject({ skill: "probe" });
  expect(accepted.data).not.toHaveProperty("observedSkills");
  expect(JSON.stringify(accepted)).not.toContain("Return ready");
  expect(
    await observe({
      transcript,
      stream: lines([
        completed,
        { type: "system", subtype: "init", session_id: "other" },
      ]),
    }),
  ).toMatchObject(unavailable);
  expect(await observe({ transcript, link: true })).toMatchObject(unavailable);
  const target = join(root, "linked-skill.md");
  await writeFile(target, skillText);
  await rm(skill);
  await symlink(target, skill);
  expect(host.run(request())).rejects.toThrow(/unavailable or unsafe/);
});
