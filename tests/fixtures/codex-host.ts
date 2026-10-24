import { expect } from "bun:test";
import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCodexHost } from "../../src/hosts/codex";
import { createTemporaryFixtures } from "./filesystem";

export const isolatedNativeHost =
  process.platform === "darwin" ||
  (process.platform === "linux" && Boolean(Bun.which("bwrap")));

export const digest = "a".repeat(64);

export async function waitForCodexMarker(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() > deadline) throw new Error("Codex sandbox did not start");
    await Bun.sleep(10);
  }
}

export const ordinaryCodexOptions = {
  binary: "/bin/true",
  authFile: "/tmp/auth.json",
  model: "synthetic",
  effort: "low",
  projectRoot: "/tmp/project",
  resultsRoot: "/tmp/results",
  additionalProtectedRoots: [],
};

export const nativeFeedbackEntry = JSON.stringify({
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

export const nativeFeedbackResponse = JSON.stringify({
  ordinal: 2,
  payload: {
    type: "function_call_output",
    call_id: "feedback-1",
    output: "response",
  },
});

export function codexFixtureScript(roots: string[], quotedCodex: string) {
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

export async function fixture(roots: string[]) {
  const { temporaryFixture } = createTemporaryFixtures(roots);

  const projectRoot = await temporaryFixture(
    join(tmpdir(), "sevro-codex-project-"),
  );
  const fixtureRoot = await temporaryFixture(
    join(tmpdir(), "sevro-codex-fixture-"),
  );

  const resultsRoot = join(projectRoot, "results");
  const authFile = join(projectRoot, "auth.json");
  const fakeBinary = join(fixtureRoot, "fake-codex");
  await mkdir(resultsRoot);
  await writeFile(authFile, "test-only-auth\n", { mode: 0o600 });
  const installedCodex = Bun.which("codex");
  const quotedCodex = installedCodex
    ? `'${installedCodex.replaceAll("'", `'"'"'`)}'`
    : "/bin/false";
  await writeFile(fakeBinary, codexFixtureScript(roots, quotedCodex), {
    mode: 0o700,
  });
  await chmod(fakeBinary, 0o700);
  return { projectRoot, resultsRoot, authFile, fakeBinary };
}

export async function ordinaryCodexRequest(roots: string[]) {
  const { temporaryFixture } = createTemporaryFixtures(roots);

  const paths = await fixture(roots);
  const workspace = await temporaryFixture(
    join(tmpdir(), "sevro-codex-request-"),
  );

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

export const pagedSkillPages = [
  "---\nname: probe\ndescription: A paged skill tracking fixture.\n---\n# First page\nRead the first instruction before continuing.\n",
  "# Second page\nRead the second instruction and return the requested result.\n",
] as const;

export interface CodexSkillPage {
  text: string;
  session?: string;
  turn?: string;
  omitPost?: boolean;
}

export interface SkillTrackingFixtureOptions {
  body?: string;
  aliases?: readonly string[];
  siblings?: Record<string, string>;
  omitStart?: boolean;
  omitStop?: boolean;
  hookEvents?: readonly { event: string; fields?: Record<string, unknown> }[];
}

export async function runPagedCodex(
  roots: string[],
  pages: readonly CodexSkillPage[],
  options: SkillTrackingFixtureOptions = {},
) {
  const { host, request } = await ordinaryCodexRequest(roots);
  const body = options.body ?? pagedSkillPages.join("");
  await mkdir(join(request.workspace, ".git"));
  const skills = {
    ...Object.fromEntries(
      ["probe", ...(options.aliases ?? [])].map((name) => [name, body]),
    ),
    ...options.siblings,
  };
  for (const [name, skillBody] of Object.entries(skills)) {
    await mkdir(join(request.workspace, ".agents/skills", name), {
      recursive: true,
    });
    await writeFile(
      join(request.workspace, ".agents/skills", name, "SKILL.md"),
      skillBody,
    );
  }
  await writeFile(
    join(request.workspace, ".git/skill-hooks.ts"),
    pagedHookScript(pages, options),
  );
  return host.run(request);
}

export function pagedHookScript(
  pages: readonly CodexSkillPage[],
  options: SkillTrackingFixtureOptions,
) {
  return `
const definitions = await Bun.file(process.env.CODEX_HOME + "/hooks.json").json();
async function emit(name, fields = {}) {
  const input = {hook_event_name: name, session_id: "thread-1", turn_id: "turn-1", ...fields};
  const command = definitions.hooks[name][0].hooks[0].command;
  const child = Bun.spawn(["/bin/sh", "-c", command], {stdin: Buffer.from(JSON.stringify(input)), stdout: "pipe", stderr: "pipe"});
  if (await child.exited !== 0) process.exit(90);
}
if (!${Boolean(options.omitStart)}) await emit("SessionStart");
for (const [index, page] of ${JSON.stringify(pages)}.entries()) {
  const identity = {tool_use_id: "page-" + index, tool_name: "Bash", session_id: page.session ?? "thread-1", turn_id: page.turn ?? "turn-1"};
  await emit("PreToolUse", identity);
  if (!page.omitPost) await emit("PostToolUse", {...identity, tool_response: {output: "private-output-prefix\\n" + page.text + "private-output-suffix"}});
}
for (const extra of ${JSON.stringify(options.hookEvents ?? [])}) await emit(extra.event, extra.fields);
if (!${Boolean(options.omitStop)}) await emit("Stop");
`;
}

export const sharedSkillParagraph =
  "This diagnostic capability leaves all repository files unchanged and returns only its named public result.\n";

export const completeProbeBody =
  pagedSkillPages.join("") + sharedSkillParagraph;

export const siblingSkillBody =
  "---\nname: sibling\ndescription: An unrelated greeting skill.\n---\n# Sibling\nReturn HELLO only when asked for the sibling diagnostic.\n\n" +
  sharedSkillParagraph;

export async function ordinaryMarketplace(roots: string[]) {
  const selected = await ordinaryCodexRequest(roots);
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

export function assertPluginPromptPermissions(modelInput: string): void {
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

export async function alterMarketplace(
  roots: string[],
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
