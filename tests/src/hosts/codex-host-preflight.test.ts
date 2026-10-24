import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runEvaluation } from "../../../src/engine";
import { createCodexHost } from "../../../src/hosts/codex";
import {
  defined,
  expectUnknown,
  parseRunEvidence,
} from "../../fixtures/assertions";
import {
  digest,
  ordinaryCodexOptions,
  ordinaryCodexRequest,
  waitForCodexMarker,
} from "../../fixtures/codex-host";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("Codex without authorized command hooks does not read hook dependencies", async () => {
  const selected = await ordinaryCodexRequest(roots);
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
  const selected = await ordinaryCodexRequest(roots);
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
    roots.push(await temporaryFixture(join(tmpdir(), "sevro-case-stale-")));
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
    const selected = await ordinaryCodexRequest(roots);
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
  const selected = await ordinaryCodexRequest(roots);
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
    const selected = await ordinaryCodexRequest(roots);
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
  const selected = await ordinaryCodexRequest(roots);
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
  const selected = await ordinaryCodexRequest(roots);
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
    const selected = await ordinaryCodexRequest(roots);
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
  const selected = await ordinaryCodexRequest(roots);
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
  const selected = await ordinaryCodexRequest(roots);
  const source = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-omitted-dependency-")),
  );

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
