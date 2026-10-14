import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexHost } from "../src/hosts/codex";
import { createClaudeHost } from "../src/hosts/claude";
import { nativeStateParent } from "../src/native-transcript-state";
import { createHash, randomUUID } from "node:crypto";
import { runtimeSeedDigest } from "../src/runtime-seeds";
import { allocateNativeState } from "../src/native-transcript-state";
import {
  loadRuntimeConfiguration,
  runEvaluation,
  type HostAdapter,
  type EvaluationOptions,
} from "../src/engine";
import { parseRunEvidence } from "./fixtures/assertions";
import { defined } from "./fixtures/assertions";

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

function artifactEvaluation(
  root: string,
  host: HostAdapter,
  options: Partial<EvaluationOptions> = {},
) {
  return runEvaluation({
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      artifactDirectories: [{ name: "reviews", path: ".darrow/reviews" }],
    },
    shellIsolation: { protectedRoots: [] },
    case: {
      id: "candidate-artifacts",
      prompt: "Write private review evidence.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "review",
          grader: "sevro.shell",
          configuration: {
            run: 'cat "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result"',
            expectExact: "review",
          },
        },
      ],
    },
    ...options,
  });
}

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

test.each([false, true])(
  "native Codex grading reads candidate artifacts with transcripts %s",
  // eslint-disable-next-line max-lines-per-function -- Keep the real candidate, both grader roles and evidence assertions together.
  async function verifyCodexArtifactGrading(nativeTranscripts) {
    const { host, root } = await codexFixture(
      'if test -n "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS"; then test "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS" != "$HOME/.darrow/reviews"; printf writable > "$HOME/own-state"; /bin/cat "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result"; ! printf changed > "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result"; else /bin/mkdir -p "$HOME/.darrow/reviews"; printf review > "$HOME/.darrow/reviews/result"; printf review; fi',
    );
    const roles: string[] = [];
    const gradingHost: HostAdapter = {
      ...host,
      async run(request) {
        expect(request.candidateRuntimeRoot).toBeUndefined();
        const roots = defined(request.candidateArtifactRoots);
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
    const { result } = await artifactEvaluation(root, host, {
      semanticHost: gradingHost,
      advisoryHost: gradingHost,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        nativeTranscripts,
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

type NativeBundle = {
  completeness: string;
  files: { path: string; bytesBase64: string; sha256: string }[];
};
const roots: string[] = [];
const nativeRuntimeCases = (
  ["candidate", "semantic", "advisory"] as const
).flatMap((role) =>
  [false, true].map((nativeTranscripts) => ({ role, nativeTranscripts })),
);
const nativeRoot =
  '{"type":"session_meta","payload":{"id":"runtime-test"},"future":"preserved"}';
const retainedNativeBundle = {
  format: "sevro.native-transcripts.v1",
  host: "codex",
  role: "candidate",
  rootSessionId: "runtime-test",
  completeness: "complete",
  issues: [],
  files: [
    {
      path: "rollout-runtime-test.jsonl",
      sha256: createHash("sha256").update(nativeRoot).digest("hex"),
      bytesBase64: Buffer.from(nativeRoot).toString("base64"),
    },
  ],
};
test.each([
  {
    label: "unsupported format",
    bundle: { ...retainedNativeBundle, format: "unknown" },
  },
  {
    label: "unsupported host",
    bundle: { ...retainedNativeBundle, host: "unknown" },
  },
  {
    label: "non-array files",
    bundle: { ...retainedNativeBundle, files: {} },
  },
  {
    label: "invalid file record",
    bundle: { ...retainedNativeBundle, files: [null] },
  },
  {
    label: "tampered native bytes",
    bundle: {
      ...retainedNativeBundle,
      files: [
        {
          ...defined(retainedNativeBundle.files[0]),
          bytesBase64: Buffer.from("altered evidence").toString("base64"),
        },
      ],
    },
  },
])(
  "evaluation refuses $label retained native evidence before grading",
  async ({ bundle }) => {
    const { root } = await codexFixture();
    const graderCalls: string[] = [];
    const host: HostAdapter = {
      id: "native-evidence.fixture",
      model: "fixture",
      effort: "low",
      run() {
        return Promise.resolve({
          complete: true,
          finalMessage: "ready",
          artifacts: [
            {
              id: "sevro.native-transcripts.bundle",
              bytes: Buffer.from(JSON.stringify(bundle)),
            },
          ],
        });
      },
    };
    const semanticHost: HostAdapter = {
      ...host,
      id: "native-evidence.grader",
      run() {
        graderCalls.push("called");
        return Promise.reject(
          new Error("invalid native evidence reached grading"),
        );
      },
    };
    const evaluation = runEvaluation(
      retainedNativeEvaluation(root, host, semanticHost),
    );
    expect(evaluation).rejects.toThrow(/native transcript/);
    await evaluation.catch(() => undefined);
    expect(graderCalls).toEqual([]);
  },
);

test("evaluation supplies verified Claude native bytes to a retained-evidence consumer", async () => {
  const { root } = await codexFixture();
  const bytes =
    '{"type":"assistant","message":{"model":"fixture","content":[]}}';
  const host: HostAdapter = {
    id: "claude-evidence.fixture",
    model: "fixture",
    effort: "low",
    run() {
      return Promise.resolve({
        complete: true,
        finalMessage: "ready",
        artifacts: [
          {
            id: "sevro.native-transcripts.bundle",
            bytes: Buffer.from(
              JSON.stringify({
                ...retainedNativeBundle,
                host: "claude",
                files: [
                  {
                    path: "project/runtime-test.jsonl",
                    sha256: createHash("sha256").update(bytes).digest("hex"),
                    bytesBase64: Buffer.from(bytes).toString("base64"),
                  },
                ],
              }),
            ),
          },
        ],
      });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "claude-evidence.consumer",
    async run(request) {
      const view = defined(request.candidateTranscriptRoot);
      expect(
        await readFile(join(view, "claude/project/runtime-test.jsonl"), "utf8"),
      ).toBe(bytes);
      return {
        complete: true,
        finalMessage: JSON.stringify({
          checks: [
            {
              id: "native-evidence",
              verdict: "pass",
              reason: "Verified native bytes",
            },
          ],
        }),
      };
    },
  };
  const { result } = await runEvaluation(
    retainedNativeEvaluation(root, host, semanticHost),
  );
  expect(result.task.verdict).toBe("passed");
});

function retainedNativeEvaluation(
  root: string,
  host: HostAdapter,
  semanticHost: HostAdapter,
) {
  return {
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    runtimePolicy: {
      format: "sevro.runtime.v1" as const,
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
    case: {
      id: "retained-native-integrity",
      prompt: "Return ready",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "native-evidence",
          grader: "sevro.semantic",
          configuration: { proposition: "Native evidence is verified" },
        },
      ],
    },
  };
}
test("public Codex Linux profile keeps trusted native trees visible under an empty root", async () => {
  const { root, workspace } = await codexFixture();
  const sourceRoot =
    process.env.SEVRO_COVERAGE_SOURCE_ROOT ?? join(import.meta.dir, "..");
  const packageRoot = join(root, "package");
  await mkdir(packageRoot);
  await cp(join(sourceRoot, "src"), join(packageRoot, "src"), {
    recursive: true,
  });
  await symlink(
    join(import.meta.dir, "../node_modules"),
    join(packageRoot, "node_modules"),
  );
  const binary = join(root, "linux-codex");
  const profile = join(root, "emitted-profile.toml");
  await writeFile(
    binary,
    `#!${process.execPath}
import {parse} from '${join(import.meta.dir, "../node_modules/smol-toml/dist/index.js")}';
const args=process.argv.slice(2);
const raw=await Bun.file(process.env.CODEX_HOME+'/config.toml').text();
if(args[0]==='sandbox'){await Bun.write('${profile}',raw);process.exit(0);}
const config=parse(raw);const rules=config.permissions[config.default_permissions].filesystem;
const home=process.env.CODEX_HOME;const namespace=home.split('/').slice(0,-2).join('/');
const exposed=Object.entries(rules).some(([path,mode])=>(mode==='read'||mode==='write')&&(path===namespace||namespace.startsWith(path+'/')));
const safe=rules[':root']==='deny'&&!exposed&&rules[namespace]===undefined&&rules[home+'/sessions']==='read'&&rules[home+'/tmp/arg0']==='read';
console.log(JSON.stringify({type:'thread.started',thread_id:'linux-profile'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:safe?'protected and visible':'masked or exposed'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,
    { mode: 0o700 },
  );
  const script = `Object.defineProperty(process,'platform',{value:'linux'});const {createCodexHost}=await import(${JSON.stringify(join(packageRoot, "src/hosts/codex.ts"))});const host=createCodexHost(${JSON.stringify({ binary, sandboxBinary: binary, authFile: join(root, "auth.json"), projectRoot: join(root, "project"), resultsRoot: join(root, "results"), additionalProtectedRoots: [], model: "synthetic", effort: "low", agentConcurrencyLimit: null })});console.log(JSON.stringify(await host.run(${JSON.stringify({ prompt: "Return ready", workspace, condition: "passive", runtimePolicy: { format: "sevro.runtime.v1", environment: {}, readOnlyRoots: [], nativeTranscripts: true } })})));`;
  const processResult = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
    processResult.exited,
  ]);
  expect(code, stderr).toBe(0);
  const result = JSON.parse(stdout) as {
    complete: boolean;
    finalMessage: string;
  };
  expect(result.complete).toBe(true);
  expect(result.finalMessage).toBe("protected and visible");
});
test.each([false, undefined])(
  "Claude disabled transcript policy keeps command home and temp outside private denial: %s",
  async (nativeTranscripts) => {
    const { root, workspace } = await codexFixture();
    const binary = join(root, "claude-command-state");
    await writeFile(
      binary,
      `#!${process.execPath}
const args = process.argv;
const settings = await Bun.file(args[args.indexOf('--settings') + 1]).json();
const fs = settings.sandbox.filesystem;
const own = [process.env.HOME, process.env.TMPDIR];
const denied = own.some(path => fs.denyWrite.some(root => path === root || path.startsWith(root + '/')) || (fs.denyRead.some(root => path === root || path.startsWith(root + '/')) && !fs.allowRead.some(root => path === root || path.startsWith(root + '/'))));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:denied?'denied':'writable'}));
`,
      { mode: 0o700 },
    );
    const credentialFile = join(root, "credential.json");
    await writeFile(credentialFile, "{}");
    const host = createClaudeHost({
      binary,
      credentialFile,
      model: "synthetic",
      effort: "low",
      projectRoot: join(root, "project"),
      resultsRoot: join(root, "results"),
      additionalProtectedRoots: [],
    });
    const result = await host.run({
      prompt: "Use home and temp",
      workspace,
      condition: "passive",
      ...(nativeTranscripts === undefined
        ? {}
        : {
            runtimePolicy: {
              format: "sevro.runtime.v1" as const,
              environment: {},
              readOnlyRoots: [],
              nativeTranscripts,
            },
          }),
    });
    expect(result.finalMessage).toBe("writable");
  },
);
test.each(["child.jsonl", "child.meta.json"])(
  "successful native capture retains malformed child evidence and downgrades tree: %s",
  async (name) => {
    const { host, root, workspace } = await codexFixture();
    await writeFile(
      join(root, "candidate"),
      `#!${process.execPath}
import {mkdir,writeFile} from 'node:fs/promises';
const path = process.env.CODEX_HOME + '/sessions';
await mkdir(path, {recursive:true});
await writeFile(path + '/rollout-runtime-test.jsonl', '{"type":"future_native_record","unknown":{"preserved":true}}\\r\\n');
await writeFile(path + '/${name}', '{"truncated":');
console.log(JSON.stringify({type:'thread.started',thread_id:'runtime-test'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ready'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,
      { mode: 0o700 },
    );
    const result = await host.run({
      prompt: "Return ready",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        nativeTranscripts: true,
      },
    });
    expect(result.complete).toBe(true);
    const observation = defined(
      result.observations?.find(
        (item) => item.id === "sevro.host.native-transcripts",
      ),
    );
    const bundle: NativeBundle = JSON.parse(
      Buffer.from(
        defined(
          result.artifacts?.find(
            (item) => item.id === "sevro.native-transcripts.bundle",
          ),
        ).bytes,
      ).toString(),
    ) as NativeBundle;
    expect(observation.completeness).toBe("partial");
    expect(bundle.completeness).toBe(observation.completeness);
    const child = defined(bundle.files.find((file) => file.path === name));
    expect(child.bytesBase64).toBe(
      Buffer.from('{"truncated":').toString("base64"),
    );
    expect(child.sha256).toBe(
      createHash("sha256").update('{"truncated":').digest("hex"),
    );
  },
);
test.each([
  "native-root",
  "",
  '{"type":',
  "{}",
  "[]",
  "null",
  '{"type":""}',
  '{"type":"future"}\n\n',
  "\ufffd",
])(
  "successful native capture preserves malformed root bytes without claiming complete: %j",
  async (content) => {
    const { host, root, workspace } = await codexFixture();
    await writeFile(
      join(root, "candidate"),
      `#!${process.execPath}
import {mkdir,writeFile} from 'node:fs/promises';
const path = process.env.CODEX_HOME + '/sessions';
await mkdir(path, {recursive:true});
await writeFile(path + '/rollout-runtime-test.jsonl', Buffer.from('${Buffer.from(content === "\ufffd" ? Buffer.from([0xff]) : content).toString("base64")}', 'base64'));
console.log(JSON.stringify({type:'thread.started',thread_id:'runtime-test'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ready'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,
      { mode: 0o700 },
    );
    const result = await host.run({
      prompt: "Return ready",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        nativeTranscripts: true,
      },
    });
    expect(result.complete).toBe(true);
    const observation = defined(
      result.observations?.find(
        (item) => item.id === "sevro.host.native-transcripts",
      ),
    );
    const bundle: NativeBundle = JSON.parse(
      Buffer.from(
        defined(
          result.artifacts?.find(
            (item) => item.id === "sevro.native-transcripts.bundle",
          ),
        ).bytes,
      ).toString(),
    ) as NativeBundle;
    expect(observation.completeness).toBe("partial");
    expect(bundle.completeness).toBe(observation.completeness);
    const bytes =
      content === "\ufffd" ? Buffer.from([0xff]) : Buffer.from(content);
    expect(defined(bundle.files[0]).bytesBase64).toBe(bytes.toString("base64"));
    expect(defined(bundle.files[0]).sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  },
);
test("Claude opt-in supplies live transcript discovery without granting private settings", async () => {
  const { root, workspace } = await codexFixture();
  const binary = join(root, "claude-transcripts");
  await writeFile(
    binary,
    `#!${process.execPath}
const args = process.argv;
const settings = await Bun.file(args[args.indexOf('--settings') + 1]).json();
const config = process.env.CLAUDE_CONFIG_DIR;
const root = process.env.SEVRO_NATIVE_TRANSCRIPT_ROOT;
const fs = settings.sandbox.filesystem;
const startup = process.env.BASH_ENV;
  const script = startup ? await Bun.file(startup).text() : '';
const peerRoot = process.env.SEVRO_RUNTIME_PEER;
const peerDenied = !peerRoot || fs.denyRead.some(path => peerRoot === path || peerRoot.startsWith(path + '/'));
const namespace = root ? root.split('/').slice(0, -3).join('/') : '';
const namespaceDenied = namespace.endsWith('/sevro-native-private') && fs.denyRead.includes(namespace);
const shells = ['/bin/bash'];
const zsh = Bun.which('zsh');
if (zsh) shells.push(zsh);
const discoveries = await Promise.all(shells.map(async shell => {
  const child = Bun.spawn([shell, '-c', 'printf "%s" "$CLAUDE_CONFIG_DIR"'], {env: {...process.env, CLAUDE_CONFIG_DIR: ''}, stdout:'pipe'});
  return {config: await new Response(child.stdout).text(), exitCode: await child.exited};
}));
const valid = namespaceDenied && peerDenied && root && discoveries.every(shell => shell.exitCode === 0 && shell.config + '/projects' === root) && fs.allowRead.includes(root) && fs.denyWrite.includes(root) && fs.denyRead.some(path => config.startsWith(path)) && script.includes('CLAUDE_CONFIG_DIR=');
console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: valid ? 'available' : 'missing'}));
`,
    { mode: 0o700 },
  );
  const credentialFile = join(root, "claude-credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
  });
  const peer = await realpath(
    await mkdtemp(join(await nativeStateParent(), "claude-peer-")),
  );
  roots.push(peer);
  const result = await host.run({
    prompt: "Read transcript",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { SEVRO_RUNTIME_PEER: peer },
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  expect(result.finalMessage).toBe("available");
});

test("Claude opt-in reports unavailable native transcript evidence after cleanup", async () => {
  const { root, workspace } = await codexFixture();
  const binary = join(root, "claude-empty-transcripts");
  await writeFile(
    binary,
    '#!/bin/sh\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
    { mode: 0o700 },
  );
  const credentialFile = join(root, "credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
  });
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    )?.completeness,
  ).toBe("unavailable");
});

test("native capture leaves an unbound root session partial", async () => {
  const { root, workspace } = await codexFixture();
  const binary = join(root, "claude-unbound-transcripts");
  await writeFile(
    binary,
    '#!/bin/sh\nmkdir -p "$CLAUDE_CONFIG_DIR/projects/project"\nprintf native > "$CLAUDE_CONFIG_DIR/projects/project/session.jsonl"\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
    { mode: 0o700 },
  );
  const credentialFile = join(root, "credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
  });
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    )?.completeness,
  ).toBe("partial");
});

test("Claude native capture associates root and child files with their native session", async () => {
  const { root, workspace } = await codexFixture();
  const binary = join(root, "claude-tree");
  await writeFile(
    binary,
    `#!${process.execPath}
import {mkdir,writeFile} from 'node:fs/promises';
const path = process.env.CLAUDE_CONFIG_DIR + '/projects/' + process.cwd().replace(/[^A-Za-z0-9]/g, '-');
await mkdir(path + '/11111111-1111-4111-8111-111111111111/subagents', {recursive:true});
await writeFile(path + '/11111111-1111-4111-8111-111111111111.jsonl', JSON.stringify({type:'assistant',sessionId:'11111111-1111-4111-8111-111111111111',message:{model:'synthetic',content:[{type:'tool_use',name:'Agent',id:'task',input:{}}]}})+'\\n'+JSON.stringify({type:'user',sessionId:'11111111-1111-4111-8111-111111111111',message:{content:[{type:'tool_result',tool_use_id:'task'}]},toolUseResult:{status:'completed',agentId:'child'}})+'\\n');
await writeFile(path + '/11111111-1111-4111-8111-111111111111/subagents/agent-child.jsonl', JSON.stringify({type:'assistant',sessionId:'11111111-1111-4111-8111-111111111111',agentId:'child',message:{content:[{type:'tool_use',name:'Skill',id:'read',input:{skill:'example:read'}}]}}));
await writeFile(path + '/11111111-1111-4111-8111-111111111111/subagents/agent-child.meta.json', '{"toolUseId":"task","parentAgentId":null}');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'11111111-1111-4111-8111-111111111111'}));
console.log(JSON.stringify({type:'result',session_id:'11111111-1111-4111-8111-111111111111',subtype:'success',is_error:false,result:'ready'}));
`,
    { mode: 0o700 },
  );
  const credentialFile = join(root, "credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
  });
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  const capture = defined(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    ),
  );
  expect(capture.data.rootSessionId).toBe(
    "11111111-1111-4111-8111-111111111111",
  );
  expect(capture.data.files).toHaveLength(3);
  expect(capture.completeness).toBe("complete");
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.claude.nested-skills",
    )?.completeness,
  ).toBe("complete");
});

test("Claude opt-in preserves partial native transcripts on stream failure", async () => {
  const { root, workspace } = await codexFixture();
  const binary = join(root, "claude-failed-transcripts");
  await writeFile(
    binary,
    '#!/bin/sh\nmkdir -p "$CLAUDE_CONFIG_DIR/projects/project"\nprintf unfinished > "$CLAUDE_CONFIG_DIR/projects/project/failed.jsonl"\nsleep 2\n',
    { mode: 0o700 },
  );
  const credentialFile = join(root, "credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
    timeoutMs: 300,
  });
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  expect(result.executionFailed).toBe(true);
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    )?.completeness,
  ).toBe("partial");
});
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("Claude fixture binaries keep precedence with a declared PATH", async () => {
  const { root, workspace, bin } = await codexFixture();
  const fixtureBinDir = join(workspace, ".git", "fixture-bin");
  await mkdir(fixtureBinDir, { recursive: true });
  await writeFile(join(fixtureBinDir, "probe"), "#!/bin/sh\nprintf fixture\n", {
    mode: 0o755,
  });
  const binary = join(root, "claude-fixture");
  await writeFile(
    binary,
    `#!/bin/sh
answer=$(probe)
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}\\n' "$answer"
`,
    { mode: 0o755 },
  );
  const credentialFile = join(root, "claude-credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
  });
  const result = await host.run({
    prompt: "Return probe output.",
    workspace,
    fixtureBinDir,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {
        PATH: `${bin}:/usr/bin:/bin`,
        SEVRO_RUNTIME_SAMPLE: "host tool",
      },
      readOnlyRoots: [bin],
    },
  });
  expect(result.finalMessage).toBe("fixture");
});

test("Claude refuses direct read access to an original seed source", async () => {
  const { root, workspace } = await codexFixture();
  const source = join(root, "seed");
  await mkdir(source);
  const binary = join(root, "claude-fixture");
  await writeFile(
    binary,
    '#!/bin/sh\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
    { mode: 0o755 },
  );
  const credentialFile = join(root, "claude-credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
  });
  expect(
    host.run({
      prompt: "Return ready.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [source],
        seeds: [
          { source, target: "cache", sha256: await runtimeSeedDigest(source) },
        ],
      },
    }),
  ).rejects.toThrow("protected data");
});

async function codexFixture(
  command = "probe",
  additionalProtectedRoots: string[] = [],
  timeoutMs?: number,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-runtime-host-")),
  );
  roots.push(root);
  const project = join(root, "project"),
    results = join(root, "results"),
    workspace = join(root, "workspace"),
    bin = join(root, "tools");
  await Promise.all(
    [project, results, workspace, bin].map((path) => mkdir(path)),
  );
  await writeFile(
    join(bin, "probe"),
    '#!/bin/sh\nprintf "%s" "$SEVRO_RUNTIME_SAMPLE"\n',
  );
  await chmod(join(bin, "probe"), 0o755);
  const codex = defined(Bun.which("codex"));
  const binary = join(root, "candidate");
  await writeFile(
    binary,
    `#!/bin/sh
/bin/cat >/dev/null
profile=$(/usr/bin/sed -n 's/^default_permissions = "\\(.*\\)"/\\1/p' "$CODEX_HOME/config.toml")
/bin/mkdir -p "$CODEX_HOME/sessions"
printf '%s' '${nativeRoot}' > "$CODEX_HOME/sessions/rollout-runtime-test.jsonl"
answer=$('${codex}' sandbox -P "$profile" -C "$PWD" -- /bin/sh -c '${command}' 2>"$PWD/sandbox-error") || answer=unavailable
printf '%s\\n' '{"type":"thread.started","thread_id":"runtime-test"}'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "$answer"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
  );
  await chmod(binary, 0o755);
  const auth = join(root, "auth.json");
  await writeFile(auth, "synthetic-auth");
  const host = createCodexHost({
    binary,
    sandboxBinary: codex,
    authFile: auth,
    projectRoot: project,
    resultsRoot: results,
    additionalProtectedRoots: [auth, ...additionalProtectedRoots],
    model: "synthetic",
    effort: "low",
    timeoutMs,
  });
  return { host, workspace, root, bin };
}

function gitMetadataCommand(): string {
  return [
    "set -eu",
    "git switch -c docs/native-publication-authority 1>&2",
    "printf accepted > NOTES.md",
    "git add NOTES.md",
    "git write-tree > captured-tree",
    "git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm accepted",
    "mkdir -p .git/artificer",
    "(set -C; printf locked > .git/artificer/admission.lock)",
    "printf revoked > .git/artificer/grant",
    "rm .git/artificer/admission.lock",
    "git init --bare -q remote.git",
    "git push ./remote.git HEAD:refs/heads/published 1>&2",
    'for path in "$PROTECTED_SOURCE" "$PROTECTED_RESULTS" "$PROTECTED_LOGIN"; do',
    '  if cat "$path" >/dev/null 2>&1; then exit 81; fi',
    '  if printf changed > "$path" 2>/dev/null; then exit 82; fi',
    "done",
    'for path in "$CODEX_HOME/auth.json" "$CODEX_HOME/config.toml"; do',
    '  if cat "$path" >/dev/null 2>&1; then exit 81; fi',
    // Linux may allow new files in synthetic ancestors; the parent verifies the originals below.
    '  printf changed 2>/dev/null > "$path" || true',
    "done",
    "if printf changed > .agents/skills/probe/SKILL.md 2>/dev/null; then exit 83; fi",
    "if mkdir -p .codex 2>/dev/null && printf changed 2>/dev/null > .codex/config.toml; then exit 84; fi",
    "printf accepted",
  ].join("\n");
}

async function verifyOriginalCodexConfiguration(binary: string): Promise<void> {
  const source = await readFile(binary, "utf8");
  const snapshot =
    '/usr/bin/cksum "$CODEX_HOME/auth.json" "$CODEX_HOME/config.toml"';
  await writeFile(
    binary,
    source
      .replace("answer=$(", `original_configuration=$(${snapshot})\nanswer=$(`)
      .replace(
        " || answer=unavailable",
        ` || answer=unavailable\nif [ "$original_configuration" != "$(${snapshot})" ]; then answer=modified-private-configuration; fi`,
      ),
  );
}

test("Codex candidate can commit, publish local refs and update admission state", async () => {
  const { host, root, workspace } = await codexFixture(gitMetadataCommand());
  await verifyOriginalCodexConfiguration(join(root, "candidate"));
  const source = join(root, "project", "hidden.txt");
  const results = join(root, "results", "hidden.txt");
  await Promise.all([
    writeFile(source, "hidden source"),
    writeFile(results, "hidden grading"),
    mkdir(join(workspace, ".agents/skills/probe"), { recursive: true }),
  ]);
  await writeFile(join(workspace, ".agents/skills/probe/SKILL.md"), "skill");
  expect(await Bun.spawn(["git", "init", "-q", workspace]).exited).toBe(0);
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: {
        set: {
          PATH: "/usr/bin:/bin",
          PROTECTED_SOURCE: source,
          PROTECTED_RESULTS: results,
          PROTECTED_LOGIN: join(root, "auth.json"),
        },
      },
      nativeTranscripts: true,
    }),
  );
  const runtimePolicy = await loadRuntimeConfiguration(
    join(root, "project"),
    join(root, "runtime.json"),
  );
  const result = await host.run({
    prompt:
      "Commit and publish to the local fixture remote, then revoke the grant.",
    workspace,
    condition: "passive",
    runtimePolicy,
  });
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("accepted");
  const head = await readFile(
    join(workspace, ".git/refs/heads/docs/native-publication-authority"),
    "utf8",
  );
  expect(
    await readFile(join(workspace, "remote.git/refs/heads/published"), "utf8"),
  ).toBe(head);
  expect(await readFile(join(workspace, ".git/HEAD"), "utf8")).toBe(
    "ref: refs/heads/docs/native-publication-authority\n",
  );
  expect(await readFile(join(workspace, ".git/artificer/grant"), "utf8")).toBe(
    "revoked",
  );
  expect(existsSync(join(workspace, ".git/artificer/admission.lock"))).toBe(
    false,
  );
  expect(await readFile(join(workspace, "NOTES.md"), "utf8")).toBe("accepted");
  expect(await readFile(source, "utf8")).toBe("hidden source");
  expect(await readFile(results, "utf8")).toBe("hidden grading");
});

test("Codex Git metadata grant cannot write through a link into protected source", async () => {
  const { host, root, workspace } = await codexFixture(
    "if printf changed > .git/private.txt 2>/dev/null; then printf exposed; else printf blocked; fi",
  );
  const metadata = join(root, "project", "metadata");
  await mkdir(metadata);
  await writeFile(join(metadata, "private.txt"), "protected");
  await symlink(metadata, join(workspace, ".git"));
  const result = await host
    .run({
      prompt: "Try writing protected metadata.",
      workspace,
      condition: "passive",
    })
    .catch((cause: unknown) => {
      if (
        !(cause instanceof Error) ||
        cause.message !== "Codex Git metadata must be an isolated directory"
      )
        throw cause;
      return { finalMessage: "blocked" };
    });
  expect(result.finalMessage).toBe("blocked");
  expect(await readFile(join(metadata, "private.txt"), "utf8")).toBe(
    "protected",
  );
});

test("Codex opt-in exposes live native transcripts read-only while protecting private siblings", async () => {
  const { host, workspace } = await codexFixture(
    '/bin/cat "$CODEX_HOME/sessions/rollout-runtime-test.jsonl" >/dev/null && printf native-root; ! /bin/cat "$CODEX_HOME/auth.json"; ! /bin/cat "$CODEX_HOME/config.toml"; ! /bin/echo changed > "$CODEX_HOME/sessions/rollout-runtime-test.jsonl"',
  );
  const result = await host.run({
    prompt: "Read transcript",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("native-root");
});

test("Codex opt-in retains native bytes and marks missing sessions unavailable", async () => {
  const { host, workspace } = await codexFixture();
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  const capture = result.observations?.find(
    (item) => item.id === "sevro.host.native-transcripts",
  );
  expect(capture?.completeness).toBe("complete");
  expect(capture?.data.rootSessionId).toBe("runtime-test");
  const artifact = defined(
    result.artifacts?.find(
      (item) => item.id === "sevro.native-transcripts.bundle",
    ),
  );
  expect(Buffer.from(artifact.bytes).toString()).toContain(
    Buffer.from(nativeRoot).toString("base64"),
  );
});

test("native capture refuses to call a missing original session complete", async () => {
  const { host, root, workspace } = await codexFixture();
  const binary = join(root, "candidate");
  const source = await readFile(binary, "utf8");
  await writeFile(
    binary,
    source.replace(
      "answer=$(",
      'mv "$CODEX_HOME/sessions/rollout-runtime-test.jsonl" "$CODEX_HOME/sessions/rollout-child.jsonl"\nanswer=$(',
    ),
  );
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  const capture = result.observations?.find(
    (item) => item.id === "sevro.host.native-transcripts",
  );
  expect(capture?.completeness).toBe("partial");
  expect(capture?.data.issues).toContain("root_session_missing");
});

test("native transcript metadata cannot overflow the existing artifact budget", async () => {
  const { host, root, workspace } = await codexFixture();
  const binary = join(root, "candidate");
  await writeFile(
    binary,
    `#!${process.execPath}
import {mkdir,writeFile} from 'node:fs/promises';
const path = process.env.CODEX_HOME + '/sessions';
await mkdir(path, {recursive:true});
await writeFile(path + '/000-rollout-runtime-test.jsonl', Buffer.alloc(5*1024*1024));
for (let index=0; index<4094; index++) await writeFile(path + '/' + String(index).padStart(4,'0') + 'x'.repeat(244) + '.json', '');
console.log(JSON.stringify({type:'thread.started',thread_id:'runtime-test'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ready'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,
    { mode: 0o700 },
  );
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  const artifact = defined(
    result.artifacts?.find(
      (item) => item.id === "sevro.native-transcripts.bundle",
    ),
  );
  expect(artifact.bytes.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    )?.completeness,
  ).toBe("partial");
}, 15000);

test("Codex opt-in preserves partial native transcripts when native execution fails", async () => {
  const { host, root, workspace } = await codexFixture();
  await writeFile(
    join(root, "candidate"),
    '#!/bin/sh\nmkdir -p "$CODEX_HOME/sessions"\nprintf unfinished > "$CODEX_HOME/sessions/rollout-failed.jsonl"\nexit 1\n',
    { mode: 0o700 },
  );
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  expect(result.executionFailed).toBe(true);
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    )?.completeness,
  ).toBe("partial");
  expect(
    Buffer.from(
      defined(
        result.artifacts?.find(
          (item) => item.id === "sevro.native-transcripts.bundle",
        ),
      ).bytes,
    ).toString(),
  ).toContain(Buffer.from("unfinished").toString("base64"));
});

test.each([false, true])(
  "Codex runtime cannot read or write another native trial tree: transcripts %s",
  async (nativeTranscripts) => {
    const peer = await allocateNativeState("claude-peer-");
    roots.push(peer);
    await writeFile(join(peer, "secret"), "peer-transcript");
    const { host, workspace } = await codexFixture(
      `if /bin/cat "${peer}/secret" >/dev/null 2>&1 || printf changed > "${peer}/secret" 2>/dev/null || mkdir "${peer}/child" 2>/dev/null; then printf exposed; else printf denied; fi`,
    );
    const result = await host.run({
      prompt: "Check boundary",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        nativeTranscripts,
      },
    });
    expect(result.finalMessage).toBe("denied");
    expect(await readFile(join(peer, "secret"), "utf8")).toBe(
      "peer-transcript",
    );
  },
);

test("native host refuses an unsafe pre-existing transcript namespace", async () => {
  const { host, workspace } = await codexFixture();
  const namespace = join(
    process.platform === "linux" ? "/var/tmp" : tmpdir(),
    "sevro-native-private",
  );
  await mkdir(namespace, { recursive: true, mode: 0o700 });
  await chmod(namespace, 0o777);
  try {
    expect(
      host.run({
        prompt: "Return ready",
        workspace,
        condition: "passive",
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
          nativeTranscripts: true,
        },
      }),
    ).rejects.toThrow("native state namespace");
  } finally {
    await chmod(namespace, 0o700);
  }
});

test("native host refuses a forged retained transcript view", async () => {
  const { host, root, workspace } = await codexFixture();
  const external = join(root, "external-view");
  await mkdir(external);
  expect(
    host.run({
      prompt: "Return ready",
      workspace,
      condition: "passive",
      candidateTranscriptRoot: external,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
      },
    }),
  ).rejects.toThrow("native transcript view");
});

test("direct runtime policy refuses lexical native seed aliases to public caches", async () => {
  const { host, root, workspace } = await codexFixture();
  const namespace = join(
    process.platform === "linux" ? "/var/tmp" : tmpdir(),
    "sevro-native-private",
  );
  await mkdir(namespace, { recursive: true, mode: 0o700 });
  const privateRoot = await mkdtemp(join(namespace, "seed-alias-probe-"));
  roots.push(privateRoot);
  const source = join(root, "public-cache");
  await mkdir(source);
  await writeFile(join(source, "value"), "public dependency");
  const alias = join(privateRoot, "public-alias");
  await symlink(source, alias);
  const sha256 = await runtimeSeedDigest(source);
  expect(
    host.run({
      prompt: "Return ready",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        seeds: [{ source: alias, target: "cache", sha256 }],
      },
    }),
  ).rejects.toThrow("protected data");
  expect(
    await Bun.file(
      join(workspace, ".git/sevro-runtime/candidate/cache/value"),
    ).exists(),
  ).toBe(false);
});

test("direct runtime policy cannot copy a symlinked private native seed", async () => {
  const { host, root, workspace } = await codexFixture();
  const namespace = join(
    process.platform === "linux" ? "/var/tmp" : tmpdir(),
    "sevro-native-private",
  );
  await mkdir(namespace, { recursive: true, mode: 0o700 });
  const source = await realpath(await mkdtemp(join(namespace, "seed-probe-")));
  roots.push(source);
  await writeFile(join(source, "private.txt"), "peer private input");
  const alias = join(root, "native-state-alias");
  await symlink(source, alias);
  expect(
    host.run({
      prompt: "Return ready",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        seeds: [{ source: alias, target: "cache", sha256: "a".repeat(64) }],
      },
    }),
  ).rejects.toThrow("protected data");
  expect(
    await Bun.file(
      join(workspace, ".git/sevro-runtime/candidate/cache/private.txt"),
    ).exists(),
  ).toBe(false);
});

test("native capture marks the declared native byte limit partial", async () => {
  const { host, root, workspace } = await codexFixture();
  const binary = join(root, "candidate");
  await writeFile(
    binary,
    `#!${process.execPath}
import {mkdir,writeFile} from 'node:fs/promises';
const path = process.env.CODEX_HOME + '/sessions';
await mkdir(path, {recursive:true});
await writeFile(path + '/rollout-runtime-test.jsonl', 'native root bytes');
await writeFile(path + '/rollout-child.jsonl', Buffer.alloc(6*1024*1024));
console.log(JSON.stringify({type:'thread.started',thread_id:'runtime-test'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ready'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,
    { mode: 0o700 },
  );
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  const capture = defined(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    ),
  );
  expect(capture.completeness).toBe("partial");
  expect(capture.data.issues).toContain("byte_limit");
  expect(capture.data.files).toHaveLength(1);
});

test("native capture refuses credential-bearing source links", async () => {
  const { host, root, workspace } = await codexFixture(
    'if cat "$CODEX_HOME/sessions/escape.jsonl" >/dev/null 2>&1; then printf exposed; else printf denied; fi',
  );
  const binary = join(root, "candidate");
  const source = await readFile(binary, "utf8");
  await writeFile(
    binary,
    source.replace(
      "answer=$(",
      'ln -s "$CODEX_HOME/auth.json" "$CODEX_HOME/sessions/escape.jsonl"\nanswer=$(',
    ),
  );
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  expect(result.finalMessage).toBe("denied");
  const capture = defined(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    ),
  );
  expect(capture.completeness).toBe("partial");
  expect(capture.data.issues).toContain("unsafe_entry");
  const artifact = defined(
    result.artifacts?.find(
      (item) => item.id === "sevro.native-transcripts.bundle",
    ),
  );
  expect(Buffer.from(artifact.bytes).toString()).not.toContain(
    Buffer.from("synthetic-auth").toString("base64"),
  );
});

async function waitForNativeCommand(path: string): Promise<void> {
  for (let index = 0; index < 3000; index++) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error("native command did not start");
}

test.each([false, true])(
  "running native commands cannot read or write a later-created peer tree: transcripts %s",
  async (nativeTranscripts) => {
    const parent = join(
      process.platform === "linux" ? "/var/tmp" : tmpdir(),
      "sevro-native-private",
    );
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const namespace = await realpath(parent);
    const peer = join(namespace, `late-peer-${randomUUID()}`);
    roots.push(peer);
    const { host, workspace } = await codexFixture(
      `printf ready > late-ready; sleep 0.5; if cat "${peer}/secret" >/dev/null 2>&1 || printf changed > "${peer}/secret" 2>/dev/null || mkdir "${peer}/child" 2>/dev/null; then printf exposed; else printf denied; fi`,
    );
    const running = host.run({
      prompt: "Check boundary",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        nativeTranscripts,
      },
    });
    await waitForNativeCommand(join(workspace, "late-ready"));
    await mkdir(peer, { mode: 0o700 });
    await writeFile(join(peer, "secret"), "later private transcript");
    expect((await running).finalMessage).toBe("denied");
    expect(await readFile(join(peer, "secret"), "utf8")).toBe(
      "later private transcript",
    );
  },
  45000,
);

test("evaluation exposes retained native evidence to isolated shell and semantic consumers", async () => {
  const { host, root } = await codexFixture();
  const semanticHost: HostAdapter = {
    id: "transcript.semantic",
    model: "fixture",
    effort: "low",
    async run(request) {
      const view = request.candidateTranscriptRoot;
      const content = view
        ? await readFile(
            join(view, "codex", "rollout-runtime-test.jsonl"),
            "utf8",
          )
        : "missing";
      return {
        complete: true,
        finalMessage: JSON.stringify({
          checks: [
            {
              id: "semantic",
              verdict: content === nativeRoot ? "pass" : "fail",
              reason: "Retained native evidence",
            },
          ],
        }),
      };
    },
  };
  const { result } = await runEvaluation({
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
    shellIsolation: { protectedRoots: [] },
    case: {
      id: "transcript-consumers",
      prompt: "Return ready",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "shell",
          grader: "sevro.shell",
          configuration: {
            run: 'cat "$SEVRO_CANDIDATE_TRANSCRIPTS/codex/rollout-runtime-test.jsonl"; ! printf changed > "$SEVRO_CANDIDATE_TRANSCRIPTS/codex/rollout-runtime-test.jsonl"',
            expectExact: nativeRoot,
          },
        },
        {
          id: "semantic",
          grader: "sevro.semantic",
          configuration: { proposition: "Transcript is available" },
        },
      ],
    },
  });
  expect(result.task.verdict).toBe("passed");
});

test("evaluation retains native transcript artifacts when cancellation follows host completion", async () => {
  const { root, host } = await codexFixture();
  const controller = new AbortController();
  const cancellingHost: HostAdapter = {
    ...host,
    async run(request) {
      const result = await host.run(request);
      controller.abort();
      return result;
    },
  };
  const { result } = await runEvaluation({
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host: cancellingHost,
    signal: controller.signal,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
    case: {
      id: "cancelled-transcripts",
      prompt: "Return ready",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [],
    },
  });
  expect(result.execution.status).toBe("cancelled");
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(
    defined(evidence.trials[0]).artifactRefs.some(
      (item) => item.id === "sevro.native-transcripts.bundle",
    ),
  ).toBe(true);
});

test("Codex candidate commands use the declared runtime environment", async () => {
  const { host, workspace, bin } = await codexFixture();
  const result = await host.run({
    prompt: "Return probe output.",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {
        PATH: `${bin}:/usr/bin:/bin`,
        SEVRO_RUNTIME_SAMPLE: "from caller",
      },
      readOnlyRoots: [bin],
    },
  });
  expect(result.complete).toBe(true);
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("from caller");
});

test("Codex resolved support-tree aliases grant reads and refuse writes", async () => {
  const support = await realpath(
    await mkdtemp(join(homedir(), ".sevro-runtime-alias-")),
  );
  roots.push(support);
  const source = join(support, "protected-source"),
    privateSibling = join(support, "private-sibling"),
    deniedFile = join(support, "protected-login.json");
  await Promise.all([source, privateSibling].map((path) => mkdir(path)));
  await writeFile(join(source, "value"), "source marker");
  await writeFile(join(privateSibling, "value"), "private sibling marker");
  await writeFile(deniedFile, "login marker");
  const { host, workspace, root } = await codexFixture(
    '/bin/cat "$SUPPORT_ALIAS/value"; if printf changed > "$SUPPORT_ALIAS/value" 2>/dev/null; then printf writable; fi; for path in "$SUPPORT_SOURCE/value" "$SUPPORT_PRIVATE/value" "$SUPPORT_DENIED_FILE"; do if /bin/cat "$path" >/dev/null 2>&1; then printf private-readable; fi; done',
    [source, deniedFile],
  );
  const cellar = join(support, "Cellar"),
    opt = join(support, "opt");
  const target = join(cellar, "package"),
    alias = join(opt, "package");
  await mkdir(target, { recursive: true });
  await mkdir(opt);
  await writeFile(join(target, "value"), "alias support");
  await symlink(target, alias);
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: {
        set: {
          SUPPORT_ALIAS: alias,
          SUPPORT_SOURCE: source,
          SUPPORT_PRIVATE: privateSibling,
          SUPPORT_DENIED_FILE: deniedFile,
        },
      },
      filesystem: { optionalReadOnlyRoots: [opt, cellar] },
    }),
  );
  const policy = await loadRuntimeConfiguration(
    join(root, "project"),
    join(root, "runtime.json"),
  );
  const result = await host.run({
    prompt: "Read support",
    workspace,
    condition: "passive",
    runtimePolicy: policy,
  });
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("alias support");
  expect(await readFile(join(target, "value"), "utf8")).toBe("alias support");
});

test.skipIf(process.platform !== "linux")(
  "Codex retains protected home denial inside platform read baselines",
  async () => {
    const { root, workspace } = await codexFixture(
      "if /bin/cat /usr/bin/env >/dev/null 2>&1; then printf exposed; else printf blocked; fi",
    );
    const peer = join(root, "baseline-peer.ts");
    const options = {
      binary: join(root, "candidate"),
      sandboxBinary: defined(Bun.which("codex")),
      authFile: join(root, "auth.json"),
      projectRoot: join(root, "project"),
      resultsRoot: join(root, "results"),
      additionalProtectedRoots: [join(root, "auth.json")],
      model: "synthetic",
      effort: "low",
    };
    const request = {
      prompt: "Inspect runtime",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: ["/usr/local/bin"],
      },
    };
    await writeFile(
      peer,
      `import {createCodexHost} from ${JSON.stringify(join(import.meta.dir, "../src/hosts/codex.ts"))};
try { const result = await createCodexHost(${JSON.stringify(options)}).run(${JSON.stringify(request)}); console.log(result.finalMessage); }
catch (cause) { if (!(cause instanceof Error) || !/Codex (?:isolation|executable) preflight failed/.test(cause.message)) throw cause; console.log("blocked-before-execution"); }
`,
    );
    const child = Bun.spawn([process.execPath, peer], {
      env: { ...process.env, HOME: "/usr" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(["blocked", "blocked-before-execution"]).toContain(stdout.trim());
  },
);

test.skipIf(process.platform !== "darwin")(
  "Codex selected Apple Git can query configuration",
  async () => {
    const { host, root, workspace } = await codexFixture(
      'git config --system --get sevro.nonexistent.runtimeprobe; code=$?; test "$code" -eq 1 && printf accessible',
    );
    await writeFile(
      join(root, "runtime.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { set: { PATH: "/usr/bin:/bin" } },
      }),
    );
    const runtimePolicy = await loadRuntimeConfiguration(
      join(root, "project"),
      join(root, "runtime.json"),
    );
    const result = await host.run({
      prompt: "Query Git",
      workspace,
      condition: "passive",
      runtimePolicy,
    });
    expect(
      result.finalMessage,
      await readFile(join(workspace, "sandbox-error"), "utf8"),
    ).toBe("accessible");
  },
  30000,
);

test.each(nativeRuntimeCases)(
  "Codex runtime supports plugin review artifacts outside the repository: $role, transcripts $nativeTranscripts",
  async ({ role, nativeTranscripts }) => {
    const { host, workspace } = await codexFixture(
      'if /bin/cat "$RUNTIME_ROOT/../codex-home/auth.json" >/dev/null 2>&1 || /bin/cat "$RUNTIME_ROOT/../codex-home/config.toml" >/dev/null 2>&1 || printf changed > "$RUNTIME_ROOT/../home/planted" 2>/dev/null; then printf exposed; exit 0; fi; case "$HOME" in "$PWD"/*) printf repository-local;; *) /bin/mkdir -p "$HOME/.darrow/reviews" && printf review > "$HOME/.darrow/reviews/result" && /bin/cat "$HOME/.darrow/reviews/result"; printf "%s" "$HOME" > runtime-home;; esac',
    );
    const result = await host.run({
      prompt: "Write review state outside the Git fixture.",
      workspace,
      condition: "passive",
      runtimeRole: role,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: { RUNTIME_ROOT: "{{sevro.runtime}}" },
        readOnlyRoots: [],
        nativeTranscripts,
      },
    });
    expect(
      result.finalMessage,
      await readFile(join(workspace, "sandbox-error"), "utf8"),
    ).toBe("review");
    const home = await readFile(join(workspace, "runtime-home"), "utf8");
    expect(home.startsWith(`${workspace}/`)).toBe(false);
    expect(await Bun.file(join(home, ".darrow/reviews/result")).exists()).toBe(
      false,
    );
  },
  30000,
);

test.each(nativeRuntimeCases)(
  "Claude runtime supports plugin review artifacts with narrow external grants: $role, transcripts $nativeTranscripts",
  async ({ role, nativeTranscripts }) => {
    const { root, workspace } = await codexFixture();
    const binary = join(root, "claude-runtime-artifact");
    await writeFile(
      binary,
      `#!${process.execPath}
const args = process.argv;
const settings = await Bun.file(args[args.indexOf('--settings') + 1]).json();
const fs = settings.sandbox.filesystem;
const runtime = process.env.RUNTIME_ROOT;
const namespace = runtime.split('/').slice(0, -2).join('/');
const writable = fs.allowWrite?.length === 1 && fs.allowWrite[0] === runtime && !fs.denyWrite.some(path => runtime === path || runtime.startsWith(path + '/'));
const bounded = fs.allowRead.includes(runtime) && fs.denyRead.includes(namespace) && !fs.allowRead.includes(namespace) && !settings.permissions.deny.includes('Edit(/' + namespace + '/**)') && !settings.permissions.additionalDirectories.includes(namespace);
const editsBounded = !settings.permissions.allow.includes('Edit') && settings.permissions.allow.includes('Edit(/' + process.cwd() + '/**)') && settings.permissions.allow.includes('Edit(/' + runtime + '/**)');
const shell = Bun.spawn(['/bin/sh', '-c', 'case "$HOME" in "$PWD"/*) printf repository-local;; *) /bin/mkdir -p "$HOME/.darrow/reviews" && printf review > "$HOME/.darrow/reviews/result" && /bin/cat "$HOME/.darrow/reviews/result";; esac'], {stdout:'pipe'});
const artifact = await new Response(shell.stdout).text();
await shell.exited;
await Bun.write('runtime-home', process.env.HOME);
const result = artifact === 'repository-local' ? artifact : writable && bounded && editsBounded ? artifact : 'invalid grants';
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result}));
`,
      { mode: 0o700 },
    );
    const credentialFile = join(root, "claude-credential.json");
    await writeFile(credentialFile, "{}");
    const host = createClaudeHost({
      binary,
      credentialFile,
      model: "synthetic",
      effort: "low",
      projectRoot: join(root, "project"),
      resultsRoot: join(root, "results"),
      additionalProtectedRoots: [],
    });
    const result = await host.run({
      prompt: "Write private review state.",
      workspace,
      condition: "passive",
      runtimeRole: role,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: { RUNTIME_ROOT: "{{sevro.runtime}}" },
        readOnlyRoots: [],
        nativeTranscripts,
      },
    });
    expect(result.finalMessage).toBe("review");
    const home = await readFile(join(workspace, "runtime-home"), "utf8");
    expect(home.startsWith(`${workspace}/`)).toBe(false);
    expect(await Bun.file(join(home, ".darrow/reviews/result")).exists()).toBe(
      false,
    );
  },
);

test("Codex runtime survives continuation and inherited command children", async () => {
  const { host, workspace } = await codexFixture(
    'if test -f "$HOME/turn-state"; then /bin/sh -c "cat \\"\\$HOME/turn-state\\""; else printf persisted > "$HOME/turn-state"; printf initial; fi; printf "%s" "$HOME" > runtime-home',
  );
  const result = await host.run({
    prompt: "Prepare runtime state.",
    followUpPrompt: "Read it in a child shell.",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
    },
  });
  expect(result.finalMessage).toBe("persisted");
  const home = await readFile(join(workspace, "runtime-home"), "utf8");
  expect(home.startsWith(`${workspace}/`)).toBe(false);
  expect(await Bun.file(join(home, "turn-state")).exists()).toBe(false);
}, 30000);

function runtimeFailureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

test.each([
  { native: "Claude", viaAlias: false },
  { native: "Claude", viaAlias: true },
  { native: "Codex", viaAlias: false },
  { native: "Codex", viaAlias: true },
])(
  "$native runtime refuses a fixture within the native namespace: alias $viaAlias",
  async ({ native, viaAlias }) => {
    const { root, host: codexHost } = await codexFixture(
      "printf launched > native-launched",
    );
    const privateFixture = await allocateNativeState("runtime-fixture-");
    roots.push(privateFixture);
    const workspace = join(privateFixture, "workspace");
    await mkdir(workspace);
    expect(Bun.spawnSync(["git", "init", "--quiet", workspace]).exitCode).toBe(
      0,
    );
    const gitEntries = await readdir(join(workspace, ".git"));
    const peerFile = join(privateFixture, "retained-peer.json");
    await writeFile(peerFile, "retained peer");
    const privateEntries = await readdir(privateFixture);
    const alias = join(root, "workspace-alias");
    await symlink(workspace, alias);
    const binary = join(root, "claude-namespace-fixture");
    await writeFile(
      binary,
      '#!/bin/sh\nprintf launched > native-launched\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
      { mode: 0o700 },
    );
    const credentialFile = join(root, "claude-credential.json");
    await writeFile(credentialFile, "{}");
    const host =
      native === "Codex"
        ? codexHost
        : createClaudeHost({
            binary,
            credentialFile,
            model: "synthetic",
            effort: "low",
            projectRoot: join(root, "project"),
            resultsRoot: join(root, "results"),
            additionalProtectedRoots: [],
          });
    const running = host.run({
      prompt: "Use external runtime.",
      workspace: viaAlias ? alias : workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
      },
    });
    expect(running).rejects.toThrow(
      "native runtime namespace overlaps the fixture workspace",
    );
    await running.catch(() => undefined);
    expect(await Bun.file(join(workspace, "native-launched")).exists()).toBe(
      false,
    );
    expect(await readdir(join(workspace, ".git"))).toEqual(gitEntries);
    expect(await readdir(privateFixture)).toEqual(privateEntries);
    expect(await readFile(peerFile, "utf8")).toBe("retained peer");
  },
);

test.skipIf(process.platform !== "darwin").each([
  { native: "Claude", viaAlias: false },
  { native: "Claude", viaAlias: true },
  { native: "Codex", viaAlias: false },
  { native: "Codex", viaAlias: true },
])(
  "$native runtime refuses a namespace within the fixture: alias $viaAlias",
  async ({ native, viaAlias }) => {
    const { root, workspace, bin } = await codexFixture(
      "printf launched > native-launched",
    );
    expect(Bun.spawnSync(["git", "init", "--quiet", workspace]).exitCode).toBe(
      0,
    );
    const gitEntries = await readdir(join(workspace, ".git"));
    const namespace = join(workspace, "sevro-native-private");
    const peer = join(namespace, "claude-peer", "runtime", "home");
    await mkdir(peer, { recursive: true, mode: 0o700 });
    const peerFile = join(peer, "review.json");
    await writeFile(peerFile, "retained peer");
    const alias = join(root, "workspace-alias");
    await symlink(workspace, alias);
    const binary = join(bin, "claude-workspace-runtime");
    await writeFile(
      binary,
      '#!/bin/sh\nprintf launched > native-launched\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
      { mode: 0o700 },
    );
    const credentialFile = join(root, "claude-credential.json");
    await writeFile(credentialFile, "{}");
    const codexBinary = join(bin, "candidate");
    await cp(join(root, "candidate"), codexBinary);
    const host =
      native === "Codex"
        ? createCodexHost({
            binary: codexBinary,
            sandboxBinary: defined(Bun.which("codex")),
            authFile: join(root, "auth.json"),
            model: "synthetic",
            effort: "low",
            projectRoot: join(root, "project"),
            resultsRoot: join(root, "results"),
            additionalProtectedRoots: [],
          })
        : createClaudeHost({
            binary,
            credentialFile,
            model: "synthetic",
            effort: "low",
            projectRoot: join(root, "project"),
            resultsRoot: join(root, "results"),
            additionalProtectedRoots: [],
          });
    const originalTemp = process.env.TMPDIR;
    process.env.TMPDIR = viaAlias ? alias : workspace;
    try {
      const running = host.run({
        prompt: "Use external runtime.",
        workspace,
        condition: "passive",
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
        },
      });
      expect(running).rejects.toThrow(
        "native runtime namespace overlaps the fixture workspace",
      );
      await running.catch(() => undefined);
      expect(await Bun.file(join(workspace, "native-launched")).exists()).toBe(
        false,
      );
      expect(await readdir(join(workspace, ".git"))).toEqual(gitEntries);
      expect(await readdir(namespace)).toEqual(["claude-peer"]);
      expect(await readFile(peerFile, "utf8")).toBe("retained peer");
    } finally {
      if (originalTemp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTemp;
    }
  },
  30000,
);

test.skipIf(process.platform !== "darwin").each([false, true])(
  "Claude runtime refuses a namespace within implicit native temp writes: alias %s",
  async (viaAlias) => {
    const { root, workspace } = await codexFixture();
    const unsafeTemp = join(
      "/tmp/claude",
      `sevro-runtime-probe-${randomUUID()}`,
    );
    await mkdir(unsafeTemp, { recursive: true, mode: 0o700 });
    roots.push(unsafeTemp);
    const aliasContainer = await mkdtemp(
      join(tmpdir(), "sevro-runtime-alias-"),
    );
    roots.push(aliasContainer);
    const alias = join(aliasContainer, "temp");
    await symlink(unsafeTemp, alias);
    const binary = join(root, "claude-unsafe-runtime");
    await writeFile(
      binary,
      '#!/bin/sh\nprintf launched > native-launched\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
      { mode: 0o700 },
    );
    const credentialFile = join(root, "claude-credential.json");
    await writeFile(credentialFile, "{}");
    const host = createClaudeHost({
      binary,
      credentialFile,
      model: "synthetic",
      effort: "low",
      projectRoot: join(root, "project"),
      resultsRoot: join(root, "results"),
      additionalProtectedRoots: [],
    });
    const originalTemp = process.env.TMPDIR;
    process.env.TMPDIR = viaAlias ? alias : unsafeTemp;
    try {
      const running = host.run({
        prompt: "Use external runtime.",
        workspace,
        condition: "passive",
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
        },
      });
      expect(running).rejects.toThrow("implicit native writable root");
      await running.catch(() => undefined);
      expect(await Bun.file(join(workspace, "native-launched")).exists()).toBe(
        false,
      );
    } finally {
      if (originalTemp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTemp;
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "Claude managed workspace refuses implicit native temp writes without a runtime policy",
  async () => {
    const { root } = await codexFixture();
    const unsafeTemp = join(
      "/tmp/claude",
      `sevro-workspace-probe-${randomUUID()}`,
    );
    await mkdir(unsafeTemp, { recursive: true, mode: 0o700 });
    roots.push(unsafeTemp);
    const binary = join(root, "claude-unsafe-workspace");
    await writeFile(
      binary,
      '#!/bin/sh\nprintf launched > native-launched\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
      { mode: 0o700 },
    );
    const credentialFile = join(root, "claude-credential.json");
    await writeFile(credentialFile, "{}");
    const host = createClaudeHost({
      binary,
      credentialFile,
      model: "synthetic",
      effort: "low",
      projectRoot: join(root, "project"),
      resultsRoot: join(root, "results"),
      additionalProtectedRoots: [],
    });
    let workspace = "";
    const originalTemp = process.env.TMPDIR;
    process.env.TMPDIR = unsafeTemp;
    try {
      const { result } = await runEvaluation({
        projectRoot: join(root, "project"),
        resultsRoot: join(root, "results"),
        runnerBuildDigest: "a".repeat(64),
        projectDigest: "b".repeat(64),
        condition: "passive",
        trialCount: 1,
        passThreshold: 1,
        host: {
          ...host,
          run(request) {
            workspace = request.workspace;
            return host.run(request);
          },
        },
        case: {
          id: "unsafe-workspace",
          prompt: "Return ready",
          fixture: { files: {} },
          checks: [],
          requiredEvidence: [],
        },
      });
      expect(result.execution.status).toBe("failed");
      expect(await Bun.file(join(workspace, "native-launched")).exists()).toBe(
        false,
      );
    } finally {
      if (originalTemp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTemp;
    }
  },
);

function expectedRuntimeFailure(
  native: string,
  ending: string,
): string | boolean {
  if (ending === "failure")
    return native === "Codex" ? "Codex event stream has no thread start" : true;
  return `${native} run ${runtimeEnding(native, ending)}`;
}

function runtimeEnding(native: string, ending: string): string {
  if (native === "Codex" && ending === "timeout")
    return "timed out after 0.5 s";
  return ending === "timeout" ? "timed out" : "cancelled";
}

test.each([
  { native: "Codex", ending: "failure" },
  { native: "Codex", ending: "timeout" },
  { native: "Codex", ending: "cancel" },
  { native: "Claude", ending: "failure" },
  { native: "Claude", ending: "timeout" },
  { native: "Claude", ending: "cancel" },
])(
  "$native removes external runtime after $ending",
  async ({ native, ending }) => {
    const fixture = await codexFixture("probe", [], 500);
    const binary = join(fixture.root, "candidate");
    await writeFile(
      binary,
      `#!/bin/sh
mkdir -p "$RUNTIME_ROOT/home"
printf artifact > "$RUNTIME_ROOT/home/state"
printf "%s" "$RUNTIME_ROOT" > runtime-root
${ending === "failure" ? "exit 1" : "/bin/sleep 20"}
`,
      { mode: 0o700 },
    );
    let host = fixture.host;
    if (native === "Claude") {
      const credentialFile = join(fixture.root, "claude-credential.json");
      await writeFile(credentialFile, "{}");
      host = createClaudeHost({
        binary,
        credentialFile,
        model: "synthetic",
        effort: "low",
        projectRoot: join(fixture.root, "project"),
        resultsRoot: join(fixture.root, "results"),
        additionalProtectedRoots: [],
        timeoutMs: 500,
      });
    }
    const controller = new AbortController();
    const running = host.run({
      prompt: "Allocate private runtime state.",
      workspace: fixture.workspace,
      condition: "passive",
      signal: controller.signal,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: { RUNTIME_ROOT: "{{sevro.runtime}}" },
        readOnlyRoots: [],
      },
    });
    const outcome = running.then(
      (result) => result.executionFailed,
      runtimeFailureMessage,
    );
    await waitForNativeCommand(join(fixture.workspace, "runtime-root"));
    if (ending === "cancel") controller.abort();
    expect(await outcome).toBe(expectedRuntimeFailure(native, ending));
    const runtime = await readFile(
      join(fixture.workspace, "runtime-root"),
      "utf8",
    );
    expect(runtime.startsWith(`${fixture.workspace}/`)).toBe(false);
    expect(await Bun.file(join(runtime, "home/state")).exists()).toBe(false);
  },
  30000,
);

test("Codex candidate commands use private runtime seeds", async () => {
  const { host, workspace, root } = await codexFixture(
    '/bin/cat "$UV_CACHE_DIR/input"; /bin/echo changed > "$UV_CACHE_DIR/input"',
  );
  const source = join(root, "seed");
  await mkdir(source);
  await writeFile(join(source, "input"), "seeded");
  const result = await host.run({
    prompt: "Use the private cache.",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { UV_CACHE_DIR: "{{sevro.runtime}}/cache" },
      readOnlyRoots: [],
      seeds: [
        { source, target: "cache", sha256: await runtimeSeedDigest(source) },
      ],
    },
  });
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("seeded");
  expect(await readFile(join(source, "input"), "utf8")).toBe("seeded");
}, 30000);

test("Codex refuses a seed changed after its configuration snapshot", async () => {
  const { host, workspace, root } = await codexFixture();
  const source = join(root, "seed");
  await mkdir(source);
  await writeFile(join(source, "input"), "original");
  const sha256 = await runtimeSeedDigest(source);
  await writeFile(join(source, "input"), "changed");
  expect(
    host.run({
      prompt: "Return ready.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        seeds: [{ source, target: "cache", sha256 }],
      },
    }),
  ).rejects.toThrow("changed after");
});

test("Codex runtime seeds ignore repository-local state planted by the candidate", async () => {
  const { host, workspace, root } = await codexFixture(
    '/bin/cat "$CACHE/input"',
  );
  const source = join(root, "seed");
  await mkdir(source);
  await writeFile(join(source, "input"), "trusted");
  const directory = join(workspace, ".git/sevro-runtime/candidate");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "cache"), "not a directory");
  const result = await host.run({
    prompt: "Return ready.",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { CACHE: "{{sevro.runtime}}/cache" },
      readOnlyRoots: [],
      seeds: [
        { source, target: "cache", sha256: await runtimeSeedDigest(source) },
      ],
    },
  });
  expect(result.finalMessage).toBe("trusted");
  expect(await readFile(join(directory, "cache"), "utf8")).toBe(
    "not a directory",
  );
});

test("Codex rejects runner-owned environment values in direct runtime requests", async () => {
  const { host, workspace } = await codexFixture();
  expect(
    host.run({
      prompt: "Return ready.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: { NODE_OPTIONS: "--no-warnings" },
        readOnlyRoots: [],
      },
    }),
  ).rejects.toThrow("protected");
});

// Keep the public evaluation invocation and both role outcomes together; bounded by the 200-line test rule.
// eslint-disable-next-line max-lines-per-function
test("evaluation applies the selected runtime policy to semantic and advisory hosts", async () => {
  const { root } = await codexFixture();
  const host: HostAdapter = {
    id: "runtime.candidate",
    model: "fixture",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      if (
        request.runtimePolicy?.environment.SEVRO_RUNTIME_SAMPLE !== "selected"
      )
        throw new Error("runtime unavailable");
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [{ id: "meaning", verdict: "pass", reason: "Ready" }],
        }),
      });
    },
  };
  const advisoryHost: HostAdapter = {
    ...host,
    id: "runtime.advisory",
    run(request) {
      if (
        request.runtimePolicy?.environment.SEVRO_RUNTIME_SAMPLE !== "selected"
      )
        throw new Error("runtime unavailable");
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
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
          summary: "Ready",
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "results-evaluation"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    advisoryHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { SEVRO_RUNTIME_SAMPLE: "selected" },
      readOnlyRoots: [],
    },
    case: {
      id: "runtime-roles",
      prompt: "Return ready.",
      fixture: {
        kind: "generated",
        commits: [{ message: "baseline", files: { "README.md": "baseline" } }],
      },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The response is ready." },
        },
      ],
      requiredEvidence: [],
    },
  });
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(result.task.verdict, JSON.stringify(evidence.trials)).toBe("passed");
  expect(defined(evidence.trials[0]).advisoryReview?.status).toBe("completed");
});

test("response-only semantic grading omits implicit dependency seeds", async () => {
  const { root } = await codexFixture();
  const received: unknown[] = [];
  const host: HostAdapter = {
    id: "runtime.candidate",
    model: "fixture",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      received.push(request.runtimePolicy?.seeds);
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [{ id: "meaning", verdict: "pass", reason: "Ready" }],
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "semantic-results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      seeds: [
        {
          source: join(root, "dependencies"),
          target: "cache",
          sha256: "c".repeat(64),
        },
      ],
    },
    case: {
      id: "response-runtime",
      prompt: "Return ready.",
      fixture: { files: {} },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The response is ready." },
        },
      ],
      requiredEvidence: [],
    },
  });
  expect(result.task.verdict).toBe("passed");
  expect(received).toEqual([[]]);
});

test("response-only semantic grading preserves original seed source denial", async () => {
  const { root } = await codexFixture();
  const received: unknown[] = [];
  const host: HostAdapter = {
    id: "runtime.candidate",
    model: "fixture",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      received.push(request.runtimePolicy);
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [{ id: "meaning", verdict: "pass", reason: "Ready" }],
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "semantic-results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      seeds: [
        {
          source: join(root, "dependencies"),
          target: "cache",
          sha256: "c".repeat(64),
        },
      ],
    },
    case: {
      id: "response-runtime",
      prompt: "Return ready.",
      fixture: { files: {} },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The response is ready." },
        },
      ],
      requiredEvidence: [],
    },
  });
  expect(result.task.verdict).toBe("passed");
  expect(received).toMatchObject([
    { seeds: [], seedReadDenyRoots: [join(root, "dependencies")] },
  ]);
});

test("response-only semantic grading retains explicitly selected semantic seeds", async () => {
  const { root } = await codexFixture();
  const received: unknown[] = [];
  const host: HostAdapter = {
    id: "runtime.candidate",
    model: "fixture",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      received.push(request.runtimePolicy?.seeds);
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [{ id: "meaning", verdict: "pass", reason: "Ready" }],
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "semantic-results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      seeds: [
        {
          source: join(root, "dependencies"),
          target: "cache",
          sha256: "c".repeat(64),
          roles: ["semantic"],
        },
      ],
    },
    case: {
      id: "response-runtime",
      prompt: "Return ready.",
      fixture: { files: {} },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The response is ready." },
        },
      ],
      requiredEvidence: [],
    },
  });
  expect(result.task.verdict).toBe("passed");
  expect(received).toEqual([
    [
      {
        source: join(root, "dependencies"),
        target: "cache",
        sha256: "c".repeat(64),
        roles: ["semantic"],
      },
    ],
  ]);
});

test.each(["..", "home", "tmp"])(
  "Codex refuses reserved or escaping runtime seed target: %s",
  async (target) => {
    const { host, root, workspace } = await codexFixture();
    const source = join(root, "seed");
    await mkdir(source);
    expect(
      host.run({
        prompt: "Return ready.",
        workspace,
        condition: "passive",
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
          seeds: [{ source, target, sha256: await runtimeSeedDigest(source) }],
        },
      }),
    ).rejects.toThrow("target");
  },
);

test("evaluation refuses credential-bearing runtime policy before creating results", async () => {
  const { root } = await codexFixture();
  const resultsRoot = join(root, "private-results");
  const host: HostAdapter = {
    id: "runtime.stub",
    model: "synthetic",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  expect(
    runEvaluation({
      projectRoot: root,
      resultsRoot,
      runnerBuildDigest: "a".repeat(64),
      projectDigest: "b".repeat(64),
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
      host,
      case: {
        id: "credential-runtime",
        prompt: "Return ready",
        fixture: { files: {} },
        checks: [],
        requiredEvidence: [],
      },
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: { OPENAI_API_KEY: "synthetic-private-value" },
        readOnlyRoots: [],
      },
    }),
  ).rejects.toThrow("protected");
  expect(await Bun.file(resultsRoot).exists()).toBe(false);
});

test("Codex refuses native-goal runtime policy on the exec route", async () => {
  const { host, workspace } = await codexFixture();
  expect(
    host.run({
      prompt: "Complete the native goal.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        hooks: { nativeGoal: true },
      },
    }),
  ).rejects.toThrow("app-server");
});

test("evaluation snapshots runtime values before a caller changes them", async () => {
  const { root } = await codexFixture();
  const policy = {
    format: "sevro.runtime.v1" as const,
    environment: { SEVRO_RUNTIME_SAMPLE: "selected" },
    readOnlyRoots: [],
  };
  const host: HostAdapter = {
    id: "runtime.stub",
    model: "synthetic",
    effort: "none",
    run() {
      policy.environment.SEVRO_RUNTIME_SAMPLE = "changed";
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [
            {
              id: "meaning",
              verdict:
                request.runtimePolicy?.environment.SEVRO_RUNTIME_SAMPLE ===
                "selected"
                  ? "pass"
                  : "fail",
              reason: "Runtime value observed",
            },
          ],
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "snapshot-results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    case: {
      id: "snapshot-runtime",
      prompt: "Return ready",
      fixture: { files: {} },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The runtime is selected." },
        },
      ],
      requiredEvidence: [],
    },
    runtimePolicy: policy,
  });
  expect(result.task.verdict).toBe("passed");
});

test("Codex can reuse a declared native installation under the real home", async () => {
  const { root, workspace, bin } = await codexFixture();
  const installation = await realpath(
    await mkdtemp(join(homedir(), ".sevro-native-runtime-")),
  );
  roots.push(installation);
  const binary = join(installation, "candidate");
  await writeFile(binary, await readFile(join(root, "candidate")), {
    mode: 0o700,
  });
  const host = createCodexHost({
    binary,
    sandboxBinary: defined(Bun.which("codex")),
    authFile: join(root, "auth.json"),
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [join(root, "auth.json")],
    model: "synthetic",
    effort: "low",
  });
  const result = await host.run({
    prompt: "Return probe output",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {
        PATH: `${bin}:/usr/bin:/bin`,
        SEVRO_RUNTIME_SAMPLE: "from caller",
      },
      readOnlyRoots: [installation, bin],
    },
  });
  expect(result.finalMessage).toBe("from caller");
});

test("Codex declared PATH preserves fixture tool access", async () => {
  const { host, workspace } = await codexFixture("fixture-probe");
  const fixtureBinDir = join(workspace, ".git/fixture-bin");
  await mkdir(fixtureBinDir, { recursive: true });
  await writeFile(
    join(fixtureBinDir, "fixture-probe"),
    '#!/bin/sh\nprintf "fixture wins"\n',
    { mode: 0o700 },
  );
  const result = await host.run({
    prompt: "Return fixture output",
    workspace,
    fixtureBinDir,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { PATH: "/usr/bin:/bin" },
      readOnlyRoots: [],
    },
  });
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("fixture wins");
});

test("evaluation retains complete native runtime policy evidence", async () => {
  const { host, root, bin } = await codexFixture();
  const { result } = await runEvaluation({
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    case: {
      id: "runtime-evidence",
      prompt: "Return probe output",
      fixture: { files: {} },
      checks: [],
      requiredEvidence: ["sevro.host.runtime"],
    },
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {
        PATH: `${bin}:/usr/bin:/bin`,
        SEVRO_RUNTIME_SAMPLE: "from caller",
      },
      readOnlyRoots: [bin],
    },
  });
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  const observation = defined(evidence.trials[0]).observations.find(
    (row) => row.id === "sevro.host.runtime",
  );
  expect(observation?.completeness).toBe("complete");
  expect(observation?.data.environmentNames).toContain("SEVRO_RUNTIME_SAMPLE");
  expect(observation?.data.role).toBe("candidate");
});

test("Codex reuses verified dependency bytes while keeping trials and source independent", async () => {
  const { host, root, workspace } = await codexFixture(
    'cat "$PUBLIC_CACHE_DIR/value"; printf candidate > "$PUBLIC_CACHE_DIR/value"',
  );
  const source = join(root, "dependencies");
  await mkdir(source);
  await writeFile(join(source, "value"), "verified");
  const runtimePolicy = {
    format: "sevro.runtime.v1" as const,
    environment: { PUBLIC_CACHE_DIR: "{{sevro.runtime}}/cache" },
    readOnlyRoots: [],
    seeds: [
      { source, target: "cache", sha256: await runtimeSeedDigest(source) },
    ],
  };
  const first = await host.run({
    prompt: "Return dependency",
    workspace,
    condition: "passive",
    runtimePolicy,
  });
  expect(first.finalMessage).toBe("verified");
  expect(await readFile(join(source, "value"), "utf8")).toBe("verified");
  await writeFile(join(source, "value"), "operator replacement");
  const peer = join(root, "peer");
  await mkdir(peer);
  const second = await host.run({
    prompt: "Return dependency",
    workspace: peer,
    condition: "passive",
    runtimePolicy,
  });
  expect(second.finalMessage).toBe("verified");
  expect(await readFile(join(source, "value"), "utf8")).toBe(
    "operator replacement",
  );
}, 60_000);

test("artifact semantic grading keeps implicit dependency seeds", async () => {
  const { root } = await codexFixture();
  const received: unknown[] = [];
  const host: HostAdapter = {
    id: "runtime.candidate",
    model: "fixture",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const seed = {
    source: join(root, "dependencies"),
    target: "cache",
    sha256: "c".repeat(64),
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      received.push(request.runtimePolicy?.seeds);
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [{ id: "meaning", verdict: "pass", reason: "Ready" }],
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "semantic-results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      seeds: [seed],
    },
    case: {
      id: "artifact-runtime",
      prompt: "Return ready.",
      fixture: { files: { "answer.md": "ready" } },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: {
            proposition: "The artifact is ready.",
            artifactPath: "answer.md",
          },
        },
      ],
      requiredEvidence: [],
    },
  });
  expect(result.task.verdict).toBe("passed");
  expect(received).toEqual([[seed]]);
});
