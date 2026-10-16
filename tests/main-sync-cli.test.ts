import { expectUnknown } from "./fixtures/assertions";
import {
  defined,
  objectContaining,
  parseCliResult,
  parseRunEvidence,
  record,
  stringMatching,
} from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmod, cp } from "node:fs/promises";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function codexTimeoutArguments() {
  const root = await mkdtemp(join(tmpdir(), "sevro-cli-timeout-"));
  const binRoot = await mkdtemp(join(tmpdir(), "sevro-cli-timeout-bin-"));
  roots.push(root, binRoot);
  const binary = join(binRoot, "codex");
  await cp(join(import.meta.dir, "fixtures/app-server-peer.ts"), binary);
  await chmod(binary, 0o700);
  const credential = join(root, "auth.json");
  const declaration = join(root, "case.json");
  await writeFile(credential, "{}");
  await writeFile(
    declaration,
    JSON.stringify({
      id: "timeout",
      prompt: "Return ready",
      fixture: {
        kind: "generated",
        commits: [{ message: "Initial", files: { "README.md": "timeout" } }],
      },
      requiredEvidence: [],
      checks: [
        {
          id: "ready",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
    }),
  );
  return [
    process.execPath,
    join(import.meta.dir, "../src/cli.ts"),
    "run",
    "--json",
    "--case-file",
    declaration,
    "--project-root",
    root,
    "--results-root",
    join(root, "results"),
    "--host",
    "codex",
    "--codex-entrypoint",
    "app-server",
    "--codex-bin",
    binary,
    "--codex-auth-file",
    credential,
    "--model",
    "synthetic",
    "--effort",
    "low",
    "--condition",
    "passive",
    "--trials",
    "1",
    "--threshold",
    "1",
  ];
}

async function invokeCodexTimeout(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr, result: parseCliResult(stdout) };
}

test("public CLI selects the native Codex execution timeout", async () => {
  const args = await codexTimeoutArguments();
  const extended = await invokeCodexTimeout([
    ...args,
    "--codex-timeout-ms",
    "1200000",
  ]);
  expect(extended.code, JSON.stringify(extended.result)).toBe(0);
  expect(extended.result.task.verdict).toBe("passed");

  const bounded = await invokeCodexTimeout([
    ...args,
    "--codex-timeout-ms",
    "1",
  ]);
  expect(bounded.code, JSON.stringify(bounded.result)).toBe(2);
  expect(bounded.result.execution.status).toBe("failed");
  expect(bounded.result.task.verdict).toBe("not_assessed");
  const evidence = parseRunEvidence(
    await readFile(defined(bounded.result.evidencePath), "utf8"),
  );
  expectUnknown(defined(evidence.trials[0]).observations).toContainEqual(
    objectContaining({
      id: "sevro.host.native-goal",
      completeness: "partial",
      data: objectContaining({
        // The 1 ms bound can expire during any startup request.
        failure: stringMatching(/^App-server evaluation time bound reached/),
      }),
    }),
  );
});

test.each([
  "",
  "0",
  "-1",
  "1.5",
  "NaN",
  "Infinity",
  "1800001",
  "9007199254740993",
])(
  "public CLI refuses invalid native Codex timeout %s before a run",
  async (timeout) => {
    const args = await codexTimeoutArguments();
    const rejected = await invokeCodexTimeout([
      ...args,
      `--codex-timeout-ms=${timeout}`,
    ]);
    expect(rejected.code).toBe(64);
    expect(rejected.result).toMatchObject({
      execution: { status: "not_run" },
      evidencePath: null,
      cases: [],
    });
    expect(defined(rejected.result.diagnostic).message).toBe(
      "invalid Codex host configuration",
    );
  },
);

test.each(["exec", "app-server"])(
  "public CLI accepts the default and maximum Codex timeout for %s",
  async (entrypoint) => {
    const args = await codexTimeoutArguments();
    args[args.indexOf("--codex-entrypoint") + 1] = entrypoint;
    for (const timeout of [[], ["--codex-timeout-ms", "1800000"]]) {
      const prepared = await invokeCodexTimeout([...args, "--dry", ...timeout]);
      expect(prepared.code, JSON.stringify(prepared.result)).toBe(0);
      expect(prepared.result.execution.status).toBe("not_run");
    }
  },
);
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("public CLI records goal absence at the actual user feedback boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-main-sync-feedback-"));
  const binRoot = await mkdtemp(join(tmpdir(), "sevro-main-sync-bin-"));
  roots.push(root, binRoot);
  const binary = join(binRoot, "codex");
  await cp(join(import.meta.dir, "fixtures/app-server-peer.ts"), binary);
  await chmod(binary, 0o700);
  const credential = join(root, "auth.json"),
    declaration = join(root, "case.json");
  await writeFile(credential, "{}");
  await writeFile(
    declaration,
    JSON.stringify({
      id: "feedback",
      prompt: "Wait for a user decision",
      followUpPrompt: "User correction",
      fixture: {
        kind: "generated",
        commits: [{ message: "Initial", files: { "feedback.txt": "wait" } }],
      },
      requiredEvidence: [],
      checks: [
        {
          id: "ready",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
    }),
  );
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "../src/cli.ts"),
    "run",
    "--json",
    "--case-file",
    declaration,
    "--project-root",
    root,
    "--results-root",
    join(root, "results"),
    "--host",
    "codex",
    "--codex-entrypoint",
    "app-server",
    "--codex-bin",
    binary,
    "--codex-auth-file",
    credential,
    "--model",
    "synthetic",
    "--effort",
    "low",
    "--condition",
    "passive",
    "--trials",
    "1",
    "--threshold",
    "1",
  ]);
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const result = parseCliResult(out);
  expect(code, out + err).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(result.evidencePath), "utf8"),
  );
  expectUnknown(defined(evidence.trials[0]).observations).toContainEqual(
    objectContaining({
      id: "sevro.codex.continuation",
      completeness: "complete",
      data: objectContaining({
        nativeGoalObserved: false,
        nativeGoalStatus: null,
      }),
    }),
  );
  expectUnknown(defined(evidence.trials[0]).observations).toContainEqual(
    objectContaining({
      id: "sevro.host.native-goal",
      data: objectContaining({ clientTurns: 2, goalStatus: "complete" }),
    }),
  );
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("public CLI retains failed app-server evidence without passing the task", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-main-sync-failure-"));
  const binRoot = await mkdtemp(join(tmpdir(), "sevro-main-sync-bin-"));
  roots.push(root, binRoot);
  const binary = join(binRoot, "codex");
  await cp(join(import.meta.dir, "fixtures/app-server-peer.ts"), binary);
  await chmod(binary, 0o700);
  const credential = join(root, "auth.json"),
    declaration = join(root, "case.json");
  await writeFile(credential, "{}");
  await writeFile(
    declaration,
    JSON.stringify({
      id: "failure",
      prompt: "Return ready",
      fixture: {
        kind: "generated",
        commits: [{ message: "Initial", files: { "failure.txt": "fatal" } }],
      },
      requiredEvidence: [],
      checks: [
        {
          id: "ready",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
    }),
  );
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "../src/cli.ts"),
    "run",
    "--json",
    "--case-file",
    declaration,
    "--project-root",
    root,
    "--results-root",
    join(root, "results"),
    "--host",
    "codex",
    "--codex-entrypoint",
    "app-server",
    "--codex-bin",
    binary,
    "--codex-auth-file",
    credential,
    "--model",
    "synthetic",
    "--effort",
    "low",
    "--condition",
    "passive",
    "--trials",
    "1",
    "--threshold",
    "1",
  ]);
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const result = parseCliResult(out);
  expect(code, out + err).toBe(2);
  expect(result).toMatchObject({
    execution: { status: "failed" },
    task: { verdict: "not_assessed" },
  });
  const evidence = parseRunEvidence(
    await readFile(defined(result.evidencePath), "utf8"),
  );
  expectUnknown(defined(evidence.trials[0]).observations).toContainEqual(
    objectContaining({
      id: "sevro.host.native-goal",
      completeness: "partial",
      data: objectContaining({
        failure: "App-server reported a fatal turn error",
        errors: [objectContaining({ code: "unauthorized" })],
      }),
    }),
  );
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("public CLI observes Codex native continuation without sending extra turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-main-sync-server-"));
  const binRoot = await mkdtemp(join(tmpdir(), "sevro-main-sync-bin-"));
  roots.push(root, binRoot);
  const binary = join(binRoot, "codex");
  await cp(join(import.meta.dir, "fixtures/app-server-peer.ts"), binary);
  await chmod(binary, 0o700);
  const credential = join(root, "auth.json"),
    declaration = join(root, "case.json");
  await writeFile(credential, "{}");
  await writeFile(
    declaration,
    JSON.stringify({
      id: "goal",
      prompt: "Return ready",
      fixture: {
        kind: "generated",
        commits: [{ message: "Initial", files: { "README.md": "fixture" } }],
      },
      requiredEvidence: [],
      checks: [
        {
          id: "ready",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
    }),
  );
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "../src/cli.ts"),
    "run",
    "--json",
    "--case-file",
    declaration,
    "--project-root",
    root,
    "--results-root",
    join(root, "results"),
    "--host",
    "codex",
    "--codex-entrypoint",
    "app-server",
    "--codex-bin",
    binary,
    "--codex-auth-file",
    credential,
    "--model",
    "synthetic",
    "--effort",
    "low",
    "--condition",
    "passive",
    "--trials",
    "1",
    "--threshold",
    "1",
  ]);
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const result = parseCliResult(out);
  expect(code, out + err).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(result.evidencePath), "utf8"),
  );
  expectUnknown(defined(evidence.trials[0]).observations).toContainEqual(
    objectContaining({
      id: "sevro.host.native-goal",
      completeness: "complete",
      data: objectContaining({
        threadId: "root",
        goalStatus: "complete",
        finalTurnId: "native-2",
        clientTurns: 1,
      }),
    }),
  );
  expect(
    record(record(evidence.configuration.redacted.hostConfiguration).candidate)[
      "sevro.codex.entrypoint"
    ],
  ).toBe("app-server");
  expect(JSON.stringify(evidence)).not.toContain("PRIVATE_GOAL_OBJECTIVE");
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("public CLI retains Claude native goal facts without the objective", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-main-sync-claude-"));
  roots.push(root);
  const binRoot = await mkdtemp(join(tmpdir(), "sevro-main-sync-bin-"));
  roots.push(binRoot);
  const binary = join(binRoot, "claude");
  const credential = join(root, "credential.json");
  const declaration = join(root, "case.json");
  await writeFile(credential, "{}");
  await writeFile(
    binary,
    `#!/usr/bin/env bun
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
const id = "11111111-1111-1111-1111-111111111111";
const directory = join(process.env.CLAUDE_CONFIG_DIR, "projects", "fixture");
await mkdir(directory, {recursive:true});
await writeFile(join(directory,id+".jsonl"), JSON.stringify({type:"attachment",sessionId:id,attachment:{type:"goal_status",condition:"PRIVATE_GOAL_OBJECTIVE",met:true}})+"\\n");
console.log(JSON.stringify({type:"system",subtype:"init",session_id:id}));
console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:id,result:"ready"}));
`,
    { mode: 0o700 },
  );
  await writeFile(
    declaration,
    JSON.stringify({
      id: "goal",
      prompt: "Return ready",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "ready",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
    }),
  );
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "../src/cli.ts"),
    "run",
    "--json",
    "--case-file",
    declaration,
    "--project-root",
    root,
    "--results-root",
    join(root, "results"),
    "--host",
    "claude",
    "--claude-bin",
    binary,
    "--claude-credential-file",
    credential,
    "--model",
    "synthetic",
    "--effort",
    "low",
    "--condition",
    "passive",
    "--trials",
    "1",
    "--threshold",
    "1",
  ]);
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const result = parseCliResult(out);
  const evidence = parseRunEvidence(
    await readFile(defined(result.evidencePath), "utf8"),
  );
  expect(code, out + err + JSON.stringify(evidence.diagnostic)).toBe(0);
  const observation = defined(evidence.trials[0]).observations.find(
    (row: { id: string }) => row.id === "sevro.host.native-goal",
  );
  expect(observation).toMatchObject({
    source: "sevro.host.claude",
    completeness: "complete",
    data: {
      threadId: "11111111-1111-1111-1111-111111111111",
      goalStatus: "complete",
      goals: [{ status: "complete", characters: 22 }],
    },
  });
  expect(JSON.stringify(evidence)).not.toContain("PRIVATE_GOAL_OBJECTIVE");
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("public CLI grades a saved artifact independently of the final response", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-main-sync-"));
  roots.push(root);
  const candidate = join(root, "candidate.ts");
  const grader = join(root, "grader.ts");
  const declaration = join(root, "case.json");
  await writeFile(
    candidate,
    `export default { id: "test.candidate", model: "test", effort: "none", async run() { return { finalMessage: "The artifact is correct.", complete: true }; } };`,
  );
  await writeFile(
    grader,
    `export default { id: "test.grader", model: "test", effort: "none", async run({prompt}) {
    const source = prompt.match(/<candidate-(?:response|document)-json>\\n([^\\n]+)\\n/);
    const content = source ? JSON.parse(source[1]) : null;
    const artifact = prompt.includes('"id":"artifact"');
    return { complete: true, finalMessage: JSON.stringify({checks: [{id: artifact ? "artifact" : "response", verdict: content === (artifact ? "wrong artifact\\n" : "The artifact is correct.") ? (artifact ? "fail" : "pass") : "pass", reason: "Compared the declared source"}]}) };
  } };`,
  );
  await writeFile(
    declaration,
    JSON.stringify({
      id: "artifact",
      prompt: "Inspect the document",
      fixture: { files: { "notes/final-123.md": "wrong artifact\n" } },
      requiredEvidence: [],
      checks: [
        {
          id: "response",
          grader: "sevro.semantic",
          configuration: { proposition: "The response claims correctness." },
        },
        {
          id: "artifact",
          grader: "sevro.semantic",
          configuration: {
            proposition: "The artifact meets the requirement.",
            artifactPath: "notes/final-*.md",
          },
        },
      ],
    }),
  );
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "../src/cli.ts"),
    "run",
    "--json",
    "--project-root",
    root,
    "--results-root",
    join(root, "results"),
    "--case-file",
    declaration,
    "--adapter-module",
    candidate,
    "--semantic-adapter-module",
    grader,
    "--condition",
    "passive",
    "--trials",
    "1",
    "--threshold",
    "1",
  ]);
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const result = parseCliResult(out);
  expect(code, out + err).toBe(1);
  expect(result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "completed" },
    task: { verdict: "failed" },
  });
  expectUnknown(
    defined(defined(result.cases[0]).trials[0]).checks,
  ).toContainEqual(objectContaining({ id: "response", status: "passed" }));
  expectUnknown(
    defined(defined(result.cases[0]).trials[0]).checks,
  ).toContainEqual(objectContaining({ id: "artifact", status: "failed" }));
  const evidence = parseRunEvidence(
    await readFile(defined(result.evidencePath), "utf8"),
  );
  expectUnknown(defined(evidence.trials[0]).observations).toContainEqual(
    objectContaining({
      data: objectContaining({
        source: objectContaining({
          kind: "artifact",
          path: "notes/final-123.md",
        }),
      }),
    }),
  );
});
