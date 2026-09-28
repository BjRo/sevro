import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "../src/cli.ts");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(trials: number) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-concurrency-")),
  );
  roots.push(root);
  const project = join(root, "project");
  await mkdir(project);
  const caseFile = join(project, "case.json");
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "parallel",
      prompt: "Return ready.",
      fixture: { files: { marker: "original" } },
      checks: [
        {
          id: "answer",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
      requiredEvidence: [],
    }),
  );
  const adapter = join(root, "adapter.ts");
  await writeFile(
    adapter,
    `import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
let active = 0, peak = 0, ordinal = 0;
let release;
const firstPair = new Promise(resolve => { release = resolve; });
export default {
  id: "test.parallel", model: "synthetic", effort: "low",
  async run({ workspace, condition }) {
    const position = ++ordinal;
    active++;
    peak = Math.max(peak, active);
    if (active === 2) release();
    const original = await readFile(join(workspace, "marker"), "utf8");
    await writeFile(join(workspace, "marker"), String(position));
    if (position <= 2) await Promise.race([firstPair, Bun.sleep(1000)]);
    await Bun.sleep(position === 1 ? 50 : 5);
    active--;
    return { finalMessage: "ready", complete: true, actualCondition: condition,
      observations: [{ id: "test.parallel.sample", completeness: "complete", data: { position, peak, workspace, original } }] };
  },
};\n`,
  );
  const args = [
    process.execPath,
    cli,
    "run",
    "--json",
    "--case-file",
    caseFile,
    "--adapter-module",
    adapter,
    "--project-root",
    project,
    "--results-root",
    join(root, "results"),
    "--run-state-root",
    join(root, "state"),
    "--runner-build-digest",
    "a".repeat(64),
    "--project-digest",
    "b".repeat(64),
    "--condition",
    "passive",
    "--trials",
    String(trials),
    "--threshold",
    "1",
  ];
  return { root, args, adapter };
}

async function invoke(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code, result: JSON.parse(stdout) };
}

test("CLI bounds parallel trials and retains ordered isolated evidence", async () => {
  const { root, args } = await fixture(5);
  const run = await invoke([...args, "--jobs", "2"]);
  expect(run.code, run.stderr).toBe(0);
  expect(
    run.result.cases[0].trials.map((trial: { trial: number }) => trial.trial),
  ).toEqual([1, 2, 3, 4, 5]);
  const evidence = JSON.parse(await readFile(run.result.evidencePath, "utf8"));
  expect(evidence.configuration.redacted.jobs).toBe(2);
  expect(
    evidence.trials.map((trial: { trial: number }) => trial.trial),
  ).toEqual([1, 2, 3, 4, 5]);
  const samples = evidence.trials.map(
    (trial: {
      observations: {
        id: string;
        data: { peak: number; workspace: string; original: string };
      }[];
    }) =>
      trial.observations.find((row) => row.id === "test.parallel.sample")!.data,
  );
  expect(
    Math.max(...samples.map((sample: { peak: number }) => sample.peak)),
  ).toBe(2);
  expect(
    new Set(samples.map((sample: { workspace: string }) => sample.workspace))
      .size,
  ).toBe(5);
  for (const sample of samples) {
    expect(sample.original).toBe("original");
    expect(await Bun.file(join(sample.workspace, "marker")).exists()).toBe(
      false,
    );
  }
  const checkpoint = JSON.parse(
    await readFile(
      join(root, "state", run.result.runId, "checkpoint.json"),
      "utf8",
    ),
  );
  expect(
    checkpoint.completedTrials.map((trial: { trial: number }) => trial.trial),
  ).toEqual([1, 2, 3, 4, 5]);
  for (const trial of run.result.cases[0].trials)
    expect(
      JSON.parse(await readFile(trial.artifactPath, "utf8")).result,
    ).toEqual(trial);
  expect(dirname(run.result.evidencePath)).toBe(
    join(root, "results", run.result.runId),
  );
});

test("CLI parallel cancellation drains active trials and stops queued trials", async () => {
  const { root, args, adapter } = await fixture(6);
  const started = join(root, "started");
  const stopped = join(root, "stopped");
  await mkdir(started);
  await mkdir(stopped);
  await writeFile(
    adapter,
    `import { writeFile } from "node:fs/promises";
import { join } from "node:path";
let ordinal = 0;
export default {
  id: "test.parallel-cancel", model: "synthetic", effort: "low",
  async run({ workspace, signal }) {
    const position = ++ordinal;
    const cancelled = new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new Error("cancelled"));
      else signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    cancelled.catch(() => {});
    await writeFile(join(${JSON.stringify(started)}, String(position)), workspace);
    try { await cancelled; }
    finally { await writeFile(join(${JSON.stringify(stopped)}, String(position)), workspace); }
  },
};\n`,
  );
  const child = Bun.spawn([...args, "--jobs", "2"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  try {
    const deadline = Date.now() + 5000;
    while ((await readdir(started)).length < 2) {
      if (Date.now() >= deadline)
        throw new Error("parallel hosts did not start");
      await Bun.sleep(20);
    }
    child.kill("SIGINT");
    const [stdout, stderr, code] = await Promise.all([
      output,
      errors,
      child.exited,
    ]);
    expect(code, stderr).toBe(130);
    const result = JSON.parse(stdout);
    expect(result.execution.status).toBe("cancelled");
    expect(result.cases[0].trials).toHaveLength(2);
    expect(
      result.cases[0].trials.every(
        (trial: { execution: { status: string } }) =>
          trial.execution.status === "cancelled",
      ),
    ).toBe(true);
    expect((await readdir(started)).sort()).toEqual(["1", "2"]);
    expect((await readdir(stopped)).sort()).toEqual(["1", "2"]);
    const active = JSON.parse(
      await readFile(
        join(root, "state", "active", `${result.runId}.json`),
        "utf8",
      ),
    );
    expect(active.status).toBe("interrupted");
    expect(active.completedTrials).toHaveLength(2);
    for (const name of await readdir(started)) {
      const workspace = await readFile(join(started, name), "utf8");
      expect(await Bun.file(join(workspace, "marker")).exists()).toBe(false);
    }
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
}, 10_000);

test("CLI parallel persistence failure retains a completed peer before finalizing", async () => {
  const { root, args, adapter } = await fixture(6);
  const started = join(root, "started");
  await mkdir(started);
  await writeFile(
    adapter,
    `import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
let ordinal = 0;
export default {
  id: "test.parallel-persistence", model: "synthetic", effort: "low",
  async run({ workspace, condition }) {
    const position = ++ordinal;
    await writeFile(join(${JSON.stringify(started)}, String(position)), workspace);
    if (position === 1) {
      const run = (await readdir(${JSON.stringify(join(root, "results"))}))[0];
      for (const trial of [1, 2]) await mkdir(join(${JSON.stringify(join(root, "results"))}, run, "trial-" + trial + "-host-test.fault.bin"));
      return { finalMessage: "ready", complete: true, actualCondition: condition,
        artifacts: [{ id: "test.fault", bytes: new Uint8Array([1]) }] };
    }
    await Bun.sleep(100);
    return { finalMessage: "ready", complete: true, actualCondition: condition };
  },
};\n`,
  );
  const run = await invoke([...args, "--jobs", "2"]);
  expect(run.code, run.stderr).toBe(70);
  expect((await readdir(started)).sort()).toEqual(["1", "2"]);
  const [runId] = await readdir(join(root, "results"));
  const active = JSON.parse(
    await readFile(join(root, "state", "active", `${runId}.json`), "utf8"),
  );
  expect(active.status).toBe("diagnostic");
  expect(active.completedTrials).toHaveLength(1);
  const completed = JSON.parse(
    await readFile(active.completedTrials[0].artifactPath, "utf8"),
  );
  expect(completed.result.task.verdict).toBe("passed");
  const failedWorkspace = await readFile(join(started, "1"), "utf8");
  roots.push(failedWorkspace);
  expect(await readFile(join(failedWorkspace, "marker"), "utf8")).toBe(
    "original",
  );
  const completedWorkspace = await readFile(join(started, "2"), "utf8");
  expect(await Bun.file(join(completedWorkspace, "marker")).exists()).toBe(
    false,
  );
});

test("CLI defaults to three trial jobs and serial limits change configuration identity", async () => {
  const { args } = await fixture(4);
  const parallel = await invoke(args);
  const serial = await invoke([...args, "--jobs", "1"]);
  expect(parallel.code, parallel.stderr).toBe(0);
  expect(serial.code, serial.stderr).toBe(0);
  const concurrentEvidence = JSON.parse(
    await readFile(parallel.result.evidencePath, "utf8"),
  );
  const serialEvidence = JSON.parse(
    await readFile(serial.result.evidencePath, "utf8"),
  );
  expect(concurrentEvidence.configuration.redacted.jobs).toBe(3);
  expect(serialEvidence.configuration.redacted.jobs).toBe(1);
  const peaks = (evidence: {
    trials: { observations: { id: string; data: { peak: number } }[] }[];
  }) =>
    evidence.trials.map(
      (trial) =>
        trial.observations.find((row) => row.id === "test.parallel.sample")!
          .data.peak,
    );
  expect(Math.max(...peaks(concurrentEvidence))).toBe(3);
  expect(Math.max(...peaks(serialEvidence))).toBe(1);
  expect(concurrentEvidence.evaluationIdentity.digest).not.toBe(
    serialEvidence.evaluationIdentity.digest,
  );
});

test("CLI refuses invalid job limits before creating run storage", async () => {
  const { root, args } = await fixture(1);
  for (const value of [
    "",
    "0",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "9007199254740992",
  ]) {
    const run = await invoke([...args, `--jobs=${value}`]);
    expect(run.code).toBe(64);
    expect(run.result.execution.status).toBe("not_run");
    expect(run.result.diagnostic.message).toContain("--jobs");
  }
  expect(await readdir(root)).not.toContain("results");
  expect(await readdir(root)).not.toContain("state");
});

test("CLI retains interruption before admitting its first trial", async () => {
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    const { root, args, adapter } = await fixture(3);
    const called = join(root, "host-called");
    await writeFile(
      adapter,
      `import { writeFile } from "node:fs/promises";
let interrupted = false;
export default {
  id: "test.pre-admission-cancel", model: "synthetic", effort: "low",
  get instrumentation() {
    if (!interrupted && process.listenerCount(${JSON.stringify(signal)}) > 0) {
      interrupted = true;
      process.kill(process.pid, ${JSON.stringify(signal)});
    }
    return [];
  },
  async run() { await writeFile(${JSON.stringify(called)}, "called"); throw new Error("host must not start"); },
};\n`,
    );
    const run = await invoke([...args, "--jobs", "2"]);
    expect(run.code, run.stderr).toBe(exitCode);
    expect(run.result.execution.status).toBe("cancelled");
    expect(run.result.grading.status).toBe("not_requested");
    expect(run.result.task.verdict).toBe("not_assessed");
    expect(run.result.cases[0].trials).toEqual([]);
    expect(await Bun.file(called).exists()).toBe(false);
    const evidence = JSON.parse(
      await readFile(run.result.evidencePath, "utf8"),
    );
    expect(evidence.result).toEqual(run.result);
    expect(evidence.trials).toEqual([]);
    const owner = JSON.parse(
      await readFile(
        join(root, "state", "active", `${run.result.runId}.json`),
        "utf8",
      ),
    );
    expect(owner.status).toBe("interrupted");
    expect(owner.completedTrials).toEqual([]);
  }
});

test.skipIf(
  process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"),
)(
  "CLI sandbox denies read and write access to later admitted peer fixtures",
  async () => {
    const { root, args, adapter } = await fixture(3);
    const control = join(root, "control");
    await mkdir(control);
    const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
    const command = `
if test "$(cat role)" = 1; then
  test "$(cat marker)" = original
  printf own > own-check
  touch ${quote(join(control, "shell-ready"))}
  while ! test -f ${quote(join(control, "third"))}; do sleep 0.01; done
  peer=$(cat ${quote(join(control, "third"))})
  readable=0; writable=0
  if cat "$peer/marker" >/dev/null 2>&1; then readable=1; fi
  if (printf contaminated > "$peer/marker") 2>/dev/null; then writable=1; fi
  touch ${quote(join(control, "done"))}
  test "$readable" = 0
  test "$writable" = 0
  test "$(cat own-check)" = own
fi
printf isolated
`;
    await writeFile(
      args[args.indexOf("--case-file") + 1]!,
      JSON.stringify({
        id: "parallel",
        prompt: "Return ready.",
        fixture: {
          kind: "generated",
          commits: [
            { message: "chore: initialize", files: { marker: "original" } },
          ],
        },
        checks: [
          {
            id: "isolation",
            grader: "sevro.shell",
            configuration: {
              run: command,
              expectExact: "isolated",
              timeoutMs: 10_000,
            },
          },
        ],
        requiredEvidence: [],
      }),
    );
    await writeFile(
      adapter,
      `import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
let ordinal = 0;
async function wait(name) {
  const deadline = Date.now() + 5000;
  while (!(await access(join(${JSON.stringify(control)}, name)).then(() => true, () => false))) {
    if (Date.now() > deadline) throw new Error("barrier timed out: " + name);
    await Bun.sleep(10);
  }
}
export default {
  id: "test.future-peer", model: "synthetic", effort: "low",
  async run({ workspace, condition }) {
    const position = ++ordinal;
    await writeFile(join(workspace, "role"), String(position));
    if (position === 2) await wait("shell-ready");
    if (position === 3) {
      await writeFile(join(${JSON.stringify(control)}, "third"), workspace);
      await wait("done");
    }
    const marker = await readFile(join(workspace, "marker"), "utf8");
    return { finalMessage: "ready", complete: true, actualCondition: condition,
      observations: [{ id: "test.future-peer.sample", completeness: "complete", data: { position, marker } }] };
  },
};\n`,
    );
    const run = await invoke([...args, "--jobs", "2", "--shell-isolation"]);
    const evidence = JSON.parse(
      await readFile(run.result.evidencePath, "utf8"),
    );
    expect(run.code, JSON.stringify(evidence.result)).toBe(0);
    expect(run.result.cases[0].trials).toHaveLength(3);
    const peer = evidence.trials
      .flatMap(
        (trial: {
          observations: {
            id: string;
            data: { position: number; marker: string };
          }[];
        }) => trial.observations,
      )
      .find(
        (row: { id: string; data: { position: number } }) =>
          row.id === "test.future-peer.sample" && row.data.position === 3,
      );
    expect(peer.data.marker).toBe("original");
    expect(await readFile(join(control, "done"), "utf8")).toBe("");
  },
  15_000,
);

test("CLI closes queued admission when grading fails before advisory retention", async () => {
  const { root, args, adapter } = await fixture(4);
  const started = join(root, "started");
  await mkdir(started);
  await writeFile(
    args[args.indexOf("--case-file") + 1]!,
    JSON.stringify({
      id: "parallel",
      prompt: "Return ready.",
      fixture: {
        kind: "generated",
        commits: [
          { message: "chore: initialize", files: { marker: "original" } },
        ],
      },
      checks: [
        {
          id: "answer",
          grader: "sevro.semantic",
          configuration: { proposition: "The response says ready." },
        },
      ],
      requiredEvidence: [],
    }),
  );
  const common = `import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
async function wait(name) {
  const deadline = Date.now() + 5000;
  while (!(await access(join(${JSON.stringify(root)}, name)).then(() => true, () => false))) {
    if (Date.now() >= deadline) throw new Error("barrier timed out: " + name);
    await Bun.sleep(10);
  }
}\n`;
  await writeFile(
    adapter,
    common +
      `let ordinal = 0;
export default {
  id: "test.stop-admission", model: "synthetic", effort: "low",
  async run({ workspace, condition }) {
    const position = ++ordinal;
    await writeFile(join(${JSON.stringify(started)}, String(position)), workspace);
    await writeFile(join(workspace, "role"), String(position));
    if (position === 2) await wait("advisory-held");
    return { finalMessage: "ready" + position, complete: true, actualCondition: condition };
  },
};\n`,
  );
  const semantic = join(root, "semantic.ts");
  await writeFile(
    semantic,
    `export default {
  id: "test.required-grader", model: "synthetic", effort: "low",
  async run({ prompt, condition }) {
    if (prompt.includes('"ready1"')) throw new Error("required grader failed");
    return { finalMessage: JSON.stringify({ checks: [{ id: "answer", verdict: "pass", reason: "ready" }] }), complete: true, actualCondition: condition };
  },
};\n`,
  );
  const advisory = join(root, "advisory.ts");
  await writeFile(
    advisory,
    common +
      `export default {
  id: "test.slow-advisory", model: "synthetic", effort: "low",
  async run({ workspace, condition }) {
    const position = await readFile(join(workspace, "role"), "utf8");
    if (position === "1") {
      await writeFile(join(${JSON.stringify(root)}, "advisory-held"), "held");
      await wait("peer-reviewed");
      await Bun.sleep(500);
    } else await writeFile(join(${JSON.stringify(root)}, "peer-reviewed"), "done");
    return { finalMessage: JSON.stringify({ verdict: "pass", overallScore: 5,
      dimensions: { correctness: 5, maintainability: 5, testQuality: 5, scopeDiscipline: 5 },
      strengths: [], weaknesses: [], summary: "Synthetic review" }), complete: true, actualCondition: condition };
  },
};\n`,
  );
  const run = await invoke([
    ...args,
    "--jobs",
    "2",
    "--semantic-adapter-module",
    semantic,
    "--advisory-adapter-module",
    advisory,
  ]);
  expect(run.code, run.stderr).toBe(3);
  expect((await readdir(started)).sort()).toEqual(["1", "2"]);
  expect(run.result.cases[0].trials).toHaveLength(2);
  expect(run.result.grading.status).toBe("error");
  for (const trial of run.result.cases[0].trials)
    expect(
      JSON.parse(await readFile(trial.artifactPath, "utf8")).result,
    ).toEqual(trial);
  const evidence = JSON.parse(await readFile(run.result.evidencePath, "utf8"));
  expect(evidence.trials[0].advisoryReview.status).toBe("completed");
  expect(evidence.trials[1].advisoryReview.status).toBe("completed");
}, 15_000);

test("CLI execution failure stops queued trials and retains an active peer", async () => {
  const { root, args, adapter } = await fixture(4);
  const started = join(root, "started");
  await mkdir(started);
  await writeFile(
    adapter,
    `import { writeFile } from "node:fs/promises";
import { join } from "node:path";
let ordinal = 0;
export default {
  id: "test.execution-failure", model: "synthetic", effort: "low",
  async run({ workspace, condition }) {
    const position = ++ordinal;
    await writeFile(join(${JSON.stringify(started)}, String(position)), workspace);
    if (position === 1) return { finalMessage: "ready", complete: true, actualCondition: condition, executionFailed: true };
    await Bun.sleep(20);
    return { finalMessage: "ready", complete: true, actualCondition: condition };
  },
};\n`,
  );
  const run = await invoke([...args, "--jobs", "2"]);
  expect(run.code, run.stderr).toBe(2);
  expect((await readdir(started)).sort()).toEqual(["1", "2"]);
  expect(run.result.cases[0].trials).toHaveLength(2);
  expect(
    run.result.cases[0].trials
      .map((trial: { execution: { status: string } }) => trial.execution.status)
      .sort(),
  ).toEqual(["completed", "failed"]);
  for (const trial of run.result.cases[0].trials)
    expect(
      JSON.parse(await readFile(trial.artifactPath, "utf8")).result,
    ).toEqual(trial);
  const owner = JSON.parse(
    await readFile(
      join(root, "state", "active", `${run.result.runId}.json`),
      "utf8",
    ),
  );
  expect(owner.status).toBe("complete");
  expect(owner.completedTrials).toHaveLength(2);
});
