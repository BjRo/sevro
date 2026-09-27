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

test("Claude host runs with private login, outer isolation, and declared plugins", async () => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(join(tmpdir(), "sevro-claude-host-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const projectRoot = join(root, "source");
  const resultsRoot = join(root, "results");
  const credentialFile = join(root, "credential.json");
  const binary = join(root, "fake-claude");
  const plugin = join(workspace, "package", "probe");
  await Promise.all(
    [
      workspace,
      projectRoot,
      resultsRoot,
      join(plugin, ".claude-plugin"),
      join(plugin, "skills", "probe"),
    ].map((path) => mkdir(path, { recursive: true })),
  );
  await writeFile(credentialFile, '{"test":"private-login"}');
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
      'printf "%s\\n" "$@" > argv.txt',
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
  expect(argv).toContain("--setting-sources\n\n");
  expect(argv).toContain("--permission-mode\ndontAsk\n");
  expect(argv).not.toContain("--allowedTools");
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
