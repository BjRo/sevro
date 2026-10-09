import { expectUnknown } from "./fixtures/assertions";
import { defined, parseRunEvidence } from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEvaluation } from "../src/engine";
import { createClaudeHost } from "../src/hosts/claude";
const roots: string[] = [];
const isolatedNativeHost =
  process.platform === "darwin" ||
  (process.platform === "linux" && Boolean(Bun.which("bwrap")));
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function nativeGoalFixtureScript() {
  return `#!${process.execPath}
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
const config = process.env.CLAUDE_CONFIG_DIR;
if (!config) throw new Error("Missing synthetic Claude config");
const mode = process.argv[process.argv.indexOf("-p") + 1];
const session = "00000000-0000-4000-8000-000000000001";
const projects = join(config, "projects");
const directory = join(projects, "fixture");
await mkdir(directory, { recursive: true });
const user = {type:"user",sessionId:session,message:{content:"Return ready."}};
const sidechain = {type:"attachment",sessionId:session,isSidechain:true,attachment:{type:"goal_status",condition:"PRIVATE_CHILD_GOAL",met:true}};
let transcript = JSON.stringify(user);
if (mode === "sidechain-only") transcript += "\\n" + JSON.stringify(sidechain);
if (mode === "empty-transcript") transcript = "";
if (mode === "oversized-transcript") transcript = JSON.stringify({...user,message:{content:"PRIVATE_TRANSCRIPT_TEXT" + "x".repeat(8*1024*1024)}});
await writeFile(join(directory, session + ".jsonl"), transcript);
if (mode === "metadata-file") await writeFile(join(directory,"index.txt"),"retained session index");
if (mode === "linked-tree") await symlink(directory, join(projects,"linked"));
if (mode === "many-files") await Promise.all(Array.from({length:1025},(_,index)=>writeFile(join(directory,index+".txt"),"index")));
const failed = mode === "failed-turn";
for(const entry of [{type:"system",subtype:"init",session_id:session},{type:"result",subtype:failed?"error_during_execution":"success",is_error:failed,session_id:session,result:failed?"model unavailable":"ready"}]) process.stdout.write(JSON.stringify(entry)+"\\n");
`;
}

async function nativeGoalHostFixture() {
  const root = await mkdtemp(join(tmpdir(), "sevro-claude-goal-retention-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const projectRoot = join(root, "source");
  const resultsRoot = join(root, "results");
  await Promise.all(
    [workspace, projectRoot, resultsRoot].map((path) => mkdir(path)),
  );
  const credentialFile = join(root, "credential.json");
  await writeFile(credentialFile, '{"test":"private-login"}');
  const binary = join(root, "fake-claude");
  await writeFile(binary, nativeGoalFixtureScript(), { mode: 0o755 });
  const host = createClaudeHost({
    binary,
    model: "synthetic",
    effort: "low",
    projectRoot,
    resultsRoot,
    additionalProtectedRoots: [],
    credentialFile,
  });
  return { host, workspace };
}

test.each(["no-goal", "sidechain-only", "metadata-file"])(
  "Claude complete native session records bounded goal absence: %s",
  async (mode) => {
    if (!isolatedNativeHost) return;
    const { host, workspace } = await nativeGoalHostFixture();
    const result = await host.run({
      prompt: mode,
      workspace,
      condition: "passive",
    });
    expect(result.complete).toBe(true);
    expect(
      result.observations?.find((item) => item.id === "sevro.host.native-goal"),
    ).toMatchObject({
      completeness: "complete",
      data: {
        method: "native_session",
        threadId: "00000000-0000-4000-8000-000000000001",
        goals: [],
        goalStatus: null,
      },
    });
    expect(JSON.stringify(result.observations)).not.toContain(
      "PRIVATE_CHILD_GOAL",
    );
  },
);

test.each([
  ["empty-transcript", "Original native session not retained"],
  ["oversized-transcript", "Native transcript is unsafe or oversized"],
  ["linked-tree", "Native transcript tree contains a symlink"],
  ["many-files", "Native transcript tree exceeds limit"],
  ["failed-turn", "Native session did not finish successfully"],
])(
  "Claude unavailable native goal evidence cannot establish absence: %s",
  async (mode, failure) => {
    if (!isolatedNativeHost) return;
    const { host, workspace } = await nativeGoalHostFixture();
    const result = await host.run({
      prompt: mode,
      workspace,
      condition: "passive",
    });
    expect(result.complete).toBe(mode !== "failed-turn");
    expect(
      result.observations?.find((item) => item.id === "sevro.host.native-goal"),
    ).toMatchObject({
      completeness: "unavailable",
      data: { method: "native_session", failure },
    });
    expect(JSON.stringify(result.observations)).not.toContain(
      "PRIVATE_TRANSCRIPT_TEXT",
    );
  },
);
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("failed Claude execution retains private evidence without grading", async () => {
  if (!isolatedNativeHost) return;
  const root = await mkdtemp(join(tmpdir(), "sevro-claude-failure-"));
  roots.push(root);
  const projectRoot = join(root, "source");
  const resultsRoot = join(root, "results");
  const credentialFile = join(root, "credential.json");
  const binary = join(root, "fake-claude");
  await mkdir(projectRoot);
  await writeFile(credentialFile, '{"test":"private-login"}');
  const event = JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "ready",
  });
  await writeFile(
    binary,
    `#!/bin/sh\nprintf '%s\\n' '${event}'\nprintf '%s\\n' 'private host diagnosis' >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  const host = createClaudeHost({
    binary,
    model: "synthetic",
    effort: "low",
    projectRoot,
    resultsRoot,
    additionalProtectedRoots: [],
    credentialFile,
  });
  const outcome = await runEvaluation({
    projectRoot,
    resultsRoot,
    host,
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 2,
    passThreshold: 1,
    jobs: 1,
    case: {
      id: "failed-host",
      prompt: "Return ready.",
      fixture: { files: { "README.md": "fixture\n" } },
      checks: [
        {
          id: "response",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
      requiredEvidence: [],
    },
  });
  expect(outcome.result).toMatchObject({
    execution: { status: "failed" },
    grading: { status: "not_requested" },
    task: { verdict: "not_assessed" },
    exitCode: 2,
  });
  expect(defined(outcome.result.cases[0]).trials).toHaveLength(1);
  expect(JSON.stringify(outcome.result)).not.toContain(
    "private host diagnosis",
  );
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  expectUnknown(
    defined(defined(outcome.result.cases[0]).trials[0]).checks,
  ).toEqual([]);
  for (const [id, contents] of [
    ["sevro.claude.events", `${event}\n`],
    ["sevro.claude.stderr", "private host diagnosis\n"],
  ] as const) {
    const artifact = defined(evidence.trials[0]).artifactRefs.find(
      (item: { id: string }) => item.id === id,
    );
    expect(artifact).toBeDefined();
    const path = fileURLToPath(defined(artifact).path);
    expect(await readFile(path, "utf8")).toBe(contents);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("Claude host runs with native sandbox settings and declared plugins", async () => {
  if (!isolatedNativeHost) return;
  const root = await mkdtemp(join(tmpdir(), "sevro-claude-host-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const projectRoot = join(root, "source");
  const resultsRoot = join(root, "results");
  const credentialFile = join(root, "credential.json");
  const uvCacheDir = join(root, "uv-cache");
  const toolchainBinDir = join(root, "toolchain");
  const binary = join(root, "fake-claude");
  const plugin = join(workspace, "package", "probe");
  await Promise.all(
    [
      workspace,
      projectRoot,
      resultsRoot,
      join(plugin, ".claude-plugin"),
      join(plugin, "skills", "probe"),
      uvCacheDir,
      toolchainBinDir,
    ].map((path) => mkdir(path, { recursive: true })),
  );
  await writeFile(credentialFile, '{"test":"private-login"}');
  await writeFile(join(uvCacheDir, "sentinel"), "cache ready\n");
  await writeFile(join(toolchainBinDir, "sevro-tool"), "#!/bin/sh\nexit 0\n");
  await chmod(join(toolchainBinDir, "sevro-tool"), 0o755);
  await writeFile(join(projectRoot, "secret.txt"), "protected source");
  await writeFile(
    join(plugin, ".claude-plugin", "plugin.json"),
    '{"name":"probe","version":"0.1.0"}',
  );
  await writeFile(
    join(plugin, "skills", "probe", "SKILL.md"),
    "Use this skill.\n",
  );
  await writeFile(
    binary,
    [
      "#!/bin/sh",
      'test -r "$CLAUDE_CONFIG_DIR/.credentials.json" || exit 3',
      'test "$(cat "$UV_CACHE_DIR/sentinel")" = "cache ready" || exit 6',
      'test "$UV_OFFLINE" = 1 || exit 7',
      'test "$PYTHONDONTWRITEBYTECODE" = 1 || exit 10',
      'test "${UV_PROJECT_ENVIRONMENT#*/.git/sevro-runtime/}" = project-environment || exit 11',
      'test -z "${DARROW_CACHE_DIR+x}" || exit 8',
      "command -v sevro-tool >/dev/null || exit 9",
      'printf "%s\\n" "$@" > argv.txt',
      'while [ "$#" -gt 1 ]; do if [ "$1" = --settings ]; then settings=$2; break; fi; shift; done',
      `grep -F '${projectRoot}' "$settings" >/dev/null || exit 4`,
      `grep -F '${resultsRoot}' "$settings" >/dev/null || exit 5`,
      'printf \'%s\\n\' \'{"type":"result","subtype":"success","is_error":false,"result":"ready","usage":{"input_tokens":1,"output_tokens":2},"total_cost_usd":0.01}\'',
    ].join("\n") + "\n",
  );
  await chmod(binary, 0o755);
  const host = createClaudeHost({
    binary,
    model: "sonnet",
    effort: "low",
    projectRoot,
    resultsRoot,
    additionalProtectedRoots: [credentialFile],
    credentialFile,
    uvCacheDir,
    toolchainBinDir,
    projectSettings: true,
  });
  const result = await host.run({
    prompt: "Use /probe:probe and return ready.",
    workspace,
    condition: "passive",
    claudePluginDirs: {
      artifactRoots: ["package/probe"],
      artifactPaths: [
        "package/probe/.claude-plugin/plugin.json",
        "package/probe/skills/probe/SKILL.md",
      ],
    },
    explicitSkillInvocation: {
      pluginName: "probe",
      skillName: "probe",
      token: "/probe:probe",
    },
  });
  expect(result.finalMessage).toBe("ready");
  expect(result.complete).toBe(true);
  expect(host.hostCapabilities).toContain("sevro.host.native-controls");
  expectUnknown(result.observations).toContainEqual({
    id: "sevro.host.native-controls",
    completeness: "complete",
    data: {
      method: "native_control_calls",
      calls: [],
      acceptedAgentCount: null,
      submittedExecCalls: null,
      truncated: false,
    },
  });
  expect(result.observations?.[0]).toMatchObject({
    id: "sevro.claude.tool-calls",
    completeness: "complete",
  });
  expect(result.artifacts?.[0]?.id).toBe("sevro.claude.events");
  const argv = await readFile(join(workspace, "argv.txt"), "utf8");
  expect(argv).toContain("--plugin-dir\n");
  expect(argv).toContain("--setting-sources\nproject\n");
  expect(argv).toContain("--permission-mode\ndontAsk\n");
  expect(argv).not.toContain("--allowedTools");
  expect(argv).toContain("--tools\nBash,Read,Edit,Skill,Agent\n");
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("Claude host observes a bound native repository command without a plugin", async () => {
  if (!isolatedNativeHost) return;
  const root = await mkdtemp(join(tmpdir(), "sevro-claude-repository-host-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const projectRoot = join(root, "source");
  const resultsRoot = join(root, "results");
  const credentialFile = join(root, "credential.json");
  const binary = join(root, "fake-claude");
  await Promise.all(
    [join(workspace, ".claude/skills/probe"), projectRoot, resultsRoot].map(
      (path) => mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(credentialFile, '{"test":"private-login"}');
  await writeFile(
    join(workspace, ".claude/skills/probe/SKILL.md"),
    "---\nname: probe\ndescription: Probe\n---\nReturn ready.\n",
  );
  await writeFile(
    binary,
    `#!${process.execPath}
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
if (process.argv.includes("--plugin-dir")) process.exit(2);
const workspace = await realpath(process.cwd());
const skillDir = join(workspace, ".claude/skills/probe");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const args = prompt.slice("/probe".length).trim();
const body = (await Bun.file(join(skillDir, "SKILL.md")).text()).replace(/^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n/, "").trim();
const project = join(process.env.CLAUDE_CONFIG_DIR, "projects", workspace.replace(/[^A-Za-z0-9]/g, "-"));
await mkdir(project, { recursive: true });
const command = { type: "user", sessionId: "session-one", message: { content: "<command-message>probe</command-message>\\n<command-name>/probe</command-name>" + (args ? "\\n<command-args>" + args + "</command-args>" : "") } };
const loaded = { type: "user", sessionId: "session-one", isMeta: true, message: { content: "Base directory for this skill: " + skillDir + "\\n\\n" + body + "\\n\\nARGUMENTS: " + args } };
const assistant = { type: "assistant", sessionId: "session-one", message: { content: [{ type: "tool_use", id: "skill-one", name: "Skill", input: { skill: "probe" } }] } };
await writeFile(join(project, "session-one.jsonl"), [command, ...(await Bun.file("unverified.flag").exists() ? [] : [loaded]), assistant].map(entry => JSON.stringify(entry)).join("\\n"));
for (const entry of [{ type: "system", subtype: "init", session_id: "session-one" }, assistant, { type: "result", subtype: "success", is_error: false, result: "ready", session_id: "session-one" }]) process.stdout.write(JSON.stringify(entry) + "\\n");
`,
    { mode: 0o755 },
  );
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
  const request = {
    prompt: "/probe Return ready.",
    workspace,
    condition: "passive" as const,
    explicitSkillInvocation: {
      scope: "repository" as const,
      skillName: "probe",
      token: "/probe",
    },
  };
  const completed = await host.run(request);
  expect(completed.finalMessage).toBe("ready");
  expectUnknown(completed.observations).toContainEqual({
    id: "sevro.claude.repository-invocation",
    completeness: "complete",
    data: {
      method: "native_repository_command",
      accepted: true,
      reason: "native command and complete mounted body matched",
      skill: "probe",
      primarySkill: "probe",
      observedSkills: ["probe"],
    },
  });
  await writeFile(join(workspace, "unverified.flag"), "\n");
  const unverified = await host.run(request);
  expect(
    unverified.observations?.find(
      (observation) => observation.id === "sevro.claude.repository-invocation",
    ),
  ).toMatchObject({ completeness: "partial", data: { accepted: false } });
  expect(host.run({ ...request, prompt: "/probe /probe" })).rejects.toThrow(
    /invalid Claude repository skill invocation/,
  );
  const disabled = createClaudeHost({
    binary,
    model: "synthetic",
    effort: "low",
    projectRoot,
    resultsRoot,
    additionalProtectedRoots: [],
    credentialFile,
  });
  expect(disabled.hostCapabilities).not.toContain(
    "sevro.claude.repository-invocation",
  );
  expect(disabled.run(request)).rejects.toThrow(
    /requires project setting sources/,
  );
});
test("Claude host refuses undeclared and escaping plugin packages", async () => {
  if (!isolatedNativeHost) return;
  const root = await mkdtemp(join(tmpdir(), "sevro-claude-host-invalid-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const host = createClaudeHost({
    binary: "/bin/true",
    model: "sonnet",
    effort: "low",
    projectRoot: root,
    resultsRoot: root,
    additionalProtectedRoots: [],
  });
  expect(
    host.run({
      prompt: "ready",
      workspace,
      condition: "passive",
      claudePluginDirs: { artifactRoots: ["../outside"], artifactPaths: [] },
    }),
  ).rejects.toThrow();
});
