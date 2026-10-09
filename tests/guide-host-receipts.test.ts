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

async function hostFixture() {
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
    { type: "item.completed", item: { type: "agent_message", text: "ready" } },
    { type: "turn.completed" },
  ];
  await writeFile(
    binary,
    "#!/bin/sh\n/bin/cat >/dev/null\nprintf '%s\\n' " +
      events.map((event) => shellQuote(JSON.stringify(event))).join(" ") +
      "\n",
    { mode: 0o700 },
  );
  return { projectRoot, resultsRoot, authFile, binary };
}

test("Sevro retains complete evidence for batched mounted-skill reads", async () => {
  const sandboxBinary = Bun.which("codex");
  if (!isolatedNativeHost || !sandboxBinary) return;
  const paths = await hostFixture();
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
      requiredEvidence: ["sevro.codex.skill-reads"],
    },
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(result.exitCode).toBe(0);
  expect(result.task.verdict).toBe("passed");
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(defined(evidence.trials[0]).observations).toContainEqual({
    id: "sevro.codex.skill-reads",
    source: "sevro.host.codex",
    completeness: "complete",
    data: {
      method: "skill_file_read_probe",
      primarySkill: "probe",
      observedSkills: ["probe"],
    },
  });
}, 30000);
