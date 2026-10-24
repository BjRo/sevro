import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defined,
  expectUnknown,
  fixtureCase,
  parseRecord,
  parseRunEvidence,
} from "../../fixtures/assertions";
import { syntheticClaudeLogin } from "../../fixtures/claude-login";
import {
  createFixture,
  invoke,
  isolatedNativeHost,
} from "../../fixtures/cli-fixtures";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const fixture = createFixture(roots);

function expectedContinuationState(scenario: string) {
  return {
    completeness: scenario === "unmeasured-worktree" ? "partial" : "complete",
    data: {
      preFollowUpWorktreeUnchanged:
        scenario === "unmeasured-worktree"
          ? null
          : scenario !== "changed-worktree",
    },
  };
}

async function claudeContinuationFixture(scenario = "pass") {
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const credentialFile = join(projectRoot, "claude-credentials.json");
  const binRoot = await temporaryFixture(
    join(tmpdir(), "sevro-claude-resume-bin-"),
  );

  const binary = join(binRoot, "claude-wrapper");
  const launches = join(binRoot, "launches.txt");
  const definition = fixtureCase();
  definition.fixture = {
    kind: "generated",
    commits: [
      { message: "chore: initial", files: { "README.md": "fixture\n" } },
    ],
  };
  definition.followUpPrompt = "Resume the same task and return ready.";
  await writeFile(caseFile, JSON.stringify(definition));
  await writeFile(credentialFile, syntheticClaudeLogin(), {
    mode: 0o600,
  });
  await writeFile(
    binary,
    `#!${process.execPath}
import { appendFile, readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const scenario = ${JSON.stringify(scenario)};
const option = (name) => args[args.indexOf(name) + 1];
const resumed = args.includes("--resume");
const session = option(resumed ? "--resume" : "--session-id");
if (!/^[0-9a-f-]{36}$/.test(session)) process.exit(9);
await appendFile(${JSON.stringify(launches)}, resumed ? "resume\\n" : "initial\\n");
const state = JSON.stringify({ session, config: process.env.CLAUDE_CONFIG_DIR, settings: option("--settings"), model: option("--model"), effort: option("--effort") });
if (resumed) {
  if (await readFile(".git/session-proof", "utf8") !== state || option("-p") !== ${JSON.stringify(definition.followUpPrompt)}) process.exit(10);
} else await writeFile(".git/session-proof", state);
if (!resumed && scenario === "changed-worktree") await writeFile("README.md", "changed before feedback\\n");
if (!resumed && scenario === "unmeasured-worktree") Bun.spawnSync(["mkfifo", "unmeasured-pipe"]);
const affected = (scenario.endsWith("initial") && !resumed) || (scenario.endsWith("follow-up") && resumed);
const failed = affected && scenario.startsWith("failed-");
const event = { type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed,
  session_id: affected && scenario.startsWith("missing-") ? undefined : affected && scenario.startsWith("foreign-") ? "00000000-0000-0000-0000-000000000000" : session,
  result: resumed || failed ? "ready" : "waiting",
  usage: resumed && scenario === "incomplete-usage" ? undefined : { input_tokens: resumed ? 3 : 1, output_tokens: resumed ? 4 : 2 }, total_cost_usd: resumed ? 0.02 : 0.01 };
process.stdout.write(JSON.stringify(event) + "\\n");
if (affected && scenario.startsWith("duplicate-")) process.stdout.write(JSON.stringify(event) + "\\n");
`,
    { mode: 0o700 },
  );
  const command = args.filter(
    (value, index) =>
      value !== "--adapter-module" && args[index - 1] !== "--adapter-module",
  );
  return {
    command: [
      ...command,
      "--host",
      "claude",
      "--claude-bin",
      binary,
      "--claude-credential-file",
      credentialFile,
      "--model",
      "sonnet",
      "--effort",
      "low",
    ],
    launches,
  };
}

test("CLI resumes Claude in the same isolated session and grades its final turn", async () => {
  if (!isolatedNativeHost) return;
  const { command, launches } = await claudeContinuationFixture();
  const run = await invoke(command);
  expect(run.code, run.stderr + JSON.stringify(run.result)).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const trial = defined(evidence.trials[0]);
  const continuation = trial.observations.find(
    (item: { id: string }) => item.id === "sevro.claude.continuation",
  );
  expect(continuation).toMatchObject({
    source: "sevro.host.claude",
    completeness: "complete",
    data: { method: "same_session_resume", preFollowUpWorktreeUnchanged: true },
  });
  const initial = trial.artifactRefs.find(
    (item: { id: string }) => item.id === "sevro.claude.initial-events",
  );
  const followUp = trial.artifactRefs.find(
    (item: { id: string }) => item.id === "sevro.claude.follow-up-events",
  );
  const first = parseRecord(
    (await readFile(new URL(defined(initial).path), "utf8")).trim(),
  );
  const last = parseRecord(
    (await readFile(new URL(defined(followUp).path), "utf8")).trim(),
  );
  expect(first.result).toBe("waiting");
  expect(last.result).toBe("ready");
  expect(first.session_id).toBe(defined(continuation).data.sessionId);
  expect(last.session_id).toBe(first.session_id);
  expect(trial.usage).toMatchObject({
    inputTokens: 4,
    outputTokens: 6,
    costUsd: 0.03,
    complete: true,
  });
  expect(await readFile(launches, "utf8")).toBe("initial\nresume\n");
});

test.each([
  "failed-initial",
  "missing-initial",
  "foreign-initial",
  "duplicate-initial",
  "failed-follow-up",
  "missing-follow-up",
  "foreign-follow-up",
  "duplicate-follow-up",
])(
  "Claude continuation never grades failed or unbound native results: %s",
  async (scenario) => {
    if (!isolatedNativeHost) return;
    const { command, launches } = await claudeContinuationFixture(scenario);
    const run = await invoke(command);
    expect(run.code, scenario + JSON.stringify(run.result)).toBe(2);
    expect(run.result).toMatchObject({
      execution: { status: "failed" },
      grading: { status: "not_requested" },
      task: { verdict: "not_assessed" },
    });
    expect(await readFile(launches, "utf8")).toBe(
      scenario.endsWith("initial") ? "initial\n" : "initial\nresume\n",
    );
    const evidence = parseRunEvidence(
      await readFile(defined(run.result.evidencePath), "utf8"),
    );
    expectUnknown(
      defined(defined(run.result.cases[0]).trials[0]).checks,
    ).toEqual([]);
    const artifact = defined(evidence.trials[0]).artifactRefs.find(
      (item: { id: string }) => item.id === "sevro.claude.events",
    );
    expect(artifact).toBeDefined();
    expect(await readFile(new URL(defined(artifact).path), "utf8")).toContain(
      '"type":"result"',
    );
    if (scenario.endsWith("follow-up")) {
      expect(
        defined(evidence.trials[0]).observations.find(
          (item: { id: string }) => item.id === "sevro.claude.continuation",
        ),
      ).toMatchObject({ completeness: "partial" });
    }
  },
  10000,
);

test("CLI leaves Claude usage unmeasured when a resumed result belongs to another session", async () => {
  if (!isolatedNativeHost) return;
  const { command } = await claudeContinuationFixture("foreign-follow-up");
  const run = await invoke(command);
  expect(run.code).toBe(2);
  expect(run.result.task.verdict).toBe("not_assessed");
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expect(defined(evidence.trials[0]).usage).toMatchObject({
    complete: false,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
});

test("Claude continuation keeps workspace and usage uncertainty explicit", async () => {
  if (!isolatedNativeHost) return;
  for (const scenario of [
    "changed-worktree",
    "unmeasured-worktree",
    "incomplete-usage",
  ]) {
    const { command } = await claudeContinuationFixture(scenario);
    const run = await invoke(command);
    expect(run.code, JSON.stringify(run.result)).toBe(0);
    expect(run.result.task.verdict).toBe("passed");
    const evidence = parseRunEvidence(
      await readFile(defined(run.result.evidencePath), "utf8"),
    );
    const trial = defined(evidence.trials[0]);
    expect(
      trial.observations.find(
        (item: { id: string }) => item.id === "sevro.claude.continuation",
      ),
    ).toMatchObject(expectedContinuationState(scenario));
    if (scenario === "incomplete-usage")
      expect(trial.usage).toMatchObject({
        complete: false,
        inputTokens: null,
        outputTokens: null,
        costUsd: 0.03,
      });
  }
});
