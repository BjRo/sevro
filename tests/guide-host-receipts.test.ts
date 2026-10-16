import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvaluation } from "../src/engine";
import { createCodexHost } from "../src/hosts/codex";
import { defined, parseRunEvidence } from "./fixtures/assertions";

const roots: string[] = [];
const isolatedNativeHost =
  process.platform === "darwin" ||
  (process.platform === "linux" && Boolean(Bun.which("bwrap")));
const body =
  "---\nname: probe\ndescription: Mounted guide probe\n---\nRead repository sources.\n";
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

async function hostFixture(emitHooks: boolean) {
  const projectRoot = await mkdtemp(
    join(tmpdir(), "sevro-guide-receipt-project-"),
  );
  const tools = await mkdtemp(join(tmpdir(), "sevro-guide-receipt-tools-"));
  roots.push(projectRoot, tools);
  const resultsRoot = join(projectRoot, "results");
  await mkdir(resultsRoot);
  const authFile = join(projectRoot, "auth.json");
  await writeFile(authFile, "synthetic-test-auth", { mode: 0o600 });
  const binary = join(tools, "fake-codex");
  const hookPeer = join(tools, "emit-hooks.ts");
  await writeFile(
    hookPeer,
    `const config = await Bun.file(process.env.CODEX_HOME + "/hooks.json").json();
for (const event of ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]) {
  const input = {hook_event_name: event, session_id: "receipt-test", tool_use_id: "read", tool_name: "reader", tool_response: ${JSON.stringify(body)}};
  const command = config.hooks[event][0].hooks[0].command;
  const child = Bun.spawn(["/bin/sh", "-c", command], {stdin: Buffer.from(JSON.stringify(input)), stdout: "pipe", stderr: "pipe"});
  if (await child.exited !== 0) process.exit(90);
}
`,
  );
  const events = [
    { type: "thread.started", thread_id: "receipt-test" },
    {
      type: "item.completed",
      item: {
        id: "read",
        type: "command_execution",
        command: "/bin/zsh -c 'cat .agents/skills/probe/SKILL.md README.md'",
        exit_code: 0,
        status: "completed",
        aggregated_output: body + "Repository documentation\n",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "missing-skill",
        type: "command_execution",
        command: "cat .agents/skills/missing/SKILL.md",
        exit_code: 1,
        status: "failed",
        aggregated_output:
          "cat: .agents/skills/missing/SKILL.md: no such file\n",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "skill-listing",
        type: "command_execution",
        command: "rg --files -g SKILL.md",
        exit_code: 0,
        status: "completed",
        aggregated_output: ".agents/skills/probe/SKILL.md\n",
      },
    },
    { type: "item.completed", item: { type: "agent_message", text: "ready" } },
    { type: "turn.completed" },
  ];
  await writeFile(
    binary,
    "#!/bin/sh\n/bin/cat >/dev/null\n" +
      (emitHooks
        ? `${shellQuote(process.execPath)} ${shellQuote(hookPeer)} || exit 90\n`
        : "") +
      "printf '%s\\n' " +
      events.map((event) => shellQuote(JSON.stringify(event))).join(" ") +
      "\n",
    { mode: 0o700 },
  );
  return { projectRoot, resultsRoot, authFile, binary };
}

test.each([
  { emitHooks: true, completeness: "complete", observedSkills: ["probe"] },
  { emitHooks: false, completeness: "partial", observedSkills: [] },
])(
  "Sevro requires hook evidence even when the event transcript contains a full skill body: $emitHooks",
  async ({ emitHooks, completeness, observedSkills }) => {
    const sandboxBinary = Bun.which("codex");
    if (!isolatedNativeHost || !sandboxBinary) return;
    const paths = await hostFixture(emitHooks);
    const host = createCodexHost({
      ...paths,
      sandboxBinary,
      model: "synthetic",
      effort: "medium",
      additionalProtectedRoots: [],
    });
    const { result } = await runEvaluation({
      projectRoot: paths.projectRoot,
      resultsRoot: paths.resultsRoot,
      host,
      case: {
        id: "batched-guide-read",
        prompt: "Read the guide and return ready.",
        fixture: {
          files: {
            ".agents/skills/probe/SKILL.md": body,
            "README.md": "Repository documentation\n",
          },
        },
        checks: [
          {
            id: "response",
            grader: "sevro.regex",
            configuration: { pattern: "^ready$" },
          },
        ],
        requiredEvidence: ["sevro.host.skill-activations"],
      },
      runnerBuildDigest: "a".repeat(64),
      projectDigest: "b".repeat(64),
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
    });
    if (emitHooks) {
      expect(result.exitCode).toBe(0);
      expect(result.task.verdict).toBe("passed");
    } else {
      expect(result.exitCode).not.toBe(0);
      expect(result.task.verdict).not.toBe("passed");
    }
    const evidence = parseRunEvidence(
      await readFile(result.evidencePath, "utf8"),
    );
    expect(
      defined(evidence.trials[0]).observations.find(
        (item) => item.id === "sevro.host.skill-activations",
      ),
    ).toMatchObject({
      id: "sevro.host.skill-activations",
      source: "sevro.host.codex",
      completeness,
      data: {
        method: "tool_result_body_match",
        observedSkills,
      },
    });
  },
  30000,
);
