import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeHost } from "../../src/hosts/claude";
import { nativeStateParent } from "../../src/native-transcript-state";
import { randomUUID } from "node:crypto";
import {
  loadRuntimeConfiguration,
  runEvaluation,
  type HostAdapter,
  type EvaluationOptions,
} from "../../src/engine";
import { parseRunEvidence } from "../fixtures/assertions";
import { defined } from "../fixtures/assertions";
import {
  artifactEvaluation,
  waitForNativeCommand,
} from "../fixtures/runtime-host-fixtures";
import { createCodexFixture } from "../fixtures/runtime-host-fixtures";
import {
  createEvaluation,
  createSetupEvaluation,
} from "../fixtures/evaluation-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const codexFixture = createCodexFixture(roots);
const setupEvaluation = createSetupEvaluation(createEvaluation(roots));

test("fixture setup seeds a passed Review in the candidate HOME", async () => {
  const { host } = await codexFixture(
    '/bin/cat "$HOME/.darrow/reviews/prior.json"; test "$HOME" = "$(cat setup-home)" && test ! -d "$(cat setup-temp)"',
  );
  const checks: EvaluationOptions["case"]["checks"] = [
    {
      id: "candidate-read",
      grader: "sevro.regex",
      configuration: { pattern: "^passed$" },
    },
    {
      id: "prior-review",
      grader: "sevro.shell",
      configuration: {
        run: 'cat "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/prior.json"; ! printf changed > "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/prior.json"',
        expectExact: "passed",
      },
    },
  ];
  const options = await setupEvaluation(
    [
      "/bin/sh",
      "-c",
      'mkdir -p "$HOME/.darrow/reviews"; printf passed > "$HOME/.darrow/reviews/prior.json"; printf "%s" "$HOME" > setup-home; printf "%s" "$TMPDIR" > setup-temp',
    ],
    {},
    checks,
  );
  const homes = new Set<string>();
  options.trialCount = 2;
  options.jobs = 2;
  options.host = {
    ...host,
    async run(request) {
      homes.add(await readFile(join(request.workspace, "setup-home"), "utf8"));
      const result = await host.run(request);
      return {
        ...result,
        observations: [
          ...(result.observations ?? []),
          { id: "example.evidence", completeness: "complete", data: {} },
        ],
      };
    },
  };
  options.runtimePolicy = {
    format: "sevro.runtime.v1",
    environment: {},
    readOnlyRoots: [],
    artifactDirectories: [{ name: "reviews", path: ".darrow/reviews" }],
  };
  options.shellIsolation = { protectedRoots: [] };
  const { result } = await runEvaluation(options);
  expect(result.execution.status).toBe("completed");
  expect(result.grading.status).toBe("completed");
  expect(result.task.verdict).toBe("passed");
  expect(result.exitCode).toBe(0);
  expect(homes.size).toBe(2);
  for (const home of homes) expect(existsSync(home)).toBe(false);
});

test.each([false, true])(
  "fixture setup shares candidate HOME without artifact grants: runtime policy %s",
  async (configured) => {
    const { host } = await codexFixture(
      '/bin/cat "$HOME/prior-review"; test "$HOME" = "$(cat setup-home)"',
    );
    const options = await setupEvaluation(
      [
        "/bin/sh",
        "-c",
        'printf passed > "$HOME/prior-review"; printf "%s" "$HOME" > setup-home',
      ],
      {},
      [
        {
          id: "candidate-read",
          grader: "sevro.regex",
          configuration: { pattern: "^passed$" },
        },
      ],
    );
    let home = "";
    options.host = {
      ...host,
      async run(request) {
        home = await readFile(join(request.workspace, "setup-home"), "utf8");
        const result = await host.run(request);
        return {
          ...result,
          observations: [
            ...(result.observations ?? []),
            { id: "example.evidence", completeness: "complete", data: {} },
          ],
        };
      },
    };
    if (configured)
      options.runtimePolicy = {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
      };
    const { result } = await runEvaluation(options);
    expect(result.task.verdict).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(existsSync(home)).toBe(false);
  },
);

test.each([false, true])(
  "setup initializes empty Review evidence for ordinary grading: report required %s",
  async (required) => {
    const { host } = await codexFixture("printf ready");
    const check = {
      id: "review-state",
      grader: "sevro.shell",
      configuration: {
        run: required
          ? 'test -f "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/report.json"'
          : 'test -d "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS" && test -z "$(ls -A "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS")"',
      },
    };
    const options = await setupEvaluation(
      ["/bin/sh", "-c", 'mkdir -p "$HOME/.darrow/reviews"'],
      {},
      [check],
    );
    options.host = {
      ...host,
      async run(request) {
        const result = await host.run(request);
        return {
          ...result,
          observations: [
            { id: "example.evidence", completeness: "complete", data: {} },
          ],
        };
      },
    };
    options.runtimePolicy = {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      artifactDirectories: [{ name: "reviews", path: ".darrow/reviews" }],
    };
    options.shellIsolation = { protectedRoots: [] };
    const { result } = await runEvaluation(options);
    expect(result.execution.status).toBe("completed");
    expect(result.grading.status).toBe("completed");
    const verdict = required ? "failed" : "passed";
    expect(result.task.verdict).toBe(verdict);
    expect(result.exitCode).toBe(required ? 1 : 0);
    expect(
      defined(defined(result.cases[0]).trials[0]).checks.find(
        ({ id }) => id === check.id,
      )?.status,
    ).toBe(verdict);
  },
);

test.each(["failure", "cancelled", "dry"] as const)(
  "setup candidate HOME is cleaned after preparation %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "sevro-setup-home-cleanup-"));
    roots.push(root);
    const receipt = join(root, "setup-home");
    const scripts = {
      failure: "exit 17",
      cancelled: "sleep 30",
      dry: "exit 0",
    };
    const options = await setupEvaluation([
      "/bin/sh",
      "-c",
      `printf '%s' "$HOME" > "$1"; ${scripts[mode]}`,
      "setup",
      receipt,
    ]);
    const controller = new AbortController();
    options.signal = controller.signal;
    options.dry = mode === "dry";
    let calls = 0;
    options.host.run = () => {
      calls++;
      return Promise.resolve({ finalMessage: "ready", complete: true });
    };
    const pending = runEvaluation(options);
    if (mode === "failure") {
      expect(pending).rejects.toThrow("fixture setup failed (17)");
      await pending.catch(() => undefined);
    } else {
      if (mode === "cancelled") {
        await waitForNativeCommand(receipt);
        controller.abort();
      }
      const { result } = await pending;
      expect(result.execution.status).toBe(
        mode === "dry" ? "not_run" : "cancelled",
      );
    }
    expect(calls).toBe(0);
    const home = await readFile(receipt, "utf8");
    expect(home).not.toBe(process.env.HOME);
    expect(existsSync(home)).toBe(false);
  },
);

test("runtime configuration declares named candidate-home artifact directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-artifact-config-"));
  roots.push(root);
  const artifactDirectories = [{ name: "reviews", path: ".darrow/reviews" }];
  await writeFile(
    join(root, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      runtime: { artifactDirectories },
    }),
  );
  const policy = defined(await loadRuntimeConfiguration(root));
  expect(policy.artifactDirectories).toEqual(artifactDirectories);
});

test("evaluation keeps candidate review artifacts readable through isolated grading", async () => {
  const { host, root } = await codexFixture(
    '/bin/mkdir -p "$HOME/.darrow/reviews"; printf review > "$HOME/.darrow/reviews/result"; printf private > "$HOME/private-sibling"; printf "%s" "$HOME" > runtime-home; /bin/cat "$HOME/.darrow/reviews/result"',
  );
  let candidateHome = "";
  const candidate: HostAdapter = {
    ...host,
    async run(request) {
      const result = await host.run(request);
      candidateHome = await readFile(
        join(request.workspace, "runtime-home"),
        "utf8",
      );
      return result;
    },
  };
  const runtimePolicy = {
    format: "sevro.runtime.v1" as const,
    environment: {},
    readOnlyRoots: [],
    artifactDirectories: [{ name: "reviews", path: ".darrow/reviews" }],
  };
  const { result } = await runEvaluation({
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host: candidate,
    runtimePolicy,
    shellIsolation: { protectedRoots: [] },
    case: {
      id: "candidate-review-artifacts",
      prompt: "Create private review evidence.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "read-review",
          grader: "sevro.shell",
          configuration: {
            // Linux may list synthetic mount ancestors, but no private sibling.
            run: 'test "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS" = "$(cat runtime-home)/.darrow/reviews" && cat "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result" && ! printf changed > "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result" && ! touch "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/new" && ! rm "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result" && ! mv "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result" moved && ! cat "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/../../private-sibling" && ! ls -A "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/../.." 2>/dev/null | grep -Fq private-sibling',
            expectExact: "review",
          },
        },
      ],
    },
  });
  expect(result.exitCode).toBe(0);
  expect(result.task.verdict).toBe("passed");
  expect(candidateHome.startsWith(`${root}/`)).toBe(false);
  expect(
    await Bun.file(join(candidateHome, ".darrow/reviews/result")).exists(),
  ).toBe(false);
});

test.each([
  "success",
  "grader-failure",
  "grader-timeout",
  "candidate-failure",
  "cancelled",
  "throw-after-host",
] as const)(
  "candidate artifact runtime cleanup covers %s",
  async (mode) => {
    const { host, root } = await codexFixture(
      '/bin/mkdir -p "$HOME/.darrow/reviews"; printf review > "$HOME/.darrow/reviews/result"; printf "%s" "$HOME" > runtime-home; printf review',
    );
    const controller = new AbortController();
    let home = "";
    let runtime = "";
    const candidate: HostAdapter = {
      ...host,
      async run(request) {
        runtime = defined(request.candidateRuntimeRoot);
        const result = await host.run(request);
        home = await readFile(join(request.workspace, "runtime-home"), "utf8");
        expect(
          await Bun.file(join(home, ".darrow/reviews/result")).exists(),
        ).toBe(true);
        if (mode === "cancelled") controller.abort();
        if (mode === "throw-after-host")
          throw new Error("Host result transport failed");
        return { ...result, executionFailed: mode === "candidate-failure" };
      },
    };
    const run =
      mode === "grader-timeout"
        ? "sleep 5"
        : `exit ${mode === "grader-failure" ? "1" : "0"}`;
    const { result } = await artifactEvaluation(root, candidate, {
      signal: controller.signal,
      case: {
        id: "cleanup",
        prompt: "Create review state.",
        fixture: { files: {} },
        requiredEvidence: [],
        checks: [
          {
            id: "cleanup",
            grader: "sevro.shell",
            configuration: { run, timeoutMs: 100 },
          },
        ],
      },
    });
    const expected = {
      success: 0,
      "grader-failure": 1,
      "grader-timeout": 3,
      "candidate-failure": 2,
      cancelled: 2,
      "throw-after-host": 2,
    };
    expect(result.exitCode).toBe(expected[mode]);
    expect(await Bun.file(join(home, ".darrow/reviews/result")).exists()).toBe(
      false,
    );
    expect(existsSync(runtime)).toBe(false);
  },
  30000,
);

test.each([
  "missing",
  "root-link",
  "ancestor-link",
  "descendant-link",
  "hardlink",
  "fifo",
] as const)(
  "candidate artifact grants refuse unsafe or missing trees: %s",
  async (kind) => {
    const command = {
      missing: "printf missing",
      "root-link":
        '/bin/mkdir -p "$HOME/other" "$HOME/.darrow"; ln -s "$HOME/other" "$HOME/.darrow/reviews"; printf linked',
      "ancestor-link":
        '/bin/mkdir -p "$HOME/other/reviews"; ln -s "$HOME/other" "$HOME/.darrow"; printf linked',
      "descendant-link":
        '/bin/mkdir -p "$HOME/.darrow/reviews"; printf secret > "$HOME/private"; ln -s "$HOME/private" "$HOME/.darrow/reviews/result"; printf linked',
      hardlink:
        '/bin/mkdir -p "$HOME/.darrow/reviews"; printf secret > "$HOME/private"; ln "$HOME/private" "$HOME/.darrow/reviews/result"; printf linked',
      fifo: '/bin/mkdir -p "$HOME/.darrow/reviews"; mkfifo "$HOME/.darrow/reviews/result"; printf special',
    }[kind];
    const { host, root } = await codexFixture(command);
    const { result } = await artifactEvaluation(root, host);
    expect(result.execution.status).toBe("completed");
    expect(result.grading.status).toBe("error");
    expect(result.task.verdict).toBe("not_assessed");
    expect(result.diagnostic?.message).toBe(
      "candidate artifact directories are missing or unsafe",
    );
  },
  30000,
);

test.each([
  ".",
  "..",
  "../private",
  "/",
  "/tmp/private",
  "home//reviews",
  "home/./reviews",
  "home/../reviews",
  "home\\reviews",
  "reviews\n",
])("runtime artifact declarations refuse unbounded paths: %j", async (path) => {
  const { host, root } = await codexFixture();
  expect(
    artifactEvaluation(root, host, {
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        artifactDirectories: [{ name: "reviews", path }],
      },
    }),
  ).rejects.toThrow(/runtime artifact directory/);
  expect(await readdir(join(root, "results"))).toEqual([]);
});

test.each(
  [false, true].flatMap((nativeTranscripts) =>
    [false, true].map((codexState) => ({ nativeTranscripts, codexState })),
  ),
)(
  "native Codex grading reads candidate artifacts with transcripts $nativeTranscripts, Codex state $codexState",
  // eslint-disable-next-line max-lines-per-function -- Keep the real candidate, both grader roles and evidence assertions together.
  async function verifyCodexArtifactGrading({ nativeTranscripts, codexState }) {
    const { host, root } = await codexFixture(
      'if test -n "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS"; then if test -n "$SEVRO_CANDIDATE_ARTIFACT_CODEX_CONFIG"; then test "$SEVRO_CANDIDATE_ARTIFACT_CODEX_CONFIG" != "$CODEX_HOME/config.toml" || exit 82; test -s "$SEVRO_CANDIDATE_ARTIFACT_CODEX_CONFIG" || exit 83; test "$(cat "$SEVRO_CANDIDATE_ARTIFACT_CODEX_SKILLS/new/SKILL.md")" = skill || exit 84; ! printf changed > "$SEVRO_CANDIDATE_ARTIFACT_CODEX_CONFIG" || exit 85; ! cat "$SEVRO_CANDIDATE_ARTIFACT_CODEX_SKILLS/../auth.json" || exit 86; fi; test "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS" != "$HOME/.darrow/reviews"; printf writable > "$HOME/own-state"; /bin/cat "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result"; ! printf changed > "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result"; else if test -n "$SEVRO_CODEX_AGENT_SKILLS"; then /bin/mkdir -p "$CODEX_HOME/skills/new"; printf skill > "$CODEX_HOME/skills/new/SKILL.md"; printf "%s" "$CODEX_HOME" > native-home; fi; /bin/mkdir -p "$HOME/.darrow/reviews"; printf review > "$HOME/.darrow/reviews/result"; printf review; fi',
    );
    let candidateHome = "";
    const candidate: HostAdapter = {
      ...host,
      async run(request) {
        const response = await host.run(request);
        if (codexState)
          candidateHome = await readFile(
            join(request.workspace, "native-home"),
            "utf8",
          );
        return response;
      },
    };
    const roles: string[] = [];
    const gradingHost: HostAdapter = {
      ...host,
      async run(request) {
        expect(request.candidateRuntimeRoot).toBeUndefined();
        const roots = defined(request.candidateArtifactRoots);
        if (codexState) {
          expect(roots.codex_config).toBe(join(candidateHome, "config.toml"));
          expect(roots.codex_skills).toBe(join(candidateHome, "skills"));
        }
        const native = await host.run(request);
        expect(native.finalMessage).toBe("review");
        expect(
          await readFile(join(defined(roots.reviews), "result"), "utf8"),
        ).toBe("review");
        roles.push(defined(request.runtimeRole));
        const finalMessage =
          request.runtimeRole === "advisory"
            ? {
                verdict: "pass",
                overallScore: 5,
                dimensions: {
                  correctness: 5,
                  maintainability: 5,
                  testQuality: 5,
                  scopeDiscipline: 5,
                },
                strengths: [],
                weaknesses: [],
                summary: "Evidence remains read-only",
              }
            : {
                checks: [
                  {
                    id: "semantic-review",
                    verdict: "pass",
                    reason: "Read actual candidate evidence",
                  },
                ],
              };
        return { ...native, finalMessage: JSON.stringify(finalMessage) };
      },
    };
    const { result } = await artifactEvaluation(root, candidate, {
      semanticHost: gradingHost,
      advisoryHost: gradingHost,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        nativeTranscripts,
        codexState,
        artifactDirectories: [{ name: "reviews", path: ".darrow/reviews" }],
      },
      case: {
        id: "native-artifact-graders",
        prompt: "Create evidence.",
        requiredEvidence: [],
        fixture: {
          kind: "generated",
          commits: [
            { message: "baseline", files: { "README.md": "baseline" } },
          ],
        },
        checks: [
          {
            id: "semantic-review",
            grader: "sevro.semantic",
            configuration: { proposition: "Candidate review exists" },
          },
        ],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(roles).toEqual(["semantic", "advisory"]);
    const evidence = parseRunEvidence(
      await readFile(result.evidencePath, "utf8"),
    );
    expect(defined(evidence.trials[0]).advisoryReview?.status).toBe(
      "completed",
    );
  },
);

test("artifact grants remain absent without evaluator opt-in", async () => {
  const { host, root } = await codexFixture(
    '/bin/mkdir -p "$HOME/.darrow/reviews"; printf review > "$HOME/.darrow/reviews/result"; printf "%s" "$HOME" > runtime-home; printf review',
  );
  const { result } = await artifactEvaluation(root, host, {
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
    },
    case: {
      id: "no-grant",
      prompt: "Write evidence.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "denied",
          grader: "sevro.shell",
          configuration: {
            run: 'test -z "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS"; ! cat "$(cat runtime-home)/.darrow/reviews/result"',
          },
        },
      ],
    },
  });
  expect(result.exitCode).toBe(0);
});

test("candidate artifact runtime is removed when evidence persistence fails", async () => {
  const { host, root } = await codexFixture(
    '/bin/mkdir -p "$HOME/.darrow/reviews"; printf review > "$HOME/.darrow/reviews/result"; printf review',
  );
  let runtime = "";
  const failing: HostAdapter = {
    ...host,
    async run(request) {
      runtime = defined(request.candidateRuntimeRoot);
      const result = await host.run(request);
      await rm(join(root, "results"), { recursive: true, force: true });
      await writeFile(join(root, "results"), "output storage unavailable");
      return result;
    },
  };
  let failure: unknown;
  try {
    await artifactEvaluation(root, failing);
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/trial persistence failed/);
  expect(existsSync(runtime)).toBe(false);
});

test.each(["runtime", "artifact"] as const)(
  "native hosts refuse a forged candidate %s path",
  async (kind) => {
    const { host, root, workspace } = await codexFixture();
    const request =
      kind === "runtime"
        ? { candidateRuntimeRoot: root }
        : { candidateArtifactRoots: { reviews: root } };
    expect(
      host.run({
        prompt: "Do not start",
        workspace,
        condition: "passive",
        ...request,
      }),
    ).rejects.toThrow(/current trial|active trial/);
  },
);

test.each([false, true])(
  "Claude candidate artifacts survive through shell and semantic grading: transcripts %s",
  // eslint-disable-next-line max-lines-per-function -- Keep the native protocol fixture, isolated shell check and semantic handoff together.
  async function verifyClaudeArtifactGrading(nativeTranscripts) {
    const { root } = await codexFixture();
    const binary = join(root, "claude-artifacts");
    await writeFile(
      binary,
      `#!${process.execPath}
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const home = process.env.HOME;
const path = process.env.SEVRO_CANDIDATE_ARTIFACT_REVIEWS;
let result = 'review';
if (path) {
  const settings = await Bun.file(process.argv[process.argv.indexOf('--settings') + 1]).json();
  const fs = settings.sandbox.filesystem;
  if (!fs.allowRead.includes(path) || !fs.denyWrite.includes(path) || !settings.permissions.additionalDirectories.includes(path) || !settings.permissions.deny.includes('Edit(/' + path + '/**)') || path === join(home, '.darrow/reviews')) result = 'invalid grants';
  if (await readFile(join(path, 'result'), 'utf8') !== 'review') result = 'wrong evidence';
} else {
  await mkdir(join(home, '.darrow/reviews'), { recursive: true });
  await writeFile(join(home, '.darrow/reviews/result'), 'review');
  await writeFile('runtime-home', home);
}
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result }));
`,
      { mode: 0o700 },
    );
    const credentialFile = join(root, "claude-credential.json");
    await writeFile(credentialFile, "{}");
    const host = createClaudeHost({
      binary,
      credentialFile,
      model: "fixture",
      effort: "low",
      projectRoot: join(root, "project"),
      resultsRoot: join(root, "results"),
      additionalProtectedRoots: [],
    });
    let home = "";
    const candidate: HostAdapter = {
      ...host,
      async run(request) {
        const result = await host.run(request);
        home = await readFile(join(request.workspace, "runtime-home"), "utf8");
        expect(
          await readFile(join(home, ".darrow/reviews/result"), "utf8"),
        ).toBe("review");
        return result;
      },
    };
    const semanticHost: HostAdapter = {
      ...host,
      async run(request) {
        const result = await host.run(request);
        expect(result.finalMessage).toBe("review");
        return {
          ...result,
          finalMessage: JSON.stringify({
            checks: [
              {
                id: "meaning",
                verdict: "pass",
                reason: "Original artifact available",
              },
            ],
          }),
        };
      },
    };
    const { result } = await artifactEvaluation(root, candidate, {
      semanticHost,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        nativeTranscripts,
        artifactDirectories: [{ name: "reviews", path: ".darrow/reviews" }],
      },
      case: {
        id: "claude-artifacts",
        prompt: "Create review evidence.",
        fixture: { files: {} },
        requiredEvidence: [],
        checks: [
          {
            id: "shell",
            grader: "sevro.shell",
            configuration: {
              run: 'cat "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result"; ! printf changed > "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result"',
              expectExact: "review",
            },
          },
          {
            id: "meaning",
            grader: "sevro.semantic",
            configuration: { proposition: "Review exists" },
          },
        ],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(home.startsWith(`${root}/`)).toBe(false);
    expect(await Bun.file(join(home, ".darrow/reviews/result")).exists()).toBe(
      false,
    );
  },
);

test.each(
  [
    [{ name: "reviews", path: "" }],
    [{ name: "Reviews", path: ".darrow/reviews" }],
    [{ name: "review-name", path: ".darrow/reviews" }],
    [{ name: "r".repeat(65), path: ".darrow/reviews" }],
    [{ name: "reviews", path: "r".repeat(4097) }],
    [
      { name: "reviews", path: ".darrow/reviews" },
      { name: "reviews", path: "other" },
    ],
    Array.from({ length: 17 }, (_, i) => ({
      name: `artifact${i}`,
      path: `artifacts/${i}`,
    })),
  ].map((artifactDirectories, index) => ({ artifactDirectories, index })),
)(
  "artifact directory declarations fail before execution: case $index",
  async ({ artifactDirectories }) => {
    const { host, root } = await codexFixture();
    expect(
      artifactEvaluation(root, host, {
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
          artifactDirectories,
        },
      }),
    ).rejects.toThrow(/runtime artifact director/);
    expect(await readdir(join(root, "results"))).toEqual([]);
  },
);

test("candidate artifact tree entry limit fails grading without exposing the tree", async () => {
  const { host, root } = await codexFixture(
    '/bin/mkdir -p "$HOME/.darrow/reviews"; n=0; while test "$n" -lt 16384; do : > "$HOME/.darrow/reviews/$n"; n=$((n + 1)); done; printf ready',
  );
  const { result } = await artifactEvaluation(root, host);
  expect(result.grading.status).toBe("error");
  expect(result.exitCode).toBe(3);
}, 30000);

test("artifact grader cannot read native peer state created after launch", async () => {
  const peer = join(await nativeStateParent(), `artifact-peer-${randomUUID()}`);
  roots.push(peer);
  const { host, root } = await codexFixture(
    'if test -n "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS"; then printf ready > native-ready; while ! test -f native-go; do sleep 0.01; done; if /bin/cat "$PEER_READ/secret" >/dev/null 2>&1 || printf changed > "$PEER_READ/secret" 2>/dev/null; then printf exposed; else /bin/cat "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result"; fi; else /bin/mkdir -p "$HOME/.darrow/reviews"; printf review > "$HOME/.darrow/reviews/result"; printf review; fi',
  );
  const semanticHost: HostAdapter = {
    ...host,
    async run(request) {
      const running = host.run(request);
      await waitForNativeCommand(join(request.workspace, "native-ready"));
      await mkdir(peer, { mode: 0o700 });
      await writeFile(join(peer, "secret"), "private peer evidence");
      await writeFile(join(request.workspace, "native-go"), "continue");
      const result = await running;
      expect(result.finalMessage).toBe("review");
      return {
        ...result,
        finalMessage: JSON.stringify({
          checks: [
            { id: "peer", verdict: "pass", reason: "Peer remains denied" },
          ],
        }),
      };
    },
  };
  const { result } = await artifactEvaluation(root, host, {
    semanticHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { PEER_READ: peer },
      readOnlyRoots: [],
      artifactDirectories: [{ name: "reviews", path: ".darrow/reviews" }],
    },
    case: {
      id: "future-artifact-peer",
      prompt: "Prepare artifacts.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "peer",
          grader: "sevro.semantic",
          configuration: {
            proposition: "Read artifact without accessing peers",
          },
        },
      ],
    },
  });
  expect(result.exitCode).toBe(0);
  expect(await readFile(join(peer, "secret"), "utf8")).toBe(
    "private peer evidence",
  );
}, 30000);

test("candidate artifact declarations are snapshotted and temporary roots stay outside identity", async () => {
  const { host, root } = await codexFixture(
    '/bin/mkdir -p "$HOME/.darrow/reviews"; printf review > "$HOME/.darrow/reviews/result"; printf review',
  );
  const runtimePolicy = {
    format: "sevro.runtime.v1" as const,
    environment: {},
    readOnlyRoots: [],
    artifactDirectories: [{ name: "reviews", path: ".darrow/reviews" }],
  };
  const candidate: HostAdapter = {
    ...host,
    run(request) {
      const directory = defined(runtimePolicy.artifactDirectories[0]);
      directory.path = "changed-after-snapshot";
      return host.run(request);
    },
  };
  const first = await artifactEvaluation(root, candidate, { runtimePolicy });
  expect(first.result.exitCode).toBe(0);
  const second = await artifactEvaluation(root, candidate);
  const firstEvidence = parseRunEvidence(
    await readFile(first.result.evidencePath, "utf8"),
  );
  const secondEvidence = parseRunEvidence(
    await readFile(second.result.evidencePath, "utf8"),
  );
  expect(firstEvidence.evaluationIdentity.digest).toBe(
    secondEvidence.evaluationIdentity.digest,
  );
  expect(firstEvidence.configuration.redacted.runtimePolicy).toEqual(
    secondEvidence.configuration.redacted.runtimePolicy,
  );
});

test("concurrent trials retain and release independent candidate artifact runtimes", async () => {
  const { host, root } = await codexFixture(
    '/bin/mkdir -p "$HOME/.darrow/reviews"; printf review > "$HOME/.darrow/reviews/result"; printf "%s" "$HOME" > runtime-home; printf review',
  );
  const allCandidatesReturned = Promise.withResolvers<undefined>();
  const runtimes = new Set<string>();
  const candidate: HostAdapter = {
    ...host,
    async run(request) {
      const result = await host.run(request);
      runtimes.add(defined(request.candidateRuntimeRoot));
      if (runtimes.size === 2) allCandidatesReturned.resolve(undefined);
      await allCandidatesReturned.promise;
      return result;
    },
  };
  const { result } = await artifactEvaluation(root, candidate, {
    trialCount: 2,
    jobs: 2,
    case: {
      id: "concurrent-artifacts",
      prompt: "Create evidence.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "own-review",
          grader: "sevro.shell",
          configuration: {
            run: 'test "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS" = "$(cat runtime-home)/.darrow/reviews"; cat "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result"',
            expectExact: "review",
          },
        },
      ],
    },
  });
  expect(result.exitCode).toBe(0);
  expect(runtimes.size).toBe(2);
  for (const runtime of runtimes) expect(existsSync(runtime)).toBe(false);
}, 30000);

test("candidate artifact cleanup restores restrictive directory permissions after grading", async () => {
  const { host, root } = await codexFixture(
    '/bin/mkdir -p "$HOME/.darrow/reviews"; printf review > "$HOME/.darrow/reviews/result"; chmod 500 "$HOME/.darrow/reviews"; printf review',
  );
  let runtime = "";
  const candidate: HostAdapter = {
    ...host,
    run(request) {
      runtime = defined(request.candidateRuntimeRoot);
      return host.run(request);
    },
  };
  try {
    const { result } = await artifactEvaluation(root, candidate);
    expect(result.exitCode).toBe(0);
    expect(existsSync(runtime)).toBe(false);
  } finally {
    const review = join(runtime, "home/.darrow/reviews");
    if (await Bun.file(join(review, "result")).exists())
      await chmod(review, 0o700);
    await rm(runtime, { recursive: true, force: true });
  }
});

test.each(["grading-error", "candidate-failure", "cancelled"] as const)(
  "candidate artifact cleanup restores unreadable home on %s",
  async (mode) => {
    const { host, root } = await codexFixture(
      '/bin/mkdir -p "$HOME/.darrow/reviews"; printf review > "$HOME/.darrow/reviews/result"; chmod 000 "$HOME"; printf review',
    );
    const controller = new AbortController();
    let runtime = "";
    const candidate: HostAdapter = {
      ...host,
      async run(request) {
        runtime = defined(request.candidateRuntimeRoot);
        const result = await host.run(request);
        if (mode === "cancelled") controller.abort();
        return { ...result, executionFailed: mode === "candidate-failure" };
      },
    };
    try {
      const { result } = await artifactEvaluation(root, candidate, {
        signal: controller.signal,
      });
      expect(result.exitCode).toBe(mode === "grading-error" ? 3 : 2);
      expect(existsSync(runtime)).toBe(false);
    } finally {
      await chmod(join(runtime, "home"), 0o700).catch(() => undefined);
      await rm(runtime, { recursive: true, force: true });
    }
  },
);
