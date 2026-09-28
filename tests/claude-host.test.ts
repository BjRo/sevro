import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeHost } from "../src/hosts/claude";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("Claude host runs with native sandbox settings and declared plugins", async () => {
  if (process.platform !== "darwin") return;
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
      'test "${DARROW_CACHE_DIR#*/.git/sevro-runtime/}" = darrow-cache || exit 8',
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

test("Claude host observes a bound native repository command without a plugin", async () => {
  if (process.platform !== "darwin") return;
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
  expect(completed.observations).toContainEqual({
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
  await expect(
    host.run({ ...request, prompt: "/probe /probe" }),
  ).rejects.toThrow(/invalid Claude repository skill invocation/);
});

test("Claude host refuses undeclared and escaping plugin packages", async () => {
  if (process.platform !== "darwin") return;
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
  await expect(
    host.run({
      prompt: "ready",
      workspace,
      condition: "passive",
      claudePluginDirs: { artifactRoots: ["../outside"], artifactPaths: [] },
    }),
  ).rejects.toThrow();
});
