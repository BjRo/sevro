import { expectUnknown } from "./fixtures/assertions";
import {
  defined,
  objectContaining,
  parseRunEvidence,
} from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runEvaluation } from "../src/engine";
import { createCodexHost } from "../src/hosts/codex";
import {
  allocateWorkspace,
  removeWorkspace,
} from "../src/fixtures/workspace-state";
const roots: string[] = [];
const isolatedNativeHost =
  process.platform === "darwin" ||
  (process.platform === "linux" && Boolean(Bun.which("bwrap")));
const digest = "a".repeat(64);
async function waitForCodexMarker(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() > deadline) throw new Error("Codex sandbox did not start");
    await Bun.sleep(10);
  }
}
const ordinaryCodexOptions = {
  binary: "/bin/true",
  authFile: "/tmp/auth.json",
  model: "synthetic",
  effort: "low",
  projectRoot: "/tmp/project",
  resultsRoot: "/tmp/results",
  additionalProtectedRoots: [],
};

test.each([
  { label: "relative executable", change: { binary: "codex" } },
  { label: "relative authentication", change: { authFile: "auth.json" } },
  { label: "missing model", change: { model: "" } },
  { label: "missing effort", change: { effort: "" } },
  { label: "zero timeout", change: { timeoutMs: 0 } },
  { label: "fractional timeout", change: { timeoutMs: 1.5 } },
  { label: "overlong timeout", change: { timeoutMs: 30 * 60_000 + 1 } },
  { label: "zero concurrency", change: { agentConcurrencyLimit: 0 } },
  { label: "fractional concurrency", change: { agentConcurrencyLimit: 1.5 } },
  {
    label: "unsafe concurrency",
    change: { agentConcurrencyLimit: Number.MAX_SAFE_INTEGER + 1 },
  },
])("Codex host refuses $label configuration", ({ change }) => {
  expect(() => createCodexHost({ ...ordinaryCodexOptions, ...change })).toThrow(
    "invalid Codex host configuration",
  );
});
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const nativeFeedbackEntry = JSON.stringify({
  ordinal: 1,
  payload: {
    type: "function_call",
    namespace: "collaboration",
    name: "followup_task",
    call_id: "feedback-1",
    arguments: JSON.stringify({
      target: "owner",
      message: "Continue in this thread.",
    }),
  },
});
const nativeFeedbackResponse = JSON.stringify({
  ordinal: 2,
  payload: {
    type: "function_call_output",
    call_id: "feedback-1",
    output: "response",
  },
});
function codexFixtureScript(quotedCodex: string) {
  const loginShell = process.platform === "linux" ? "/bin/bash" : "/bin/zsh";
  return `#!/bin/sh
if [ "$1" = plugin ]; then exec ${quotedCodex} "$@"; fi
if [ "$1" != exec ]; then exit 99; fi
shift
if [ "$1" = resume ]; then
  printf '%s\\n' "$@" > "$PWD/resume-argv.txt"
  /bin/cat > "$PWD/follow-up-prompt.txt"
  if [ -f "$PWD/native-feedback.flag" ]; then
    printf '%s\\n' '${nativeFeedbackEntry}' '${nativeFeedbackResponse}' >> "$CODEX_HOME/sessions/2026/09/27/rollout-thread-1.jsonl"
  fi
  if [ -f "$PWD/wrong-thread.flag" ]; then
    printf '%s\\n' '{"type":"thread.started","thread_id":"thread-2"}'
  else
    printf '%s\\n' '{"type":"thread.started","thread_id":"thread-1"}'
  fi
  if [ -f "$PWD/follow-up-skill-read.flag" ]; then
    skill_file="$CODEX_HOME/plugins/cache/sevro-probe/probe/0.1.0/skills/probe/SKILL.md"
    printf '%s\\n' '{"type":"item.completed","item":{"id":"follow-up-skill","type":"command_execution","command":"cat '"$skill_file"'","aggregated_output":"---\\nname: probe\\ndescription: Test probe\\n---\\nRead this skill.\\n","exit_code":0,"status":"completed"}}'
  fi
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"follow-up ready"}}'
  printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}'
  exit 0
fi
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
capture_root="$workspace"
if [ -f "$workspace/.git/unchanged.flag" ]; then capture_root="$workspace/.git"; fi
printf '%s\\n' "$@" > "$capture_root/argv.txt"
if [ -n "\${OPENAI_API_KEY:-}" ]; then exit 97; fi
/bin/cat > "$capture_root/prompt.txt"
if [ -f "$workspace/.git/skill-hooks.ts" ]; then
  '${process.execPath.replaceAll("'", `'"'"'`)}' "$workspace/.git/skill-hooks.ts" || exit 91
fi
if [ -f "$workspace/capture-model-input.flag" ]; then
  if [ -e "$workspace/.codex" ]; then exit 93; fi
  ${quotedCodex} debug prompt-input "Read the installed probe skill" > "$workspace/model-input.json" || exit 94
  if [ -e "$workspace/.codex" ]; then /bin/rm -rf "$workspace/.codex" || exit 92; fi
fi
if [ -x "$workspace/.git/fixture-bin/fixture-tool" ]; then
  ${loginShell} -lc 'fixture-tool' > "$workspace/fixture-tool-output.txt" || exit 96
fi
if [ -f "$workspace/malformed.flag" ]; then printf '{broken\\n'; exit 0; fi
if [ -f "$workspace/slow.flag" ]; then printf '%s' "$$" > "$workspace/child.pid"; /bin/sleep 10; fi
if [ -f "$workspace/compound-events.jsonl" ]; then
  mkdir -p "$CODEX_HOME/sessions/2026/09/27"
  /bin/cat "$workspace/compound-native.jsonl" > "$CODEX_HOME/sessions/2026/09/27/rollout-thread-1.jsonl"
  /bin/cat "$workspace/compound-events.jsonl"
  exit 0
fi
if [ ! -f "$workspace/.git/unchanged.flag" ]; then
  printf 'created\\n' > "$workspace/created.txt"
fi
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
if [ -f "$workspace/incomplete.flag" ]; then exit 0; fi
if [ -f "$workspace/unknown-usage.flag" ]; then printf '%s\\n' '{"type":"turn.completed"}'; exit 0; fi
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":4}}'
`;
}
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
  await writeFile(fakeBinary, codexFixtureScript(quotedCodex), { mode: 0o700 });
  await chmod(fakeBinary, 0o700);
  return { projectRoot, resultsRoot, authFile, fakeBinary };
}

async function ordinaryCodexRequest() {
  const paths = await fixture();
  const workspace = await mkdtemp(join(tmpdir(), "sevro-codex-request-"));
  roots.push(workspace);
  const host = createCodexHost({
    ...ordinaryCodexOptions,
    binary: paths.fakeBinary,
    authFile: paths.authFile,
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    sandboxBinary: Bun.which("codex") ?? "/bin/false",
  });
  const request = {
    prompt: "Return ready.",
    workspace,
    condition: "passive" as const,
  };
  return { paths, host, request, workspace };
}

test("Codex host collects runner-owned hooks independently of command syntax", async () => {
  if (!isolatedNativeHost) return;
  const { host, request } = await ordinaryCodexRequest();
  await mkdir(join(request.workspace, ".git"));
  await mkdir(join(request.workspace, ".agents/skills/probe"), {
    recursive: true,
  });
  await writeFile(
    join(request.workspace, ".agents/skills/probe/SKILL.md"),
    "Full private skill instructions.\n",
  );
  await writeFile(
    join(request.workspace, ".git/skill-hooks.ts"),
    `
const definitions = await Bun.file(process.env.CODEX_HOME + "/hooks.json").json();
const body = await Bun.file(".agents/skills/probe/SKILL.md").text();
for (const name of ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]) {
  const input = {hook_event_name: name, session_id: "thread-1", tool_use_id: "read-1", tool_name: "mcp__reader__read", tool_response: body};
  const command = definitions.hooks[name][0].hooks[0].command;
  const child = Bun.spawn(["/bin/sh", "-c", command], {stdin: Buffer.from(JSON.stringify(input)), stdout: "pipe", stderr: "pipe"});
  if (await child.exited !== 0) process.exit(90);
}
`,
  );
  const result = await host.run(request);
  expect(result.complete).toBe(true);
  expect(host.hostCapabilities).toContain("sevro.host.skill-activations");
  expect(
    result.observations?.some((item) => item.id.endsWith("skill-reads")),
  ).toBe(false);
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "complete",
    data: { method: "tool_result_body_match", observedSkills: ["probe"] },
  });
  expect(JSON.stringify(result.observations)).not.toContain(
    "Full private skill instructions.",
  );
});

const pagedSkillPages = [
  "---\nname: probe\ndescription: A paged skill tracking fixture.\n---\n# First page\nRead the first instruction before continuing.\n",
  "# Second page\nRead the second instruction and return the requested result.\n",
] as const;

async function runPagedCodex(
  pages: readonly { text: string; session?: string; turn?: string }[],
  options: { body?: string; aliases?: string[] } = {},
) {
  const { host, request } = await ordinaryCodexRequest();
  const body = options.body ?? pagedSkillPages.join("");
  await mkdir(join(request.workspace, ".git"));
  for (const name of ["probe", ...(options.aliases ?? [])]) {
    await mkdir(join(request.workspace, ".agents/skills", name), {
      recursive: true,
    });
    await writeFile(
      join(request.workspace, ".agents/skills", name, "SKILL.md"),
      body,
    );
  }
  await writeFile(
    join(request.workspace, ".git/skill-hooks.ts"),
    `
const definitions = await Bun.file(process.env.CODEX_HOME + "/hooks.json").json();
async function emit(name, fields = {}) {
  const input = {hook_event_name: name, session_id: "thread-1", turn_id: "turn-1", ...fields};
  const command = definitions.hooks[name][0].hooks[0].command;
  const child = Bun.spawn(["/bin/sh", "-c", command], {stdin: Buffer.from(JSON.stringify(input)), stdout: "pipe", stderr: "pipe"});
  if (await child.exited !== 0) process.exit(90);
}
await emit("SessionStart");
for (const [index, page] of ${JSON.stringify(pages)}.entries()) {
  const identity = {tool_use_id: "page-" + index, tool_name: "Bash", session_id: page.session ?? "thread-1", turn_id: page.turn ?? "turn-1"};
  await emit("PreToolUse", identity);
  await emit("PostToolUse", {...identity, tool_response: {output: "private-output-prefix\\n" + page.text + "private-output-suffix"}});
}
await emit("Stop");
`,
  );
  return host.run(request);
}

test("Codex host accounts for paged tool results", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(pagedSkillPages.map((text) => ({ text })));
  expect(result.complete).toBe(true);
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "complete",
    data: { method: "tool_result_body_match", observedSkills: ["probe"] },
  });
  expect(JSON.stringify(result.observations)).not.toContain(
    "private-output-prefix",
  );
  expect(JSON.stringify(result.observations)).not.toContain(pagedSkillPages[0]);
});

test.each([
  { name: "missing tail", pages: [{ text: pagedSkillPages[0] }] },
  {
    name: "duplicate page",
    pages: [{ text: pagedSkillPages[0] }, { text: pagedSkillPages[0] }],
  },
  {
    name: "other session",
    pages: [
      { text: pagedSkillPages[0] },
      { text: pagedSkillPages[1], session: "child-1" },
    ],
  },
  {
    name: "other turn",
    pages: [
      { text: pagedSkillPages[0] },
      { text: pagedSkillPages[1], turn: "turn-2" },
    ],
  },
  {
    name: "hole",
    pages: [
      { text: pagedSkillPages.join("").slice(0, 80) },
      { text: pagedSkillPages.join("").slice(90) },
    ],
  },
  {
    name: "changed tail",
    pages: [
      { text: pagedSkillPages[0] },
      {
        text: pagedSkillPages[1].replace(
          "second instruction",
          "changed instruction",
        ),
      },
    ],
  },
])("incomplete paged tool results stay unknown: $name", async ({ pages }) => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(pages);
  expect(result.complete).toBe(true);
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "partial",
    data: { observedSkills: [], partialSkills: ["probe"] },
  });
});

test.each([
  { name: "reverse order", pages: [...pagedSkillPages].reverse() },
  {
    name: "overlap",
    pages: [
      pagedSkillPages.join("").slice(0, 140),
      pagedSkillPages.join("").slice(100),
    ],
  },
  {
    name: "full body resolves fragments",
    pages: [pagedSkillPages[0], pagedSkillPages.join(""), pagedSkillPages[1]],
  },
])("complete paged tool results tolerate $name", async ({ pages }) => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(pages.map((text) => ({ text })));
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "complete",
    data: { observedSkills: ["probe"], partialSkills: [] },
  });
});

test("paged tool results with identical skill bodies remain ambiguous", async () => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex(
    pagedSkillPages.map((text) => ({ text })),
    { aliases: ["other"] },
  );
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "partial",
    data: { observedSkills: [], ambiguousSkills: ["other", "probe"] },
  });
});

test("repeated page text cannot prove different body positions were exposed", async () => {
  if (!isolatedNativeHost) return;
  const repeated =
    "Read this repeated instruction before any subsequent action.\n";
  const result = await runPagedCodex([{ text: repeated }, { text: repeated }], {
    body: repeated.repeat(3),
  });
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "partial",
    data: { observedSkills: [], partialSkills: ["probe"] },
  });
});

test.each([
  "repeat\n",
  "Read this repeated instruction before any subsequent action.\n",
])("paged matching limits keep evidence unknown: %j", async (line) => {
  if (!isolatedNativeHost) return;
  const result = await runPagedCodex([{ text: line }], {
    body: line.repeat(5000),
  });
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "partial",
    data: { observedSkills: [] },
  });
});

test("Codex state opt-in still refuses a configuration path that is a file", async () => {
  if (!isolatedNativeHost || !Bun.which("codex")) return;
  const { host, request } = await ordinaryCodexRequest();
  await writeFile(join(request.workspace, ".codex"), "not a directory");
  expect(
    host.run({
      ...request,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        codexState: true,
      },
    }),
  ).rejects.toThrow("fixture Codex configuration must be a physical directory");
});

test("Codex continuation stays partial when the workspace fingerprint cannot be read", async () => {
  if (!isolatedNativeHost || !Bun.which("codex")) return;
  const { host, request } = await ordinaryCodexRequest();
  const path = join(request.workspace, "unreadable.txt");
  await writeFile(path, "private content");
  await chmod(path, 0);
  try {
    const result = await host.run({ ...request, followUpPrompt: "Continue." });
    expect(result.complete).toBe(true);
    expect(
      result.observations?.find(
        (item) => item.id === "sevro.codex.continuation",
      ),
    ).toMatchObject({
      completeness: "partial",
      data: { preFollowUpWorktreeUnchanged: null },
    });
  } finally {
    await chmod(path, 0o600);
  }
});

test("failed app-server execution cannot yield a complete owner-dispatch receipt", async () => {
  if (!isolatedNativeHost || !Bun.which("codex")) return;
  const selected = await ordinaryCodexRequest();
  await mkdir(join(selected.workspace, ".git"));
  await writeFile(join(selected.workspace, "failure.txt"), "Fail the turn");
  const skillRoot = join(selected.workspace, ".agents/skills/probe");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: probe\n---\nRead the skill.\n",
  );
  const binary = join(dirname(selected.paths.fakeBinary), "failed-owner-peer");
  await writeFile(
    binary,
    `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fixtures/app-server-peer.ts")}' "$@"\n`,
    { mode: 0o700 },
  );
  const host = createCodexHost({
    ...ordinaryCodexOptions,
    ...selected.paths,
    binary,
    authFile: selected.paths.authFile,
    sandboxBinary: defined(Bun.which("codex")),
    entrypoint: "app-server",
  });
  const result = await host.run({
    ...selected.request,
    prompt: "Use $probe and return ready.",
    explicitSkillInvocation: {
      scope: "repository",
      skillName: "probe",
      token: "$probe",
    },
  });
  expect(result.complete).toBe(false);
  expectUnknown(result.observations).toContainEqual({
    id: "sevro.codex.explicit-invocation",
    completeness: "partial",
    data: {
      method: "explicit_invocation",
      primarySkill: "probe",
    },
  });
});

test.each([
  {
    name: "read",
    input: 'text(await tools.exec_command({cmd:"private read"}));',
    completeness: "complete",
  },
  {
    name: "rejected launch",
    input: 'text(await tools.spawn_agent({message:"private task"}));',
    completeness: "complete",
  },
  {
    name: "dynamic launch",
    input: 'tools[load("private tool")]({});',
    completeness: "partial",
  },
] as const)(
  "Codex host retains Code Mode $name evidence",
  async ({ input, completeness }) => {
    if (!isolatedNativeHost || !Bun.which("codex")) return;
    const selected = await ordinaryCodexRequest();
    const entries = [
      {
        ordinal: 0,
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "submitted",
          input,
        },
      },
      {
        ordinal: 1,
        payload: {
          type: "custom_tool_call_output",
          call_id: "submitted",
          output: [
            {
              type: "input_text",
              text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
            },
            { type: "input_text", text: "private rejected result" },
          ],
        },
      },
    ];
    await writeFile(
      join(selected.workspace, "compound-native.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await writeFile(
      join(selected.workspace, "compound-events.jsonl"),
      [
        { type: "thread.started", thread_id: "thread-1" },
        {
          type: "item.completed",
          item: { type: "agent_message", text: "ready" },
        },
        { type: "turn.completed" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const result = await selected.host.run(selected.request);
    expect(result.complete).toBe(true);
    expectUnknown(result.observations).toContainEqual(
      objectContaining({
        id: "sevro.host.native-controls",
        completeness,
        data: objectContaining({
          execCalls: [objectContaining({ ordinal: 0, completeness })],
        }),
      }),
    );
    expect(JSON.stringify(result.observations)).not.toContain("private");
  },
);

async function ordinaryMarketplace() {
  const selected = await ordinaryCodexRequest();
  const root = join(selected.workspace, "marketplace");
  const manifest = {
    name: "sevro-probe",
    owner: { name: "Sevro" },
    plugins: [{ name: "probe", source: "./plugin", description: "Probe" }],
  };
  const files = {
    ".claude-plugin/marketplace.json": JSON.stringify(manifest),
    "plugin/.claude-plugin/plugin.json": JSON.stringify({
      name: "probe",
      version: "0.1.0",
    }),
    "plugin/.codex-plugin/plugin.json": JSON.stringify({
      name: "probe",
      version: "0.1.0",
      skills: "./skills/",
    }),
    "plugin/skills/probe/SKILL.md":
      "---\nname: probe\ndescription: Test probe\n---\nRead this skill.\n",
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  const declaration = {
    artifactRoot: "marketplace",
    marketplaceName: "sevro-probe",
    pluginNames: ["probe"],
    artifactPaths: Object.keys(files).map((file) => `marketplace/${file}`),
  };
  return { ...selected, root, manifest, declaration };
}

function assertPluginPromptPermissions(modelInput: string): void {
  const messages = JSON.parse(modelInput) as unknown as {
    role: string;
    content: { text?: string }[];
  }[];
  const developer = messages
    .flatMap((message) =>
      message.role === "developer"
        ? message.content.map((item) => item.text)
        : [],
    )
    .join("\n");
  const pluginRoot = developer.match(
    /= `([^`]+\/plugins\/cache\/sevro-probe)`/,
  )?.[1];
  expect(pluginRoot).toContain("plugins/cache/sevro-probe");
  const deniedReads = developer.split("## Denied filesystem reads\n")[1] ?? "";
  const deniedPaths = [...deniedReads.matchAll(/^- path `([^`]+)`$/gm)].map(
    (match) => match[1],
  );
  expect(
    deniedPaths.some(
      (path) => pluginRoot === path || pluginRoot?.startsWith(`${path}/`),
    ),
  ).toBe(false);
}

async function alterMarketplace(
  selected: Awaited<ReturnType<typeof ordinaryMarketplace>>,
  kind: string,
) {
  const manifest = join(selected.root, ".claude-plugin/marketplace.json");
  switch (kind) {
    case "duplicate plugin names":
      selected.declaration.pluginNames.push("probe");
      break;
    case "invalid plugin name":
      selected.declaration.pluginNames = ["UpperCase"];
      break;
    case "duplicate artifact paths":
      selected.declaration.artifactPaths.push(
        "marketplace/.claude-plugin/marketplace.json",
      );
      break;
    case "artifact outside declared root":
      selected.declaration.artifactPaths.push("other/file.txt");
      break;
    case "unreadable manifest":
      await rm(manifest);
      break;
    case "malformed manifest":
      await writeFile(manifest, "{broken");
      break;
    case "nonobject manifest":
      await writeFile(manifest, "null");
      break;
    case "mismatched manifest":
      await writeFile(
        manifest,
        JSON.stringify({ ...selected.manifest, name: "other-marketplace" }),
      );
      break;
    case "missing declared file":
      selected.declaration.artifactPaths.push("marketplace/plugin/missing.txt");
      break;
    case "linked package file":
      await symlink(
        join(selected.root, "plugin/skills/probe/SKILL.md"),
        join(selected.root, "linked-skill.md"),
      );
      break;
    default: {
      const relocated = join(
        dirname(selected.paths.fakeBinary),
        "relocated-marketplace",
      );
      await rename(selected.root, relocated);
      await symlink(relocated, selected.root);
    }
  }
}

test.each([
  ["duplicate plugin names", "invalid Codex marketplace declaration"],
  ["invalid plugin name", "invalid Codex marketplace declaration"],
  ["duplicate artifact paths", "invalid Codex marketplace declaration"],
  ["artifact outside declared root", "invalid Codex marketplace declaration"],
  ["unreadable manifest", "Codex marketplace manifest is unreadable"],
  ["malformed manifest", "Codex marketplace manifest is unreadable"],
  ["nonobject manifest", "invalid Codex marketplace manifest"],
  [
    "mismatched manifest",
    "Codex marketplace manifest does not match declaration",
  ],
  [
    "missing declared file",
    "Codex marketplace package is missing declared files",
  ],
  ["linked package file", "Codex marketplace package contains a symlink"],
  ["relocated package root", "Codex marketplace escapes the workspace"],
])(
  "Codex marketplace refuses %s before model execution",
  async (kind, diagnostic) => {
    const selected = await ordinaryMarketplace();
    await alterMarketplace(selected, kind);
    expect(
      selected.host.run({
        ...selected.request,
        codexMarketplace: selected.declaration,
      }),
    ).rejects.toThrow(diagnostic);
    expect(readFile(join(selected.workspace, "argv.txt"))).rejects.toThrow();
  },
);

test("Codex installed plugin refuses an invoked skill missing from its declared package", async () => {
  if (!isolatedNativeHost || !Bun.which("codex")) return;
  const selected = await ordinaryMarketplace();
  expect(
    selected.host.run({
      ...selected.request,
      prompt: "Use $probe:absent and return ready.",
      codexMarketplace: selected.declaration,
      explicitSkillInvocation: {
        pluginName: "probe",
        skillName: "absent",
        token: "$probe:absent",
      },
    }),
  ).rejects.toThrow("invoked Codex skill is absent from the installation");
  expect(readFile(join(selected.workspace, "argv.txt"))).rejects.toThrow();
});

test.each(["missing", "directory", "oversized"])(
  "Codex selected authentication %s refuses execution without fallback",
  async (kind) => {
    const selected = await ordinaryCodexRequest();
    if (kind === "oversized")
      await writeFile(selected.paths.authFile, "x".repeat(1024 * 1024 + 1));
    else {
      await rm(selected.paths.authFile);
      if (kind === "directory") await mkdir(selected.paths.authFile);
    }
    expect(selected.host.run(selected.request)).rejects.toThrow(
      "Codex auth file is unreadable or oversized",
    );
    expect(readFile(join(selected.workspace, "argv.txt"))).rejects.toThrow();
  },
);

test.each([
  ["empty follow-up", "Codex follow-up prompt must be nonempty"],
  ["whitespace follow-up", "Codex follow-up prompt must be nonempty"],
  ["unsupported instrumentation", "Codex instrumentation is unavailable"],
  ["external fixture tools", "fixture binary path is outside the workspace"],
  ["fixture configuration", "fixture Codex configuration is unsupported"],
])(
  "Codex request refuses %s before candidate launch",
  async (kind, diagnostic) => {
    const selected = await ordinaryCodexRequest();
    const request: Parameters<typeof selected.host.run>[0] = {
      ...selected.request,
    };
    switch (kind) {
      case "empty follow-up":
        request.followUpPrompt = "";
        break;
      case "whitespace follow-up":
        request.followUpPrompt = " \n\t";
        break;
      case "unsupported instrumentation":
        request.instrumentation = [
          { id: "example.enforcement", configuration: {} },
        ];
        break;
      case "external fixture tools":
        request.fixtureBinDir = join(selected.workspace, "tools");
        break;
      default:
        await mkdir(join(selected.workspace, ".codex"));
    }
    expect(selected.host.run(request)).rejects.toThrow(diagnostic);
    expect(readFile(join(selected.workspace, "argv.txt"))).rejects.toThrow();
  },
);

test("CLI refuses a Codex configuration directory that is a regular file", async () => {
  const paths = await fixture();
  await writeFile(
    join(paths.projectRoot, ".codex"),
    "ordinary configuration mistake",
  );
  const repo = resolve(import.meta.dir, "..");
  const child = Bun.spawnSync(
    [
      process.execPath,
      join(repo, "src/cli.ts"),
      "run",
      "--json",
      "--dry",
      "--case-file",
      join(repo, "examples/basic/prompt-only.json"),
      "--host",
      "codex",
      "--codex-bin",
      paths.fakeBinary,
      "--codex-auth-file",
      paths.authFile,
      "--model",
      "synthetic-codex",
      "--effort",
      "low",
      "--project-root",
      paths.projectRoot,
      "--results-root",
      paths.resultsRoot,
      "--condition",
      "passive",
      "--trials",
      "1",
      "--threshold",
      "1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(child.exitCode).toBe(64);
  expect(child.stdout.toString()).toContain("Cannot read Codex configuration:");
});

test("Codex host refuses an otherwise valid stream without a completed turn", async () => {
  if (!isolatedNativeHost || !Bun.which("codex")) return;
  const selected = await ordinaryCodexRequest();
  await writeFile(join(selected.workspace, "incomplete.flag"), "");
  expect(selected.host.run(selected.request)).rejects.toThrow(
    "Codex turn did not complete",
  );
  expect(await readFile(join(selected.workspace, "prompt.txt"), "utf8")).toBe(
    selected.request.prompt,
  );
});

test("Codex continuation keeps combined usage unknown when the initial turn omits usage", async () => {
  if (!isolatedNativeHost || !Bun.which("codex")) return;
  const selected = await ordinaryCodexRequest();
  await writeFile(join(selected.workspace, "unknown-usage.flag"), "");
  const result = await selected.host.run({
    ...selected.request,
    followUpPrompt: "Continue.",
  });
  expect(result.complete).toBe(true);
  expect(result.finalMessage).toBe("follow-up ready");
  expect(result.inputTokens).toBeNull();
  expect(result.outputTokens).toBeNull();
  expect(result.usageComplete).toBe(false);
});
test("Codex host binds bounded native calls to its completed thread", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
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
  expect(host.hostCapabilities).toContain("sevro.host.native-controls");
  expectUnknown(result.observations).toContainEqual({
    id: "sevro.host.native-controls",
    completeness: "complete",
    data: {
      method: "native_control_calls",
      calls: [{ ordinal: 0, namespace: "functions", name: "create_goal" }],
      acceptedAgentCount: 0,
      submittedExecCalls: 0,
      truncated: false,
    },
  });
  expect(JSON.stringify(result.observations)).not.toContain(
    "private objective",
  );
});
test("Codex host resumes a second prompt in the initial thread", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture();
  const workspace = await mkdtemp(join(tmpdir(), "sevro-codex-continuation-"));
  roots.push(workspace);
  await writeFile(join(workspace, "native-calls.flag"), "\n");
  await writeFile(join(workspace, "native-feedback.flag"), "\n");
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
    prompt: "Initial instruction.",
    followUpPrompt: "Continue in this thread.",
    workspace,
    condition: "passive",
  });
  expect(await readFile(join(workspace, "prompt.txt"), "utf8")).toBe(
    "Initial instruction.",
  );
  expect(await readFile(join(workspace, "follow-up-prompt.txt"), "utf8")).toBe(
    "Continue in this thread.",
  );
  expect(await readFile(join(workspace, "argv.txt"), "utf8")).not.toContain(
    "--ephemeral",
  );
  const resumeArgv = await readFile(join(workspace, "resume-argv.txt"), "utf8");
  expect(resumeArgv).toContain("thread-1");
  expect(resumeArgv).toContain('approval_policy="never"');
  expect(result.finalMessage).toBe("follow-up ready");
  expect(result.inputTokens).toBe(17);
  expect(result.outputTokens).toBe(6);
  expect(result.usageComplete).toBe(true);
  expectUnknown(result.artifacts?.map((artifact) => artifact.id)).toEqual([
    "sevro.codex.events",
    "sevro.codex.follow-up-events",
  ]);
  expectUnknown(result.observations).toContainEqual({
    id: "sevro.codex.continuation",
    completeness: "complete",
    data: {
      method: "same_thread_resume",
      threadId: "thread-1",
      nativeAfterOrdinal: 0,
      preFollowUpWorktreeUnchanged: false,
    },
  });
  expectUnknown(result.observations).toContainEqual(
    objectContaining({
      id: "sevro.codex.native-calls",
      completeness: "complete",
      data: objectContaining({
        feedbackCalls: [
          {
            ordinal: 1,
            tool: "followup_task",
            target: "owner",
            responseObserved: true,
            messageRepresentation: "plaintext",
            messageMatchesFollowUpPrompt: true,
          },
        ],
      }),
    }),
  );
});
test("Codex continuation ignores Git-private fixture state at the boundary", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture();
  const workspace = await mkdtemp(join(tmpdir(), "sevro-codex-unchanged-"));
  roots.push(workspace);
  await mkdir(join(workspace, ".git"));
  await writeFile(join(workspace, ".git", "unchanged.flag"), "");
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
    prompt: "Wait.",
    followUpPrompt: "Continue.",
    workspace,
    condition: "passive",
  });
  expectUnknown(result.observations).toContainEqual({
    id: "sevro.codex.continuation",
    completeness: "complete",
    data: {
      method: "same_thread_resume",
      threadId: "thread-1",
      nativeAfterOrdinal: null,
      preFollowUpWorktreeUnchanged: true,
    },
  });
});
test("Codex host refuses a continuation from another thread", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture();
  const workspace = await mkdtemp(join(tmpdir(), "sevro-codex-wrong-thread-"));
  roots.push(workspace);
  await writeFile(join(workspace, "wrong-thread.flag"), "");
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
  expect(
    host.run({
      prompt: "Initial instruction.",
      followUpPrompt: "Continue.",
      workspace,
      condition: "passive",
    }),
  ).rejects.toThrow(/original thread/);
});
test.each(["exec", "app-server"] as const)(
  "Codex prepares a hook-free native plugin in a managed workspace: %s",
  async (entrypoint) => {
    const selected = await ordinaryMarketplace();
    const workspace = await allocateWorkspace();
    try {
      await mkdir(join(workspace, ".git"));
      await cp(selected.root, join(workspace, "marketplace"), {
        recursive: true,
      });
      await writeFile(join(workspace, "require-plugin.flag"), "\n");
      const binary = join(
        dirname(selected.paths.fakeBinary),
        "native-plugin-peer",
      );
      await writeFile(
        binary,
        `#!/bin/sh
if [ "$1" = app-server ]; then
  test -f "$CODEX_HOME/plugins/cache/sevro-probe/probe/0.1.0/skills/probe/SKILL.md" || exit 95
  exec '${process.execPath}' '${join(import.meta.dir, "fixtures/app-server-peer.ts")}' "$@"
fi
exec '${selected.paths.fakeBinary}' "$@"
`,
        { mode: 0o700 },
      );
      const host = createCodexHost({
        ...ordinaryCodexOptions,
        ...selected.paths,
        binary,
        sandboxBinary: defined(Bun.which("codex")),
        entrypoint,
      });
      const result = await host.run({
        ...selected.request,
        workspace,
        codexMarketplace: selected.declaration,
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
          seeds: [
            {
              source: selected.paths.projectRoot,
              target: "hook-cache",
              sha256: digest,
              roles: ["hooks"],
            },
          ],
        },
      });
      expect(result.complete).toBe(true);
      expect(result.finalMessage).toBe("ready");
      expectUnknown(result.observations).toContainEqual({
        id: "sevro.host.hooks",
        completeness: "complete",
        data: {
          plugins: [objectContaining({ name: "probe", allowed: false })],
          executions: [],
        },
      });
    } finally {
      await removeWorkspace(workspace);
    }
  },
);

test.each(["preparation-failure", "cancellation"] as const)(
  "Codex removes private plugin projections after %s",
  async (ending) => {
    const selected = await ordinaryMarketplace();
    const workspace = await allocateWorkspace();
    const controller = new AbortController();
    let running: ReturnType<typeof selected.host.run> | undefined;
    try {
      await cp(selected.root, join(workspace, "marketplace"), {
        recursive: true,
      });
      await writeFile(join(workspace, "require-plugin.flag"), "\n");
      const binary = join(
        dirname(selected.paths.fakeBinary),
        "cleanup-plugin-peer",
      );
      await writeFile(
        binary,
        `#!/bin/sh
printf '%s' "$CODEX_HOME" > "$PWD/private-plugin-home"
exec '${selected.paths.fakeBinary}' "$@"
`,
        { mode: 0o700 },
      );
      if (ending === "preparation-failure") {
        await writeFile(
          join(workspace, "marketplace/plugin/.claude-plugin/plugin.json"),
          JSON.stringify({ name: "probe", version: "0.1.0", mods: {} }),
        );
      } else {
        await writeFile(join(workspace, "slow.flag"), "\n");
      }
      const host = createCodexHost({
        ...ordinaryCodexOptions,
        ...selected.paths,
        binary,
        sandboxBinary: defined(Bun.which("codex")),
      });
      running = host.run({
        ...selected.request,
        workspace,
        codexMarketplace: selected.declaration,
        signal: controller.signal,
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
        },
      });
      if (ending === "preparation-failure") {
        expect(running).rejects.toThrow("runtime plugin mods are unsupported");
        await running.catch(() => undefined);
      } else {
        await waitForCodexMarker(join(workspace, "child.pid"));
        controller.abort("SIGTERM");
        expect(running).rejects.toThrow("Codex run cancelled");
        await running.catch(() => undefined);
      }
      const privateHome = await readFile(
        join(workspace, "private-plugin-home"),
        "utf8",
      );
      expect(existsSync(dirname(privateHome))).toBe(false);
    } finally {
      controller.abort("SIGTERM");
      await running?.catch(() => undefined);
      await removeWorkspace(workspace);
    }
  },
  15000,
);

// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("Codex host installs a declared local plugin in its isolated home", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
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
  await writeFile(join(workspace, "capture-model-input.flag"), "\n");
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
  const modelInput = await readFile(
    join(workspace, "model-input.json"),
    "utf8",
  );
  await rm(join(workspace, "capture-model-input.flag"));
  assertPluginPromptPermissions(modelInput);
  expect(result.finalMessage).toBe("ready");
  expect(result.complete).toBe(true);
  await writeFile(join(workspace, "follow-up-skill-read.flag"), "\n");
  const resumed = await host.run({ ...request, followUpPrompt: "Continue." });
  expect(resumed.complete).toBe(true);
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
  expectUnknown(dispatched.observations).toContainEqual({
    id: "sevro.codex.explicit-invocation",
    completeness: "complete",
    data: {
      method: "explicit_invocation",
      primarySkill: "probe",
    },
  });
  expect(
    host.run({ ...explicit, prompt: "Use $probe:probe twice: $probe:probe." }),
  ).rejects.toThrow(/invalid Codex explicit skill invocation/);
  await writeFile(join(packageRoot, "unlisted.txt"), "extra\n");
  expect(host.run(request)).rejects.toThrow(/undeclared files/);
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
  expect(host.run(request)).rejects.toThrow(/declared local source/);
}, 60_000);
test("Codex host dispatches a verified repository skill without a plugin", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture();
  const workspace = await mkdtemp(join(tmpdir(), "sevro-codex-repository-"));
  roots.push(workspace);
  const skillRoot = join(workspace, ".agents", "skills", "probe");
  const skillFile = join(skillRoot, "SKILL.md");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    skillFile,
    "---\nname: probe\ndescription: Test probe\n---\nRead this skill.\n",
  );
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
    prompt: "Use $probe and return ready.",
    workspace,
    condition: "passive" as const,
    explicitSkillInvocation: {
      scope: "repository" as const,
      skillName: "probe",
      token: "$probe",
    },
  };
  const result = await host.run(request);
  expect(result.complete).toBe(true);
  expect(result.finalMessage).toBe("ready");
  expect(await readFile(join(workspace, "prompt.txt"), "utf8")).toBe(
    request.prompt,
  );
  expectUnknown(result.observations).toContainEqual({
    id: "sevro.codex.explicit-invocation",
    completeness: "complete",
    data: {
      method: "explicit_invocation",
      primarySkill: "probe",
    },
  });
  expect(
    host.run({ ...request, followUpPrompt: "Use $probe again." }),
  ).rejects.toThrow(/invalid Codex explicit skill invocation/);
  expect(
    host.run({
      ...request,
      explicitSkillInvocation: {
        ...request.explicitSkillInvocation,
        token: "$other",
      },
      prompt: "Use $other.",
    }),
  ).rejects.toThrow(/invalid Codex explicit skill invocation/);
  await rm(skillFile);
  expect(host.run(request)).rejects.toThrow(/unavailable or unsafe/);
  const linkedFile = join(workspace, "linked-skill.md");
  await writeFile(linkedFile, "---\nname: probe\n---\n");
  await symlink(linkedFile, skillFile);
  expect(host.run(request)).rejects.toThrow(/unavailable or unsafe/);
  await rm(skillRoot, { recursive: true });
  const linkedRoot = join(workspace, "linked-skill");
  await mkdir(linkedRoot);
  await writeFile(join(linkedRoot, "SKILL.md"), "---\nname: probe\n---\n");
  await symlink(linkedRoot, skillRoot);
  expect(host.run(request)).rejects.toThrow(/unavailable or unsafe/);
});
test("Codex host verifies its permission profile and feeds the engine", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
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
  const raw = defined(defined(outcome.result.cases[0]).trials[0]);
  expectUnknown(raw.checks.map((check) => check.status)).toEqual([
    "passed",
    "passed",
  ]);
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  expectUnknown(defined(evidence.trials[0]).usage).toEqual({
    inputTokens: 12,
    outputTokens: 4,
    costUsd: null,
    complete: true,
  });
  expect(defined(evidence.trials[0]).condition.actual).toBe("passive");
  expect(defined(defined(evidence.trials[0]).routes[0])).toMatchObject({
    host: "sevro.host.codex",
    model: "synthetic-codex",
    effort: "low",
  });
  const [events] = defined(evidence.trials[0]).artifactRefs;
  expect(defined(events).id).toBe("sevro.codex.events");
  expect(await readFile(new URL(defined(events).path), "utf8")).toContain(
    '"type":"turn.completed"',
  );
});
test("Codex fixture tools survive login-shell PATH setup", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
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
  if (!isolatedNativeHost || !installedCodex) return;
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
  expect(
    host.run({ prompt: "ready", workspace, condition: "passive" }),
  ).rejects.toThrow(/invalid JSONL/);
  expect(await readFile(join(workspace, "prompt.txt"), "utf8")).toBe("ready");
  const argv = await readFile(join(workspace, "argv.txt"), "utf8");
  expect(argv).toContain("--strict-config");
  expect(argv).toContain("default_permissions=");
  expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(
    host.run({ prompt: "ready", workspace, condition: "enforced" }),
  ).rejects.toThrow(/enforcement instrumentation/);
});
test("Codex host terminates a timed out turn", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
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
  expect(
    host.run({ prompt: "ready", workspace, condition: "passive" }),
  ).rejects.toThrow(/timed out/);
});
test("Codex host kills its process group when cancelled", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
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
  const settled = running.catch(() => undefined);
  try {
    const pidPath = join(workspace, "child.pid");
    const deadline = Date.now() + 30_000;
    while (!(await Bun.file(pidPath).exists())) {
      if (Date.now() > deadline) throw new Error("Codex child did not start");
      await Bun.sleep(20);
    }
    const pid = Number(await readFile(pidPath, "utf8"));
    controller.abort();
    expect(running).rejects.toThrow(/cancelled/);
    await settled;
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await settled;
  }
}, 60_000);
test("Codex host refuses an executable inside a protected project", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
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
  expect(
    host.run({ prompt: "ready", workspace, condition: "passive" }),
  ).rejects.toThrow(/executable resides inside a protected root/);
});

test("Codex without authorized command hooks does not read hook dependencies", async () => {
  const selected = await ordinaryCodexRequest();
  const source = join(selected.paths.projectRoot, "hook-dependencies");
  await mkdir(source);
  const host = createCodexHost({
    ...ordinaryCodexOptions,
    binary: selected.paths.fakeBinary,
    authFile: selected.paths.authFile,
    projectRoot: selected.paths.projectRoot,
    resultsRoot: selected.paths.resultsRoot,
    sandboxBinary: defined(Bun.which("true")),
  });
  const result = await host.run({
    ...selected.request,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      seeds: [
        { source, target: "cache", sha256: "a".repeat(64), roles: ["hooks"] },
      ],
    },
  });
  expect(result.complete).toBe(true);
  expect(result.finalMessage).toBe("ready");
});

test("Codex sandbox profile does not grow with stale temporary case folders", async () => {
  const selected = await ordinaryCodexRequest();
  const sandbox = join(dirname(selected.paths.fakeBinary), "sandbox-profile");
  const receipt = join(dirname(sandbox), "profile.toml");
  await writeFile(
    sandbox,
    `#!/bin/sh\n/bin/cp "$CODEX_HOME/config.toml" '${receipt}'\n`,
    { mode: 0o700 },
  );
  const host = createCodexHost({
    ...ordinaryCodexOptions,
    binary: selected.paths.fakeBinary,
    authFile: selected.paths.authFile,
    projectRoot: selected.paths.projectRoot,
    resultsRoot: selected.paths.resultsRoot,
    sandboxBinary: sandbox,
  });
  expect((await host.run(selected.request)).complete).toBe(true);
  const before = (await readFile(receipt, "utf8"))
    .split("\n")
    .filter((line) => line.endsWith('= "deny"')).length;
  for (let index = 0; index < 200; index++)
    roots.push(await mkdtemp(join(tmpdir(), "sevro-case-stale-")));
  expect((await host.run(selected.request)).complete).toBe(true);
  const after = (await readFile(receipt, "utf8"))
    .split("\n")
    .filter((line) => line.endsWith('= "deny"')).length;
  expect(after).toBe(before);
});
test.each(["candidate", "semantic"])(
  "Codex %s preflight failure retains its cause and process evidence",
  // eslint-disable-next-line max-lines-per-function -- Keep the public candidate/semantic failure scenario and its retained artifact assertions together.
  async (role) => {
    const selected = await ordinaryCodexRequest();
    const sandbox = join(
      dirname(selected.paths.fakeBinary),
      "sandbox-diagnostic",
    );
    await writeFile(
      sandbox,
      "#!/bin/sh\nprintf 'sandbox compilation failed' >&2\nexit 70\n",
      { mode: 0o700 },
    );
    const host = createCodexHost({
      ...ordinaryCodexOptions,
      binary: selected.paths.fakeBinary,
      authFile: selected.paths.authFile,
      projectRoot: selected.paths.projectRoot,
      resultsRoot: selected.paths.resultsRoot,
      sandboxBinary: sandbox,
    });
    const candidate =
      role === "candidate"
        ? host
        : {
            id: "example.candidate",
            model: "synthetic",
            effort: "none",
            run() {
              return Promise.resolve({ finalMessage: "ready", complete: true });
            },
          };
    const outcome = await runEvaluation({
      projectRoot: selected.paths.projectRoot,
      resultsRoot: selected.paths.resultsRoot,
      host: candidate,
      semanticHost: role === "semantic" ? host : undefined,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        nativeTranscripts: true,
      },
      case: {
        id: "preflight",
        prompt: "Return ready.",
        fixture: { files: {} },
        requiredEvidence: [],
        checks:
          role === "semantic"
            ? [
                {
                  id: "ready",
                  grader: "sevro.semantic",
                  configuration: { proposition: "The response is ready." },
                },
              ]
            : [],
      },
      runnerBuildDigest: digest,
      projectDigest: digest,
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
    });
    expect(defined(outcome.result.diagnostic).message).toBe(
      "Codex isolation preflight failed",
    );
    expect(outcome.result.exitCode).toBe(role === "candidate" ? 2 : 3);
    const evidence = parseRunEvidence(
      await readFile(outcome.result.evidencePath, "utf8"),
    );
    const refs = defined(evidence.trials[0]).artifactRefs;
    const processRef = defined(
      refs.find((item) => item.id.endsWith("codex.process")),
    );
    const process = JSON.parse(
      await readFile(new URL(processRef.path), "utf8"),
    ) as unknown;
    expectUnknown(process).toMatchObject({
      code: 70,
      signal: null,
      phase: "isolation-preflight",
    });
    const stderr = defined(
      refs.find((item) => item.id.endsWith("codex.stderr")),
    );
    expect(await readFile(new URL(stderr.path), "utf8")).toBe(
      "sandbox compilation failed",
    );
  },
);
test("Codex preflight retains a bounded stderr prefix without failing on overflow", async () => {
  const selected = await ordinaryCodexRequest();
  const sandbox = join(dirname(selected.paths.fakeBinary), "sandbox-stderr");
  await writeFile(
    sandbox,
    "#!/bin/sh\n/usr/bin/head -c 70000 /dev/zero >&2\nexit 70\n",
    { mode: 0o700 },
  );
  const host = createCodexHost({
    ...ordinaryCodexOptions,
    binary: selected.paths.fakeBinary,
    authFile: selected.paths.authFile,
    projectRoot: selected.paths.projectRoot,
    resultsRoot: selected.paths.resultsRoot,
    sandboxBinary: sandbox,
  });
  const result = await host.run({
    ...selected.request,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  const stderr = defined(
    result.artifacts?.find((item) => item.id === "codex.stderr"),
  );
  expect(stderr.bytes.byteLength).toBe(64 * 1024);
  const process = defined(
    result.artifacts?.find((item) => item.id === "codex.process"),
  );
  const metadata: unknown = JSON.parse(
    Buffer.from(process.bytes).toString("utf8"),
  );
  expectUnknown(metadata).toMatchObject({ code: 70, stderrTruncated: true });
});
test.each([false, true])(
  "Codex semantic preflight cancellation stays cancelled with transcripts %s",
  async (nativeTranscripts) => {
    const selected = await ordinaryCodexRequest();
    const sandbox = join(dirname(selected.paths.fakeBinary), "sandbox-cancel");
    const marker = join(dirname(sandbox), "sandbox-started");
    await writeFile(
      sandbox,
      `#!/bin/sh\nprintf started > '${marker}'\nprintf 'sandbox cancelled' >&2\n/bin/sleep 20\n`,
      { mode: 0o700 },
    );
    const host = createCodexHost({
      ...ordinaryCodexOptions,
      binary: selected.paths.fakeBinary,
      authFile: selected.paths.authFile,
      projectRoot: selected.paths.projectRoot,
      resultsRoot: selected.paths.resultsRoot,
      sandboxBinary: sandbox,
    });
    const controller = new AbortController();
    const running = runEvaluation({
      projectRoot: selected.paths.projectRoot,
      resultsRoot: selected.paths.resultsRoot,
      host: {
        id: "example.candidate",
        model: "synthetic",
        effort: "none",
        run() {
          return Promise.resolve({ finalMessage: "ready", complete: true });
        },
      },
      semanticHost: host,
      signal: controller.signal,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        nativeTranscripts,
      },
      case: {
        id: "cancel",
        prompt: "Return ready.",
        fixture: { files: {} },
        checks: [
          {
            id: "ready",
            grader: "sevro.semantic",
            configuration: { proposition: "The response is ready." },
          },
        ],
        requiredEvidence: [],
      },
      runnerBuildDigest: digest,
      projectDigest: digest,
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
    });
    await waitForCodexMarker(marker);
    controller.abort("SIGTERM");
    const outcome = await running;
    expect(
      defined(defined(outcome.result.cases[0]).trials[0]).execution.status,
    ).toBe("cancelled");
    expect(outcome.result.exitCode).toBe(143);
    const evidence = parseRunEvidence(
      await readFile(outcome.result.evidencePath, "utf8"),
    );
    const artifacts = defined(evidence.trials[0]).artifactRefs;
    const ref = defined(
      artifacts.find((item) => item.id.endsWith("codex.process")),
    );
    const metadata: unknown = JSON.parse(
      await readFile(new URL(ref.path), "utf8"),
    );
    expectUnknown(metadata).toMatchObject({
      phase: "isolation-preflight",
      reason: "cancelled",
      code: 137,
      signal: "SIGKILL",
    });
  },
);
test("Codex preflight timeout retains termination evidence", async () => {
  const selected = await ordinaryCodexRequest();
  const sandbox = join(dirname(selected.paths.fakeBinary), "sandbox-timeout");
  await writeFile(
    sandbox,
    "#!/bin/sh\nprintf 'sandbox stalled' >&2\n/bin/sleep 70\n",
    { mode: 0o700 },
  );
  const host = createCodexHost({
    ...ordinaryCodexOptions,
    binary: selected.paths.fakeBinary,
    authFile: selected.paths.authFile,
    projectRoot: selected.paths.projectRoot,
    resultsRoot: selected.paths.resultsRoot,
    sandboxBinary: sandbox,
  });
  const outcome = await runEvaluation({
    projectRoot: selected.paths.projectRoot,
    resultsRoot: selected.paths.resultsRoot,
    host,
    case: {
      id: "timeout",
      prompt: "Return ready.",
      fixture: { files: {} },
      checks: [],
      requiredEvidence: [],
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(outcome.result.diagnostic?.message).toBe(
    "Codex isolation preflight timed out after 60 s",
  );
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  const ref = defined(
    defined(evidence.trials[0]).artifactRefs.find((item) =>
      item.id.endsWith("codex.process"),
    ),
  );
  const process: unknown = JSON.parse(
    await readFile(new URL(ref.path), "utf8"),
  );
  expectUnknown(process).toMatchObject({
    reason: "timeout",
    code: 137,
    signal: "SIGKILL",
  });
}, 70000);
test("Codex runs one sandbox invocation for isolation and executable preflight", async () => {
  const selected = await ordinaryCodexRequest();
  const sandbox = join(dirname(selected.paths.fakeBinary), "sandbox-probe");
  const receipt = join(dirname(sandbox), "sandbox-invocations");
  await writeFile(
    sandbox,
    `#!/bin/sh
printf '%s\\n' sandbox >> '${receipt}'
`,
    { mode: 0o700 },
  );
  const host = createCodexHost({
    ...ordinaryCodexOptions,
    binary: selected.paths.fakeBinary,
    authFile: selected.paths.authFile,
    projectRoot: selected.paths.projectRoot,
    resultsRoot: selected.paths.resultsRoot,
    sandboxBinary: sandbox,
  });
  const result = await host.run(selected.request);
  expect(result.complete).toBe(true);
  expect((await readFile(receipt, "utf8")).trim().split("\n")).toHaveLength(1);
});

test.each([70, 71])(
  "Codex refuses combined sandbox probe failure %s before participant execution",
  async (code) => {
    const selected = await ordinaryCodexRequest();
    const sandbox = join(dirname(selected.paths.fakeBinary), "sandbox-failure");
    await writeFile(sandbox, `#!/bin/sh\nexit ${code}\n`, { mode: 0o700 });
    const host = createCodexHost({
      ...ordinaryCodexOptions,
      binary: selected.paths.fakeBinary,
      authFile: selected.paths.authFile,
      projectRoot: selected.paths.projectRoot,
      resultsRoot: selected.paths.resultsRoot,
      sandboxBinary: sandbox,
    });
    expect(host.run(selected.request)).rejects.toThrow(
      code === 71
        ? "Codex executable preflight failed"
        : "Codex isolation preflight failed",
    );
    expect(
      await Bun.file(join(selected.workspace, "prompt.txt")).exists(),
    ).toBe(false);
  },
);

test("Codex permits bounded sandbox startup beyond ten seconds", async () => {
  const selected = await ordinaryCodexRequest();
  const sandbox = join(
    dirname(selected.paths.fakeBinary),
    "sandbox-slow-start",
  );
  await writeFile(sandbox, "#!/bin/sh\nsleep 10.1\n", { mode: 0o700 });
  const host = createCodexHost({
    ...ordinaryCodexOptions,
    binary: selected.paths.fakeBinary,
    authFile: selected.paths.authFile,
    projectRoot: selected.paths.projectRoot,
    resultsRoot: selected.paths.resultsRoot,
    sandboxBinary: sandbox,
  });
  expect((await host.run(selected.request)).complete).toBe(true);
}, 20_000);

test("Codex preserves omitted dependency source isolation in grading policies", async () => {
  const selected = await ordinaryCodexRequest();
  const source = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-omitted-dependency-")),
  );
  roots.push(source);
  const host = createCodexHost({
    ...ordinaryCodexOptions,
    binary: selected.paths.fakeBinary,
    authFile: selected.paths.authFile,
    projectRoot: selected.paths.projectRoot,
    resultsRoot: selected.paths.resultsRoot,
    sandboxBinary: defined(Bun.which("true")),
  });
  expect(
    host.run({
      ...selected.request,
      runtimeRole: "semantic",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [source],
        seeds: [],
        seedReadDenyRoots: [source],
      },
    }),
  ).rejects.toThrow("protected data");
});

test.each([{ roles: [] }, { roles: ["candidate", "candidate"] }] as const)(
  "Codex refuses invalid programmatic seed role selection $roles",
  async ({ roles }) => {
    const selected = await ordinaryCodexRequest();
    expect(
      selected.host.run({
        ...selected.request,
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
          seeds: [
            {
              source: selected.paths.projectRoot,
              target: "cache",
              sha256: "a".repeat(64),
              roles: [...roles],
            },
          ],
        },
      }),
    ).rejects.toThrow("runtime seed roles are invalid");
  },
);

test.each([false, true])(
  "Codex skips dependencies for plugins without authorized command handlers: %s",
  async (allowed) => {
    const selected = await ordinaryMarketplace();
    const source = await realpath(selected.paths.projectRoot);
    const host = createCodexHost({
      ...ordinaryCodexOptions,
      binary: selected.paths.fakeBinary,
      authFile: selected.paths.authFile,
      projectRoot: selected.paths.projectRoot,
      resultsRoot: selected.paths.resultsRoot,
      sandboxBinary: defined(Bun.which("true")),
    });
    const result = await host.run({
      ...selected.request,
      codexMarketplace: selected.declaration,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        seeds: [
          { source, target: "cache", sha256: "a".repeat(64), roles: ["hooks"] },
        ],
        hooks: { plugins: allowed ? ["probe"] : [] },
      },
    });
    expect(result.complete).toBe(true);
    expect(
      result.observations?.find((item) => item.id === "sevro.host.hooks")?.data
        .plugins,
    ).toMatchObject([{ name: "probe", allowed }]);
  },
);
