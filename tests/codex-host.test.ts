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
import { runEvaluation } from "../src/engine";
import { createCodexHost } from "../src/hosts/codex";

const roots: string[] = [];
const digest = "a".repeat(64);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-codex-project-"));
  const fixtureRoot = await mkdtemp(join(tmpdir(), "sevro-codex-fixture-"));
  roots.push(projectRoot, fixtureRoot);
  const resultsRoot = join(projectRoot, "results");
  const authFile = join(projectRoot, "auth.json");
  const fakeBinary = join(fixtureRoot, "fake-codex");
  await mkdir(resultsRoot);
  await writeFile(authFile, "test-only-auth\n", { mode: 0o600 });
  const installedCodex = Bun.which("codex");
  const quotedCodex = installedCodex
    ? `'${installedCodex.replaceAll("'", `'"'"'`)}'`
    : "/bin/false";
  await writeFile(
    fakeBinary,
    `#!/bin/sh
if [ "$1" = plugin ]; then exec ${quotedCodex} "$@"; fi
if [ "$1" != exec ]; then exit 99; fi
shift
workspace=""
previous=""
for argument in "$@"; do
  if [ "$previous" = -C ]; then workspace="$argument"; fi
  previous="$argument"
done
if [ -z "$workspace" ]; then exit 98; fi
if [ -f "$workspace/require-plugin.flag" ]; then
  test -f "$CODEX_HOME/plugins/cache/sevro-probe/probe/0.1.0/skills/probe/SKILL.md" || exit 95
fi
printf '%s\\n' "$@" > "$workspace/argv.txt"
if [ -n "\${OPENAI_API_KEY:-}" ]; then exit 97; fi
/bin/cat > "$workspace/prompt.txt"
if [ -x "$workspace/.git/fixture-bin/fixture-tool" ]; then
  /bin/zsh -lc 'fixture-tool' > "$workspace/fixture-tool-output.txt" || exit 96
fi
if [ -f "$workspace/malformed.flag" ]; then printf '{broken\\n'; exit 0; fi
if [ -f "$workspace/slow.flag" ]; then printf '%s' "$$" > "$workspace/child.pid"; /bin/sleep 10; fi
printf 'created\\n' > "$workspace/created.txt"
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-1"}'
if [ -f "$workspace/native-calls.flag" ]; then
  mkdir -p "$CODEX_HOME/sessions/2026/09/27"
  echo '{"ordinal":0,"payload":{"type":"function_call","namespace":"functions","name":"create_goal","arguments":"private objective"}}' > "$CODEX_HOME/sessions/2026/09/27/rollout-thread-1.jsonl"
fi
if [ -f "$workspace/require-plugin.flag" ] && [ ! -f "$workspace/skip-skill-read.flag" ]; then
  skill_file="$CODEX_HOME/plugins/cache/sevro-probe/probe/0.1.0/skills/probe/SKILL.md"
  printf '%s\\n' '{"type":"item.completed","item":{"id":"skill","type":"command_execution","command":"cat '"$skill_file"'","aggregated_output":"---\\nname: probe\\ndescription: Test probe\\n---\\nRead this skill.\\n","exit_code":0,"status":"completed"}}'
fi
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":4}}'
`,
    { mode: 0o700 },
  );
  await chmod(fakeBinary, 0o700);
  return { projectRoot, resultsRoot, authFile, fakeBinary };
}

test("Codex host binds bounded native calls to its completed thread", async () => {
  const installedCodex = Bun.which("codex");
  if (process.platform !== "darwin" || !installedCodex) return;
  const paths = await fixture();
  const workspace = await mkdtemp(join(tmpdir(), "sevro-codex-native-"));
  roots.push(workspace);
  await writeFile(join(workspace, "native-calls.flag"), "\n");
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  const result = await host.run({
    prompt: "Return ready.",
    workspace,
    condition: "passive",
  });
  expect(result.observations).toContainEqual({
    id: "sevro.codex.native-calls",
    completeness: "complete",
    data: {
      method: "native_session",
      calls: [
        {
          ordinal: 0,
          namespace: "functions",
          name: "create_goal",
          evidence: "invocation_attempt",
        },
      ],
      toolCalls: [{ ordinal: 0, namespace: "functions", name: "create_goal" }],
      submittedExecCalls: 0,
      acceptedSpawns: [],
    },
  });
  expect(JSON.stringify(result.observations)).not.toContain(
    "private objective",
  );
});

test("Codex host installs a declared local plugin in its isolated home", async () => {
  const installedCodex = Bun.which("codex");
  if (process.platform !== "darwin" || !installedCodex) return;
  const paths = await fixture();
  const workspace = await mkdtemp(join(tmpdir(), "sevro-codex-plugin-"));
  roots.push(workspace);
  const packageRoot = join(workspace, "marketplace");
  await mkdir(join(packageRoot, ".claude-plugin"), { recursive: true });
  await mkdir(join(packageRoot, "plugin", ".claude-plugin"), {
    recursive: true,
  });
  await mkdir(join(packageRoot, "plugin", ".codex-plugin"), {
    recursive: true,
  });
  await mkdir(join(packageRoot, "plugin", "skills", "probe"), {
    recursive: true,
  });
  await writeFile(
    join(packageRoot, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "sevro-probe",
      owner: { name: "Sevro" },
      plugins: [{ name: "probe", source: "./plugin", description: "Probe" }],
    }),
  );
  await writeFile(
    join(packageRoot, "plugin", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "probe", version: "0.1.0" }),
  );
  await writeFile(
    join(packageRoot, "plugin", ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "probe", version: "0.1.0", skills: "./skills/" }),
  );
  await writeFile(
    join(packageRoot, "plugin", "skills", "probe", "SKILL.md"),
    "---\nname: probe\ndescription: Test probe\n---\nRead this skill.\n",
  );
  await writeFile(join(workspace, "require-plugin.flag"), "\n");
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  const request = {
    prompt: "Return ready.",
    workspace,
    condition: "passive" as const,
    codexMarketplace: {
      artifactRoot: "marketplace",
      marketplaceName: "sevro-probe",
      pluginNames: ["probe"],
      artifactPaths: [
        "marketplace/.claude-plugin/marketplace.json",
        "marketplace/plugin/.claude-plugin/plugin.json",
        "marketplace/plugin/.codex-plugin/plugin.json",
        "marketplace/plugin/skills/probe/SKILL.md",
      ],
    },
  };
  const result = await host.run(request);
  expect(result.finalMessage).toBe("ready");
  expect(result.complete).toBe(true);
  expect(result.observations?.[0]).toMatchObject({
    id: "sevro.codex.skill-reads",
    completeness: "complete",
    data: { primarySkill: "probe", observedSkills: ["probe"] },
  });
  expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe(
    "created\n",
  );
  await writeFile(join(workspace, "skip-skill-read.flag"), "\n");
  const explicit = {
    ...request,
    prompt: "Use $probe:probe and return ready.",
    explicitSkillInvocation: {
      pluginName: "probe",
      skillName: "probe",
      token: "$probe:probe",
    },
  };
  const dispatched = await host.run(explicit);
  expect(dispatched.observations).toContainEqual({
    id: "sevro.codex.explicit-invocation",
    completeness: "complete",
    data: {
      method: "explicit_invocation",
      primarySkill: "probe",
      observedSkills: ["probe"],
    },
  });
  expect(dispatched.observations?.[0]).toMatchObject({
    id: "sevro.codex.skill-reads",
    data: { primarySkill: null, observedSkills: [] },
  });
  await expect(
    host.run({ ...explicit, prompt: "Use $probe:probe twice: $probe:probe." }),
  ).rejects.toThrow(/invalid Codex explicit skill invocation/);
  await writeFile(join(packageRoot, "unlisted.txt"), "extra\n");
  await expect(host.run(request)).rejects.toThrow(/undeclared files/);
  await rm(join(packageRoot, "unlisted.txt"));
  await writeFile(
    join(packageRoot, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "sevro-probe",
      owner: { name: "Sevro" },
      plugins: [
        {
          name: "probe",
          source: "https://example.com/plugin",
          description: "Probe",
        },
      ],
    }),
  );
  await expect(host.run(request)).rejects.toThrow(/declared local source/);
});

test("Codex host verifies its permission profile and feeds the engine", async () => {
  const installedCodex = Bun.which("codex");
  if (process.platform !== "darwin" || !installedCodex) return;
  const paths = await fixture();
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  const outcome = await runEvaluation({
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    case: {
      id: "codex-case",
      prompt: "Return ready.",
      fixture: { files: { "README.md": "fixture\n" } },
      checks: [
        {
          id: "response",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
        {
          id: "created",
          grader: "sevro.shell",
          configuration: { run: "test -f created.txt" },
        },
      ],
      requiredEvidence: ["sevro.codex.events"],
    },
    host,
    shellIsolation: { protectedRoots: [] },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(outcome.result.exitCode).toBe(0);
  const raw = outcome.result.cases[0]?.trials[0];
  expect(raw?.checks.map((check) => check.status)).toEqual([
    "passed",
    "passed",
  ]);
  const evidence = JSON.parse(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  expect(evidence.trials[0].usage).toEqual({
    inputTokens: 12,
    outputTokens: 4,
    costUsd: null,
    complete: true,
  });
  expect(evidence.trials[0].condition.actual).toBe("passive");
  expect(evidence.trials[0].routes[0]).toMatchObject({
    host: "sevro.host.codex",
    model: "synthetic-codex",
    effort: "low",
  });
  expect(evidence.trials[0].observations).toContainEqual({
    id: "sevro.codex.skill-reads",
    source: "sevro.host.codex",
    completeness: "complete",
    data: {
      method: "skill_file_read_probe",
      primarySkill: null,
      observedSkills: [],
    },
  });
  const [events] = evidence.trials[0].artifactRefs;
  expect(events.id).toBe("sevro.codex.events");
  expect(await readFile(new URL(events.path), "utf8")).toContain(
    '"type":"turn.completed"',
  );
});

test("Codex fixture tools survive login-shell PATH setup", async () => {
  const installedCodex = Bun.which("codex");
  if (process.platform !== "darwin" || !installedCodex) return;
  const paths = await fixture();
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  const outcome = await runEvaluation({
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    case: {
      id: "codex-fixture-tool",
      prompt: "Return ready.",
      fixture: {
        kind: "generated",
        commits: [
          { message: "Initialize", files: { "README.md": "fixture\n" } },
        ],
        bin: { "fixture-tool": "#!/bin/sh\nprintf 'fixture tool\\n'\n" },
      },
      checks: [
        {
          id: "fixture-tool-output",
          grader: "sevro.shell",
          configuration: {
            run: "cat fixture-tool-output.txt",
            expectExact: "fixture tool",
          },
        },
      ],
      requiredEvidence: [],
    },
    host,
    shellIsolation: { protectedRoots: [] },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(outcome.result.task.verdict).toBe("passed");
});

test("Codex host rejects malformed streams and unsupported enforcement", async () => {
  const installedCodex = Bun.which("codex");
  if (process.platform !== "darwin" || !installedCodex) return;
  const paths = await fixture();
  const workspace = await mkdtemp(join(tmpdir(), "sevro-case-codex-"));
  roots.push(workspace);
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  await writeFile(join(workspace, "malformed.flag"), "");
  await expect(
    host.run({ prompt: "ready", workspace, condition: "passive" }),
  ).rejects.toThrow(/invalid JSONL/);
  expect(await readFile(join(workspace, "prompt.txt"), "utf8")).toBe("ready");
  const argv = await readFile(join(workspace, "argv.txt"), "utf8");
  expect(argv).toContain("--strict-config");
  expect(argv).toContain("default_permissions=");
  expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  await expect(
    host.run({ prompt: "ready", workspace, condition: "enforced" }),
  ).rejects.toThrow(/enforcement instrumentation/);
});

test("Codex host terminates a timed out turn", async () => {
  const installedCodex = Bun.which("codex");
  if (process.platform !== "darwin" || !installedCodex) return;
  const paths = await fixture();
  const workspace = await mkdtemp(join(tmpdir(), "sevro-case-codex-slow-"));
  roots.push(workspace);
  await writeFile(join(workspace, "slow.flag"), "");
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
    timeoutMs: 50,
  });
  await expect(
    host.run({ prompt: "ready", workspace, condition: "passive" }),
  ).rejects.toThrow(/timed out/);
});

test("Codex host kills its process group when cancelled", async () => {
  const installedCodex = Bun.which("codex");
  if (process.platform !== "darwin" || !installedCodex) return;
  const paths = await fixture();
  const workspace = await mkdtemp(
    join(tmpdir(), "sevro-case-codex-cancelled-"),
  );
  roots.push(workspace);
  await writeFile(join(workspace, "slow.flag"), "");
  const controller = new AbortController();
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  const running = host.run({
    prompt: "ready",
    workspace,
    condition: "passive",
    signal: controller.signal,
  });
  const pidPath = join(workspace, "child.pid");
  const deadline = Date.now() + 5000;
  while (!(await Bun.file(pidPath).exists())) {
    if (Date.now() > deadline) throw new Error("Codex child did not start");
    await Bun.sleep(20);
  }
  const pid = Number(await readFile(pidPath, "utf8"));
  controller.abort();
  await expect(running).rejects.toThrow(/cancelled/);
  expect(() => process.kill(pid, 0)).toThrow();
});

test("Codex host refuses an executable inside a protected project", async () => {
  const installedCodex = Bun.which("codex");
  if (process.platform !== "darwin" || !installedCodex) return;
  const paths = await fixture();
  const workspace = await mkdtemp(join(tmpdir(), "sevro-case-codex-rejected-"));
  roots.push(workspace);
  const insideProject = join(paths.projectRoot, "fake-codex");
  await writeFile(insideProject, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const host = createCodexHost({
    binary: insideProject,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  await expect(
    host.run({ prompt: "ready", workspace, condition: "passive" }),
  ).rejects.toThrow(/executable resides inside a protected root/);
});
