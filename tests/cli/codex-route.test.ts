import { expectUnknown } from "../fixtures/assertions";
import {
  arrayContaining,
  defined,
  fixtureCase,
  objectContaining,
  parseRunEvidence,
  parseTrial,
} from "../fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isolatedNativeHost,
  semanticAdapter,
  invoke,
  installLinuxCodexHelper,
} from "../fixtures/cli-fixtures";
import { createFixture } from "../fixtures/cli-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixture = createFixture(roots);

// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("CLI runs its bundled Codex route with explicit auth and model", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const authFile = join(projectRoot, "auth.json");
  const binRoot = await mkdtemp(join(tmpdir(), "sevro-codex-bin-"));
  roots.push(binRoot);
  const binary = join(binRoot, "codex-wrapper");
  await installLinuxCodexHelper(binary, installedCodex);
  const semanticEvent = JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({
        checks: [
          {
            id: "semantic-ready",
            verdict: "pass",
            reason: "Ready is stated",
          },
        ],
      }),
    },
  });
  const advisoryEvent = JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({
        verdict: "fail",
        overallScore: 2,
        dimensions: {
          correctness: 2,
          maintainability: 3,
          testQuality: 2,
          scopeDiscipline: 4,
        },
        strengths: ["Small change"],
        weaknesses: ["Missing validation"],
        summary: "A correctness gap remains.",
      }),
    },
  });
  await writeFile(authFile, "test-only-auth\n", { mode: 0o600 });
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$1" = --version ]; then printf 'synthetic-codex\\n'; exit 0; fi
if [ "$1" = sandbox ]; then
  shift
  exec "${installedCodex}" sandbox "$@"
fi
if [ "$1" != exec ]; then exit 99; fi
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-cli"}'
for arg in "$@"; do
  if [ "$arg" = synthetic-judge ]; then
    printf '%s\\n' '${semanticEvent}'
    printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    exit 0
  fi
  if [ "$arg" = synthetic-reviewer ]; then
    printf '%s\\n' '${advisoryEvent}'
    printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":2}}'
    exit 0
  fi
done
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  const withoutAdapter = args.filter(
    (value, index) =>
      value !== "--adapter-module" && args[index - 1] !== "--adapter-module",
  );
  const codexArgs = [
    ...withoutAdapter,
    "--host",
    "codex",
    "--codex-bin",
    binary,
    "--codex-auth-file",
    authFile,
    "--model",
    "synthetic-codex",
    "--effort",
    "low",
  ];
  const run = await invoke(codexArgs);
  expect(run.code, JSON.stringify(run.result)).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  const trial = parseTrial(
    await readFile(
      defined(defined(defined(run.result.cases[0]).trials[0]).artifactPath),
      "utf8",
    ),
  );
  expect(defined(trial.evidence.routes[0])).toMatchObject({
    host: "sevro.host.codex",
    model: "synthetic-codex",
  });
  const invalid = await invoke([...args, ...codexArgs.slice(-10)]);
  expect(invalid.code).toBe(64);
  const definition = fixtureCase();
  definition.checks.push({
    id: "semantic-ready",
    grader: "sevro.semantic",
    configuration: { proposition: "The response promises readiness." },
  });
  await writeFile(caseFile, JSON.stringify(definition));
  const semanticArgs = [
    ...args,
    "--semantic-host",
    "codex",
    "--codex-bin",
    binary,
    "--codex-auth-file",
    authFile,
    "--semantic-model",
    "synthetic-judge",
    "--semantic-effort",
    "low",
  ];
  const semanticRun = await invoke(semanticArgs);
  expect(semanticRun.code).toBe(0);
  const semanticEvidence = parseRunEvidence(
    await readFile(defined(semanticRun.result.evidencePath), "utf8"),
  );
  expect(defined(semanticEvidence.routes[1])).toMatchObject({
    role: "semantic",
    host: "sevro.host.codex",
    model: "synthetic-judge",
  });
  expectUnknown(defined(semanticEvidence.trials[0]).artifactRefs).toEqual(
    arrayContaining([
      objectContaining({ id: "sevro.semantic.sevro.codex.events" }),
    ]),
  );
  definition.checks.pop();
  definition.fixture = {
    kind: "generated",
    commits: [
      {
        message: "Add baseline",
        files: {
          "README.md": "fixture\n",
          "app.ts": "export const value = 1;\n",
        },
      },
    ],
    files: { "app.ts": "export const value = 2;\n" },
  };
  await writeFile(caseFile, JSON.stringify(definition));
  const advisoryRun = await invoke([
    ...args,
    "--advisory-host",
    "codex",
    "--codex-bin",
    binary,
    "--codex-auth-file",
    authFile,
    "--advisory-model",
    "synthetic-reviewer",
    "--advisory-effort",
    "low",
  ]);
  expect(advisoryRun.code).toBe(0);
  const advisoryEvidence = parseRunEvidence(
    await readFile(defined(advisoryRun.result.evidencePath), "utf8"),
  );
  expect(defined(advisoryEvidence.routes[1])).toMatchObject({
    role: "advisory",
    host: "sevro.host.codex",
    model: "synthetic-reviewer",
  });
  expect(defined(advisoryEvidence.trials[0]).advisoryReview).toMatchObject({
    status: "completed",
    assessment: { verdict: "fail" },
  });
  const conflicting = await invoke([
    ...semanticArgs,
    "--semantic-adapter-module",
    semanticAdapter,
  ]);
  expect(conflicting.code).toBe(64);
}, 60_000);
