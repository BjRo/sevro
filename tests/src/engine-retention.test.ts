import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { runEvaluation, type HostAdapter } from "../../src/engine";
import {
  defined,
  expectUnknown,
  parseRecord,
  parseRunEvidence,
} from "../fixtures/assertions";
import {
  baseCase,
  digest,
  failedRetentionOptions,
  rootsForRun,
  runRetentionInIsolation,
} from "../fixtures/engine";
import { createTemporaryFixtures } from "../fixtures/filesystem";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("engine retains a failed candidate workspace while preserving saved evidence", async () => {
  const paths = await rootsForRun(roots);
  let workspace = "";
  const outcome = await runEvaluation({
    ...paths,
    case: baseCase,
    host: {
      id: "sevro.host.synthetic",
      model: "synthetic-v1",
      effort: "none",
      run(request) {
        workspace = request.workspace;
        return Promise.resolve({
          finalMessage: null,
          complete: false,
          executionFailed: true,
        });
      },
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  roots.push(workspace);
  expect(outcome.result.exitCode).toBe(2);
  expect(await Bun.file(outcome.result.evidencePath).exists()).toBe(true);
  expect(existsSync(workspace)).toBe(true);
  expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
    "fixture content\n",
  );
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  const observation = defined(
    defined(evidence.trials[0]).observations.find(
      (item) => item.id === "sevro.observation.workspaces",
    ),
  );
  expectUnknown(observation.data).toMatchObject({ candidate: workspace });
});

test("engine retains the semantic workspace when grading fails", async () => {
  const paths = await rootsForRun(roots);
  let workspace = "";
  const outcome = await runEvaluation({
    ...paths,
    case: {
      ...baseCase,
      checks: [
        {
          id: "ready",
          grader: "sevro.semantic",
          configuration: { proposition: "The response is ready." },
        },
      ],
    },
    host: {
      id: "example.candidate",
      model: "synthetic",
      effort: "none",
      run() {
        return Promise.resolve({ finalMessage: "ready", complete: true });
      },
    },
    semanticHost: {
      id: "example.semantic",
      model: "synthetic",
      effort: "none",
      async run(request) {
        workspace = request.workspace;
        await writeFile(join(workspace, "failure-details"), "inspect me");
        throw new Error("controlled grader failure");
      },
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  roots.push(workspace);
  expect(outcome.result.exitCode).toBe(3);
  expect(await Bun.file(join(workspace, "failure-details")).exists()).toBe(
    true,
  );
});

test("engine retains the candidate workspace when required grading evidence is unavailable", async () => {
  const paths = await rootsForRun(roots);
  let workspace = "";
  const { result } = await runEvaluation({
    ...paths,
    case: { ...baseCase, requiredEvidence: ["example.required-trace"] },
    host: {
      id: "example.incomplete-evidence",
      model: "synthetic",
      effort: "none",
      run(request) {
        workspace = request.workspace;
        return Promise.resolve({ finalMessage: "ready", complete: true });
      },
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  roots.push(workspace);
  expect(result).toMatchObject({
    execution: { status: "completed" },
    grading: { status: "unavailable" },
    task: { verdict: "not_assessed" },
    exitCode: 4,
  });
  expect(await Bun.file(join(workspace, "README.md")).exists()).toBe(true);
  expect(await Bun.file(result.evidencePath).exists()).toBe(true);
});

test("engine startup expires inactive failed workspaces after a day without deleting evidence", async () => {
  if (
    await runRetentionInIsolation(
      roots,
      import.meta.path,
      "engine startup expires inactive failed workspaces after a day without deleting evidence",
    )
  )
    return;
  const paths = await rootsForRun(roots);
  let workspace = "";
  const options = {
    ...paths,
    case: baseCase,
    host: {
      id: "sevro.host.synthetic",
      model: "synthetic-v1",
      effort: "none",
      run(request: Parameters<HostAdapter["run"]>[0]) {
        workspace = request.workspace;
        return Promise.resolve({
          finalMessage: null,
          complete: false,
          executionFailed: true,
        });
      },
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    const first = await runEvaluation(options);
    const retained = workspace;
    roots.push(retained);
    const evidence = await readFile(first.result.evidencePath, "utf8");
    clock.mockReturnValue(now + 24 * 60 * 60_000 - 1);
    await runEvaluation(options);
    roots.push(workspace);
    expect(existsSync(retained)).toBe(true);
    clock.mockReturnValue(now + 24 * 60 * 60_000 + 1);
    await runEvaluation(options);
    roots.push(workspace);
    expect(existsSync(retained)).toBe(false);
    expect(await readFile(first.result.evidencePath, "utf8")).toBe(evidence);
  } finally {
    clock.mockRestore();
  }
});

test("engine startup preserves an active workspace older than a day", async () => {
  if (
    await runRetentionInIsolation(
      roots,
      import.meta.path,
      "engine startup preserves an active workspace older than a day",
    )
  )
    return;
  const paths = await rootsForRun(roots);
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let workspace = "";
  const options = {
    ...paths,
    case: baseCase,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
  const active = runEvaluation({
    ...options,
    host: {
      id: "example.active",
      model: "synthetic",
      effort: "none",
      async run(request) {
        workspace = request.workspace;
        entered.resolve(undefined);
        await release.promise;
        return { finalMessage: "ready", complete: true };
      },
    },
  });
  await entered.promise;
  const clock = spyOn(Date, "now").mockReturnValue(
    Date.now() + 24 * 60 * 60_000 + 1,
  );
  try {
    await runEvaluation({
      ...options,
      host: {
        id: "example.peer",
        model: "synthetic",
        effort: "none",
        run() {
          return Promise.resolve({ finalMessage: "ready", complete: true });
        },
      },
    });
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "fixture content\n",
    );
  } finally {
    release.resolve(undefined);
    await active;
    clock.mockRestore();
  }
});

test("engine startup removes expired ownership records after a workspace was deleted manually", async () => {
  if (
    await runRetentionInIsolation(
      roots,
      import.meta.path,
      "engine startup removes expired ownership records after a workspace was deleted manually",
    )
  )
    return;
  const paths = await rootsForRun(roots);
  let workspace = "";
  const options = {
    ...paths,
    case: baseCase,
    host: {
      id: "example.failure",
      model: "synthetic",
      effort: "none",
      run(request: Parameters<HostAdapter["run"]>[0]) {
        workspace = request.workspace;
        return Promise.resolve({
          finalMessage: null,
          complete: false,
          executionFailed: true,
        });
      },
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
  await runEvaluation(options);
  const recordPath = join(
    dirname(workspace),
    ".owners",
    `${basename(workspace)}.json`,
  );
  const record = parseRecord(await readFile(recordPath, "utf8"));
  await writeFile(
    recordPath,
    JSON.stringify({
      ...record,
      timestamp: Date.now() - 24 * 60 * 60_000 - 1000,
    }),
    { mode: 0o600 },
  );
  await rm(workspace, { recursive: true });
  await runEvaluation(options);
  roots.push(workspace);
  expect(await Bun.file(recordPath).exists()).toBe(false);
});

test("engine startup preserves a workspace with unreadable ownership metadata", async () => {
  const name =
    "engine startup preserves a workspace with unreadable ownership metadata";
  if (await runRetentionInIsolation(roots, import.meta.path, name)) return;
  const paths = await rootsForRun(roots);
  let workspace = "";
  const options = {
    ...paths,
    case: baseCase,
    host: {
      id: "example.failure",
      model: "synthetic",
      effort: "none",
      run(request: Parameters<HostAdapter["run"]>[0]) {
        workspace = request.workspace;
        return Promise.resolve({
          finalMessage: null,
          complete: false,
          executionFailed: true,
        });
      },
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
  const first = await runEvaluation(options);
  const retained = workspace;
  roots.push(retained);
  const evidence = await readFile(first.result.evidencePath, "utf8");
  const metadata = join(
    dirname(retained),
    ".owners",
    `${basename(retained)}.json`,
  );
  await chmod(metadata, 0);
  const clock = spyOn(Date, "now").mockReturnValue(
    Date.now() + 24 * 60 * 60_000 + 1000,
  );
  try {
    const next = await runEvaluation(options);
    roots.push(workspace);
    expect(next.result.exitCode).toBe(2);
    expect(await readFile(join(retained, "README.md"), "utf8")).toBe(
      "fixture content\n",
    );
    expect(await readFile(first.result.evidencePath, "utf8")).toBe(evidence);
  } finally {
    clock.mockRestore();
    await chmod(metadata, 0o600);
  }
});

test("engine startup preserves expired workspaces with unverifiable ownership", async () => {
  const name =
    "engine startup preserves expired workspaces with unverifiable ownership";
  if (await runRetentionInIsolation(roots, import.meta.path, name)) return;
  const paths = await rootsForRun(roots);
  let workspace = "";
  const options = failedRetentionOptions(paths, (path) => {
    workspace = path;
  });
  const first = await runEvaluation(options);
  const retained = workspace;
  roots.push(retained);
  const metadata = join(
    dirname(retained),
    ".owners",
    `${basename(retained)}.json`,
  );
  const original = parseRecord(await readFile(metadata, "utf8"));
  const expired = {
    ...original,
    timestamp: Date.now() - 24 * 60 * 60_000 - 1000,
  };
  const evidence = await readFile(first.result.evidencePath, "utf8");
  const invalidRecords = [
    "{broken",
    "null",
    JSON.stringify({ ...expired, format: "unrecognized" }),
    JSON.stringify({ ...expired, state: "unrecognized" }),
    JSON.stringify({ ...expired, timestamp: "yesterday" }),
    JSON.stringify({ ...expired, timestamp: null }),
    JSON.stringify({ ...expired, owner: null }),
    JSON.stringify({
      ...expired,
      owner: { pid: 0, startedAt: "unknown", host: "unknown" },
    }),
    JSON.stringify({
      ...expired,
      owner: {
        ...parseRecord(JSON.stringify(original.owner)),
        host: "unrecognized",
      },
    }),
    " ".repeat(4097),
  ];
  for (const bytes of invalidRecords) {
    await writeFile(metadata, bytes, { mode: 0o600 });
    await runEvaluation(options);
    roots.push(workspace);
    expect(
      await readFile(join(retained, "README.md"), "utf8"),
      bytes.slice(0, 200),
    ).toBe("fixture content\n");
  }
  await writeFile(metadata, JSON.stringify(expired));
  await chmod(metadata, 0o644);
  await runEvaluation(options);
  roots.push(workspace);
  expect(await readFile(join(retained, "README.md"), "utf8")).toBe(
    "fixture content\n",
  );
  await rm(metadata);
  await runEvaluation(options);
  roots.push(workspace);
  expect(await readFile(join(retained, "README.md"), "utf8")).toBe(
    "fixture content\n",
  );
  const external = join(paths.projectRoot, "external-owner.json");
  await writeFile(external, JSON.stringify(expired));
  await symlink(external, metadata);
  await runEvaluation(options);
  roots.push(workspace);
  expect(await readFile(join(retained, "README.md"), "utf8")).toBe(
    "fixture content\n",
  );
  expect(await readFile(external, "utf8")).toBe(JSON.stringify(expired));
  expect(await readFile(first.result.evidencePath, "utf8")).toBe(evidence);
});

test("engine startup cleanup tolerates concurrent evaluations expiring the same workspace", async () => {
  const name =
    "engine startup cleanup tolerates concurrent evaluations expiring the same workspace";
  if (await runRetentionInIsolation(roots, import.meta.path, name)) return;
  const paths = await rootsForRun(roots);
  let workspace = "";
  const options = failedRetentionOptions(paths, (path) => {
    workspace = path;
    roots.push(path);
  });
  for (let round = 0; round < 10; round++) {
    await runEvaluation(options);
    const retained = workspace;
    const metadata = join(
      dirname(retained),
      ".owners",
      `${basename(retained)}.json`,
    );
    const original = parseRecord(await readFile(metadata, "utf8"));
    await writeFile(
      metadata,
      JSON.stringify({
        ...original,
        timestamp: Date.now() - 24 * 60 * 60_000 - 1000,
      }),
    );
    const outcomes = await Promise.all(
      [0, 1, 2, 3].map((peer) =>
        runEvaluation({
          ...options,
          case: { ...baseCase, id: `concurrent-cleanup-${round}-${peer}` },
        }),
      ),
    );
    expect(outcomes.map((outcome) => outcome.result.exitCode)).toEqual([
      2, 2, 2, 2,
    ]);
    expect(existsSync(retained)).toBe(false);
  }
});
