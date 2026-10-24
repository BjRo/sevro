import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defined,
  parseCliResult,
  parseRecord,
  parseReport,
  parseRunEvidence,
} from "../fixtures/assertions";
import { createTemporaryFixtures } from "../fixtures/filesystem";

const repo = resolve(import.meta.dir, "../..");
const cli = join(repo, "src/cli.ts");
const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

async function nativeFixture(extraArtifacts: string[] = []) {
  const { root, results } = await fixture(0);
  const adapter = join(root, "native-host.ts");
  const bundle = JSON.stringify({
    format: "sevro.native-transcripts.v1",
    host: "codex",
    role: "candidate",
    rootSessionId: null,
    completeness: "unavailable",
    issues: ["root_session_unknown"],
    files: [
      {
        path: "rollout-root.jsonl",
        sha256: createHash("sha256")
          .update('{"type":"message"}\n')
          .digest("hex"),
        bytesBase64: Buffer.from('{"type":"message"}\n').toString("base64"),
      },
    ],
  });
  await writeFile(
    adapter,
    `export default {
    id: "fixture.native", model: "fixture", effort: "none",
    run() { return Promise.resolve({ finalMessage: "ready", complete: true,
      artifacts: ${JSON.stringify(["sevro.native-transcripts.bundle", ...extraArtifacts])}.map(id => ({ id, bytes: Buffer.from(${JSON.stringify(bundle)}) })),
      observations: [{ id: "sevro.host.native-transcripts", completeness: "unavailable",
        data: { files: ${JSON.stringify([{ path: "rollout-root.jsonl", sha256: createHash("sha256").update('{"type":"message"}\n').digest("hex") }])}, issues: ["root_session_unknown"] } }]
    }); }
  };`,
  );
  const run = await nativeRun(root, adapter);
  const evidencePath = defined(parseCliResult(run.stdout).evidencePath);
  const resultPath = join(dirname(evidencePath), "result.json");
  const evidenceBefore = await readFile(evidencePath, "utf8");
  const resultBefore = await readFile(resultPath, "utf8");
  const latestBefore = await readFile(join(results, "latest.json"), "utf8");
  const evidence = parseRunEvidence(evidenceBefore);
  const transcript = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (item) => item.id === "sevro.native-transcripts.bundle",
    ),
  );
  return {
    root,
    results,
    adapter,
    evidencePath,
    resultPath,
    evidenceBefore,
    resultBefore,
    latestBefore,
    evidence,
    transcript,
  };
}

async function nativeRun(root: string, adapter: string) {
  const run = await command(root, [
    "run",
    "--json",
    "--case-file",
    join(repo, "examples/basic/graded.json"),
    "--adapter-module",
    adapter,
    "--runner-build-digest",
    "a".repeat(64),
    "--project-digest",
    "b".repeat(64),
  ]);
  expect(run.code, run.stderr).toBe(0);
  return run;
}

test("prune native transcripts preserves results and hashes and reports pruned bundles", async () => {
  const {
    root,
    results,
    evidencePath,
    resultPath,
    evidenceBefore,
    resultBefore,
    latestBefore,
    transcript,
  } = await nativeFixture();
  const pruned = await command(root, ["prune", "--native-transcripts"]);
  expect(pruned.code, pruned.stderr).toBe(0);
  await expectMissing(fileURLToPath(transcript.path));
  expect(await readFile(evidencePath, "utf8")).toBe(evidenceBefore);
  expect(await readFile(resultPath, "utf8")).toBe(resultBefore);
  expect(await readFile(join(results, "latest.json"), "utf8")).toBe(
    latestBefore,
  );
  const report = await command(root, ["report", "--latest", "--json"]);
  expect(report.code, report.stderr).toBe(0);
  expect(parseRecord(report.stdout).rows).toMatchObject([
    { nativeTranscripts: { retained: 0, pruned: 1 }, task: "passed" },
  ]);
  const human = await command(root, ["report", "--result-file", resultPath]);
  expect(human.code, human.stderr).toBe(0);
  expect(human.stdout).toContain("native transcripts: 0 retained, 1 pruned");
});

test.each(["changed", "outside"])(
  "transcript pruning refuses %s bytes before deleting or marking evidence",
  async (kind) => {
    const { root, results, evidence, evidencePath, transcript, latestBefore } =
      await nativeFixture();
    const original = fileURLToPath(transcript.path);
    let protectedPath = original;
    if (kind === "changed") await writeFile(original, "changed native bytes");
    else {
      protectedPath = join(root, "outside.bundle");
      await writeFile(protectedPath, await readFile(original));
      transcript.path = pathToFileURL(protectedPath).href;
      await writeFile(evidencePath, JSON.stringify(evidence));
    }
    const protectedBytes = await readFile(protectedPath, "utf8");
    const pruned = await command(root, ["prune", "--native-transcripts"]);
    expect(pruned.code, pruned.stderr).toBe(64);
    expect(pruned.stderr).toContain("native transcript");
    expect(await readFile(protectedPath, "utf8")).toBe(protectedBytes);
    expect(await readFile(join(results, "latest.json"), "utf8")).toBe(
      latestBefore,
    );
    await expectMissing(
      join(dirname(evidencePath), "native-transcripts-pruned.json"),
    );
  },
);

test("transcript pruning refuses aliases of retained result metadata", async () => {
  const { root, evidence, evidencePath, resultPath, resultBefore, transcript } =
    await nativeFixture();
  transcript.path = pathToFileURL(resultPath).href;
  transcript.sha256 = createHash("sha256").update(resultBefore).digest("hex");
  await writeFile(evidencePath, JSON.stringify(evidence));
  const pruned = await command(root, ["prune", "--native-transcripts"]);
  expect(pruned.code, pruned.stderr).toBe(64);
  expect(pruned.stderr).toContain("native transcript");
  expect(await readFile(resultPath, "utf8")).toBe(resultBefore);
  await expectMissing(
    join(dirname(resultPath), "native-transcripts-pruned.json"),
  );
});

test.each(["artifact", "candidate"])(
  "transcript pruning refuses non-transcript aliases: %s",
  async (kind) => {
    const { root, evidence, evidencePath, transcript } = await nativeFixture([
      "fixture.output",
    ]);
    const trial = defined(evidence.trials[0]);
    const target =
      kind === "candidate"
        ? defined(trial.rawResult.path)
        : defined(trial.artifactRefs.find((ref) => ref.id === "fixture.output"))
            .path;
    const bytes = await readFile(fileURLToPath(target));
    transcript.path = target;
    transcript.sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(evidencePath, JSON.stringify(evidence));
    const pruned = await command(root, ["prune", "--native-transcripts"]);
    expect(pruned.code, pruned.stderr).toBe(64);
    expect(await readFile(fileURLToPath(target))).toEqual(bytes);
  },
);

test.each([
  { policy: ["--keep", "1"] },
  { policy: ["--latest"] },
  { policy: ["--older-than", "1d"] },
])(
  "transcript pruning applies result selection $policy while retaining every result",
  async ({ policy }) => {
    const { root, adapter, resultPath, transcript } = await nativeFixture();
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(resultPath, old, old);
    const second = await nativeRun(root, adapter);
    const secondEvidence = defined(parseCliResult(second.stdout).evidencePath);
    const latest = parseRunEvidence(await readFile(secondEvidence, "utf8"));
    const latestBundle = defined(
      defined(latest.trials[0]).artifactRefs.find(
        (item) => item.id === "sevro.native-transcripts.bundle",
      ),
    );
    const pruned = await command(root, [
      "prune",
      "--native-transcripts",
      ...policy,
    ]);
    expect(pruned.code, pruned.stderr).toBe(0);
    await expectMissing(fileURLToPath(transcript.path));
    expect((await stat(fileURLToPath(latestBundle.path))).isFile()).toBe(true);
    expect(
      (await command(root, ["report", "--result-file", resultPath])).code,
    ).toBe(0);
    const report = await command(root, ["report", "--latest", "--json"]);
    expect(report.code, report.stderr).toBe(0);
    expect(parseRecord(report.stdout).rows).toMatchObject([
      { nativeTranscripts: { retained: 1, pruned: 0 } },
    ]);
  },
);

test("transcript pruning selects only candidate semantic and advisory bundle identities", async () => {
  const customId = "fixture.sevro.native-transcripts.bundle";
  const { root, evidence } = await nativeFixture([
    "sevro.semantic.sevro.native-transcripts.bundle",
    `sevro.semantic.${"a".repeat(64)}.sevro.native-transcripts.bundle`,
    "sevro.advisory.sevro.native-transcripts.bundle",
    customId,
    "sevro.host.diagnostics",
  ]);
  const pruned = await command(root, ["prune", "--native-transcripts"]);
  expect(pruned.code, pruned.stderr).toBe(0);
  const refs = defined(evidence.trials[0]).artifactRefs;
  const custom = defined(refs.find((item) => item.id === customId));
  expect((await stat(fileURLToPath(custom.path))).isFile()).toBe(true);
  const diagnostics = defined(
    refs.find((item) => item.id === "sevro.host.diagnostics"),
  );
  expect((await stat(fileURLToPath(diagnostics.path))).isFile()).toBe(true);
  const report = await command(root, ["report", "--latest", "--json"]);
  expect(report.code, report.stderr).toBe(0);
  expect(parseRecord(report.stdout).rows).toMatchObject([
    { nativeTranscripts: { retained: 0, pruned: 4 } },
  ]);
});

test("report requires an intact matching pruning receipt for absent native bytes", async () => {
  const { root, evidencePath, resultPath, transcript } = await nativeFixture();
  const before = await readFile(fileURLToPath(transcript.path));
  await rm(fileURLToPath(transcript.path));
  const missing = await command(root, ["report", "--latest"]);
  expect(missing.code).toBe(64);
  expect(missing.stderr).toContain("missing without a pruning record");
  await writeFile(fileURLToPath(transcript.path), before);
  expect((await command(root, ["prune", "--native-transcripts"])).code).toBe(0);
  const path = join(dirname(evidencePath), "native-transcripts-pruned.json");
  const receipt = await readFile(path, "utf8");
  for (const content of [
    "{",
    receipt.replace(transcript.sha256, "f".repeat(64)),
    receipt.replace("sevro.pruned-native-transcripts.v1", "unknown"),
  ]) {
    await writeFile(path, content);
    expect(
      (await command(root, ["report", "--result-file", resultPath])).code,
    ).toBe(64);
    expect((await command(root, ["prune", "--native-transcripts"])).code).toBe(
      64,
    );
  }
  await writeFile(path, receipt);
  const external = join(root, "external-receipt.json");
  await rename(path, external);
  await symlink(external, path);
  expect((await command(root, ["report", "--latest"])).code).toBe(64);
  expect((await command(root, ["prune", "--native-transcripts"])).code).toBe(
    64,
  );
});

test("transcript pruning serializes retries and remains compatible with whole-result pruning", async () => {
  const { root, resultPath, evidencePath, evidenceBefore } =
    await nativeFixture();
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      command(root, ["prune", "--native-transcripts"]),
    ),
  );
  for (const attempt of attempts) expect(attempt.code, attempt.stderr).toBe(0);
  expect(
    attempts.filter((attempt) =>
      attempt.stdout.includes("Removed 1 native transcript bundle(s)"),
    ),
  ).toHaveLength(1);
  expect(await readFile(evidencePath, "utf8")).toBe(evidenceBefore);
  expect((await command(root, ["report", "--latest"])).code).toBe(0);
  const old = new Date("2020-01-01T00:00:00Z");
  await utimes(resultPath, old, old);
  expect((await command(root, ["prune", "--older-than", "1d"])).code).toBe(0);
  await expectMissing(dirname(resultPath));
});

test.each(["active", "unrecognized"])(
  "transcript pruning protects %s attempts",
  async (status) => {
    const { root, results, evidence, transcript } = await nativeFixture();
    const record = join(results, "active", `${evidence.runId}.json`);
    const active = parseRecord(await readFile(record, "utf8"));
    active.status = status;
    await writeFile(record, JSON.stringify(active));
    const pruned = await command(root, ["prune", "--native-transcripts"]);
    expect(pruned.code, pruned.stderr).toBe(0);
    expect((await stat(fileURLToPath(transcript.path))).isFile()).toBe(true);
  },
);

test("transcript pruning is a no-op without captured transcripts or completed results", async () => {
  const { root } = await fixture(0);
  expect((await command(root, ["prune", "--native-transcripts"])).code).toBe(0);
  const completed = await fixture(1);
  const pruned = await command(completed.root, [
    "prune",
    "--native-transcripts",
  ]);
  expect(pruned.code, pruned.stderr).toBe(0);
  expect(pruned.stdout).toContain(
    "Removed 0 native transcript bundle(s); kept 1 result(s)",
  );
  await expectMissing(
    join(
      dirname(defined(completed.paths[0])),
      "native-transcripts-pruned.json",
    ),
  );
  expect((await command(completed.root, ["report", "--latest"])).code).toBe(0);
});

test("prune latest keeps only the newest result and repairs a stale index", async () => {
  const { root, results, paths } = await fixture(3);
  await writeFile(
    join(results, "latest.json"),
    await readFile(defined(paths[0])),
  );
  const pruned = await command(root, ["prune", "--latest"]);
  expect(pruned.code, pruned.stderr).toBe(0);
  for (const path of paths.slice(0, 2)) await expectMissing(dirname(path));
  const report = await command(root, ["report", "--latest", "--json"]);
  expect(report.code, report.stderr).toBe(0);
  expect(parseReport(report.stdout).rows[0]?.runId).toBe(
    parseCliResult(await readFile(defined(paths[2]), "utf8")).runId,
  );
});

async function command(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

async function expectMissing(path: string) {
  const code = await stat(path).then(
    () => null,
    (cause: unknown) => (cause as NodeJS.ErrnoException).code,
  );
  expect(code).toBe("ENOENT");
}

async function fixture(
  count: number,
  extra: (root: string) => string[] = () => [],
) {
  const root = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-prune-")),
  );

  const results = join(root, ".sevro/results");
  const paths: string[] = [];
  for (let index = 0; index < count; index++) {
    const run = await command(root, [
      "run",
      "--json",
      "--case-file",
      join(repo, "examples/basic/graded.json"),
      "--adapter-module",
      join(repo, "examples/basic/host.ts"),
      "--runner-build-digest",
      "a".repeat(64),
      "--project-digest",
      "b".repeat(64),
      ...extra(root),
    ]);
    expect(run.code, run.stderr).toBe(0);
    const path = join(
      dirname(defined(parseCliResult(run.stdout).evidencePath)),
      "result.json",
    );
    const time = new Date(
      `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    );
    await utimes(path, time, time);
    paths.push(path);
  }
  return { root, results, paths };
}

test("prune keeps the requested count across repeated runs and preserves reporting", async () => {
  const { root, results, paths } = await fixture(3);
  const pruned = await command(root, [
    "prune",
    "--results-root",
    ".sevro/results",
    "--keep",
    "2",
  ]);
  expect(pruned.code, pruned.stderr).toBe(0);
  expect(pruned.stdout).toContain("Removed 1 result");
  await expectMissing(dirname(defined(paths[0])));
  for (const path of paths.slice(1)) {
    const report = await command(root, [
      "report",
      "--result-file",
      path,
      "--json",
    ]);
    expect(report.code, report.stderr).toBe(0);
    expect(parseReport(report.stdout).summary.passed).toBe(1);
  }
  const latest = await command(root, ["report", "--latest", "--json"]);
  expect(latest.code, latest.stderr).toBe(0);
  expect(
    parseCliResult(await readFile(join(results, "latest.json"), "utf8")).runId,
  ).toBe(parseCliResult(await readFile(defined(paths[2]), "utf8")).runId);
});

test("prune age removes expired results and clears latest when none remain", async () => {
  const { root, results, paths } = await fixture(2);
  const recent = defined(paths[1]);
  const now = new Date();
  await utimes(recent, now, now);
  const pruned = await command(root, ["prune", "--older-than", "30d"]);
  expect(pruned.code, pruned.stderr).toBe(0);
  await expectMissing(dirname(defined(paths[0])));
  const report = await command(root, ["report", "--latest", "--json"]);
  expect(report.code, report.stderr).toBe(0);
  expect(parseReport(report.stdout).rows[0]?.runId).toBe(
    parseCliResult(await readFile(recent, "utf8")).runId,
  );
  const old = new Date("2020-01-01T00:00:00Z");
  await utimes(recent, old, old);
  const empty = await command(root, ["prune", "--older-than", "30d"]);
  expect(empty.code, empty.stderr).toBe(0);
  await expectMissing(dirname(recent));
  await expectMissing(join(results, "latest.json"));
  expect((await command(root, ["report", "--latest"])).code).toBe(64);
});

test("prune defaults to the newest ten results in the invoking project", async () => {
  const { root, paths } = await fixture(11);
  const pruned = await command(root, ["prune"]);
  expect(pruned.code, pruned.stderr).toBe(0);
  expect(pruned.stdout).toContain("Removed 1 result(s); kept 10");
  await expectMissing(dirname(defined(paths[0])));
  for (const path of paths.slice(1))
    expect((await stat(path)).isFile()).toBe(true);
});

test("prune preserves active and unverifiable attempts outside the retention count", async () => {
  const { root, results, paths } = await fixture(3);
  const oldest = defined(paths[0]);
  const id = defined(parseCliResult(await readFile(oldest, "utf8")).runId);
  const record = join(results, "active", `${id}.json`);
  const active = parseRecord(await readFile(record, "utf8"));
  active.status = "active";
  await writeFile(record, JSON.stringify(active));
  const pruned = await command(root, ["prune", "--latest"]);
  expect(pruned.code, pruned.stderr).toBe(0);
  expect((await stat(oldest)).isFile()).toBe(true);
  await expectMissing(dirname(defined(paths[1])));
  active.status = "unrecognized";
  await writeFile(record, JSON.stringify(active));
  const again = await command(root, ["prune", "--older-than", "1ms"]);
  expect(again.code, again.stderr).toBe(0);
  expect((await stat(oldest)).isFile()).toBe(true);
  expect(await readFile(record, "utf8")).toBe(JSON.stringify(active));
});

test("parent prune preserves nested active and unrecognized ownership outside the count", async () => {
  const { root, results, paths } = await fixture(3);
  for (const [index, status] of ["active", "unrecognized"].entries()) {
    const path = defined(paths[index + 1]);
    const id = defined(parseCliResult(await readFile(path, "utf8")).runId);
    const record = join(results, "active", `${id}.json`);
    const value = parseRecord(await readFile(record, "utf8"));
    value.status = status;
    await writeFile(record, JSON.stringify(value));
  }
  const pruned = await command(root, [
    "prune",
    "--results-root",
    root,
    "--latest",
  ]);
  expect(pruned.code, pruned.stderr).toBe(0);
  expect(pruned.stdout).toContain("Removed 0 result(s); kept 1");
  for (const path of paths) expect((await stat(path)).isFile()).toBe(true);
});

test.each([{ mode: [] }, { mode: ["--native-transcripts"] }])(
  "parent prune and CLI publication wait for the nested root lock $mode",
  async ({ mode }) => {
    const { root, results, paths } = await fixture(1);
    const lock = new Database(join(results, ".retention-lock.sqlite"));
    lock.run("BEGIN IMMEDIATE");
    let settled = false;
    let publicationSettled = false;
    const pruning = command(root, [
      "prune",
      "--results-root",
      root,
      ...mode,
      "--older-than",
      "1d",
    ]).then((value) => {
      settled = true;
      return value;
    });
    const publishing = command(root, [
      "run",
      "--json",
      "--case-file",
      join(repo, "examples/basic/graded.json"),
      "--adapter-module",
      join(repo, "examples/basic/host.ts"),
      "--runner-build-digest",
      "a".repeat(64),
      "--project-digest",
      "b".repeat(64),
    ]).then((value) => {
      publicationSettled = true;
      return value;
    });
    try {
      await Bun.sleep(300);
      expect(settled).toBe(false);
      expect(publicationSettled).toBe(false);
      expect((await stat(defined(paths[0]))).isFile()).toBe(true);
    } finally {
      lock.close();
      await Promise.all([pruning, publishing]);
    }
    const pruned = await pruning;
    const published = await publishing;
    expect(pruned.code, pruned.stderr).toBe(0);
    expect(published.code, published.stderr).toBe(0);
    expect((await command(root, ["report", "--latest"])).code).toBe(0);
  },
);

test("parent prune repairs nested latest indexes for surviving results", async () => {
  const { root, results, paths } = await fixture(3);
  await writeFile(
    join(results, "latest.json"),
    await readFile(defined(paths[0])),
  );
  const pruned = await command(root, [
    "prune",
    "--results-root",
    root,
    "--latest",
  ]);
  expect(pruned.code, pruned.stderr).toBe(0);
  const report = await command(root, ["report", "--latest", "--json"]);
  expect(report.code, report.stderr).toBe(0);
  expect(parseReport(report.stdout).rows[0]?.runId).toBe(
    parseCliResult(await readFile(defined(paths[2]), "utf8")).runId,
  );
});

test.each(["active", "unrecognized"])(
  "parent transcript prune protects nested %s ownership and excludes it from count",
  async (status) => {
    const { root, results, adapter, transcript, resultPath } =
      await nativeFixture();
    const second = await nativeRun(root, adapter);
    const result = parseCliResult(second.stdout);
    const secondPath = join(
      dirname(defined(result.evidencePath)),
      "result.json",
    );
    const recordPath = join(results, "active", `${defined(result.runId)}.json`);
    const record = parseRecord(await readFile(recordPath, "utf8"));
    record.status = status;
    await writeFile(recordPath, JSON.stringify(record));
    const old = new Date("2000-01-01T00:00:00Z");
    await utimes(resultPath, old, old);
    const bytes = await readFile(fileURLToPath(transcript.path));
    const pruned = await command(root, [
      "prune",
      "--results-root",
      root,
      "--native-transcripts",
      "--keep",
      "1",
    ]);
    expect(pruned.code, pruned.stderr).toBe(0);
    expect(pruned.stdout).toContain(
      "Removed 0 native transcript bundle(s); kept 1 result(s)",
    );
    expect(await readFile(fileURLToPath(transcript.path))).toEqual(bytes);
    expect((await stat(secondPath)).isFile()).toBe(true);
    await expectMissing(
      join(dirname(secondPath), "native-transcripts-pruned.json"),
    );
  },
);

test("parent prune preserves ownership above relocated nested attempts despite closer completed records", async () => {
  const { root, results, paths } = await fixture(2);
  const original = defined(paths[0]);
  const id = defined(parseCliResult(await readFile(original, "utf8")).runId);
  const recordPath = join(results, "active", `${id}.json`);
  const record = parseRecord(await readFile(recordPath, "utf8"));
  const nested = await nestedAttempt(results, original);
  await mkdir(join(dirname(dirname(nested)), "active"), { recursive: true });
  await writeFile(
    join(dirname(dirname(nested)), "active", `${id}.json`),
    JSON.stringify(record),
  );
  record.status = "active";
  await writeFile(recordPath, JSON.stringify(record));
  await rm(join(results, ".retention-lock.sqlite"));
  await rm(join(results, "latest.json"));
  const pruned = await command(root, [
    "prune",
    "--results-root",
    root,
    "--latest",
  ]);
  expect(pruned.code, pruned.stderr).toBe(0);
  expect(pruned.stdout).toContain("Removed 0 result(s); kept 1");
  expect((await stat(nested)).isFile()).toBe(true);
  expect((await command(root, ["report", "--latest"])).code).toBe(0);
});

test.each(["active", ".retention-lock.sqlite"])(
  "parent prune refuses nested linked coordination %s before deleting results",
  async (name) => {
    const { root, results, paths } = await fixture(2);
    const target = join(results, name);
    const external = join(root, "external-coordination");
    await rename(target, external);
    await symlink(external, target);
    const latest = await readFile(join(results, "latest.json"), "utf8");
    const pruned = await command(root, [
      "prune",
      "--results-root",
      root,
      "--older-than",
      "1d",
    ]);
    expect(pruned.code, pruned.stderr).toBe(64);
    for (const path of paths) expect((await stat(path)).isFile()).toBe(true);
    expect(await readFile(join(results, "latest.json"), "utf8")).toBe(latest);
  },
);

async function nestedAttempt(results: string, path: string) {
  const old = dirname(path);
  const destination = join(results, "campaign", "attempts", "older-attempt");
  await mkdir(dirname(destination), { recursive: true });
  await rename(old, destination);
  for (const name of await readdir(destination, { recursive: true })) {
    if (!name.endsWith(".json")) continue;
    const file = join(destination, name);
    await writeFile(
      file,
      (await readFile(file, "utf8")).replaceAll(old, destination),
    );
  }
  const result = join(destination, "result.json");
  const oldTime = new Date("2020-01-01T00:00:00Z");
  await utimes(result, oldTime, oldTime);
  return result;
}

test("prune counts nested attempts and removes their complete evidence trees", async () => {
  const { root, results, paths } = await fixture(2);
  const nested = await nestedAttempt(results, defined(paths[0]));
  expect((await command(root, ["report", "--result-file", nested])).code).toBe(
    0,
  );
  const pruned = await command(root, ["prune", "--latest"]);
  expect(pruned.code, pruned.stderr).toBe(0);
  await expectMissing(dirname(nested));
  expect((await command(root, ["report", "--latest"])).code).toBe(0);
});

test("concurrent prune commands serialize deletion and leave a reportable latest", async () => {
  const { root, paths } = await fixture(4);
  const commands = await Promise.all(
    Array.from({ length: 8 }, () => command(root, ["prune", "--latest"])),
  );
  for (const result of commands) expect(result.code, result.stderr).toBe(0);
  expect((await command(root, ["report", "--latest"])).code).toBe(0);
  for (const path of paths.slice(0, 3)) await expectMissing(dirname(path));
});

test("prune refuses linked result files before deleting any evidence", async () => {
  const { root, results, paths } = await fixture(2);
  const oldest = defined(paths[0]);
  const external = join(root, "external-result.json");
  const content = await readFile(oldest, "utf8");
  await rename(oldest, external);
  await symlink(external, oldest);
  const before = await readFile(join(results, "latest.json"), "utf8");
  const pruned = await command(root, ["prune", "--older-than", "1ms"]);
  expect(pruned.code).toBe(64);
  expect(pruned.stderr).toContain("regular file");
  for (const path of paths) expect((await stat(path)).isFile()).toBe(true);
  expect(await readFile(external, "utf8")).toBe(content);
  expect(await readFile(join(results, "latest.json"), "utf8")).toBe(before);
});

test.each(["run.json", "active", "lock"])(
  "prune refuses linked storage records: %s",
  async (kind) => {
    const { root, results, paths } = await fixture(1);
    const result = defined(paths[0]);
    const id = defined(parseCliResult(await readFile(result, "utf8")).runId);
    const targets: Record<string, string> = {
      "run.json": join(dirname(result), "run.json"),
      active: join(results, "active", `${id}.json`),
      lock: join(results, ".retention-lock.sqlite"),
    };
    const target = defined(targets[kind]);
    const external = join(root, "external-record");
    await rename(target, external);
    await symlink(external, target);
    const pruned = await command(root, ["prune", "--older-than", "1ms"]);
    expect(pruned.code).toBe(64);
    expect(pruned.stderr).toContain("regular file");
    expect((await stat(result)).isFile()).toBe(true);
  },
);

test("prune is a harmless no-op before the first run and on an empty results root", async () => {
  const { root, results } = await fixture(0);
  const missing = await command(root, ["prune"]);
  expect(missing.code, missing.stderr).toBe(0);
  expect(missing.stdout).toContain("Removed 0 result(s); kept 0");
  await expectMissing(results);
  await mkdir(results, { recursive: true });
  const empty = await command(root, ["prune"]);
  expect(empty.code, empty.stderr).toBe(0);
  expect(empty.stdout).toContain("Removed 0 result(s); kept 0");
});

test("prune rejects invalid policies without changing retained evidence or latest", async () => {
  const { root, results, paths } = await fixture(2);
  const before = await readFile(join(results, "latest.json"), "utf8");
  const invalid = [
    ...["0", "-1", "1.5", "NaN", "9007199254740992", ""].map((value) => [
      "--keep",
      value,
    ]),
    ...["0d", "1.5d", "30", "9007199254740991w", ""].map((value) => [
      "--older-than",
      value,
    ]),
    ["--latest", "--keep", "1"],
    ["--latest", "--older-than", "1d"],
    ["--keep", "2", "--older-than", "1d"],
    ["--results-root", ""],
    ["unexpected"],
    ["--unknown"],
  ];
  for (const args of invalid) {
    const pruned = await command(root, ["prune", ...args]);
    expect(pruned.code, JSON.stringify(args)).toBe(64);
    expect(pruned.stderr).not.toBe("");
  }
  for (const path of paths) expect((await stat(path)).isFile()).toBe(true);
  expect(await readFile(join(results, "latest.json"), "utf8")).toBe(before);
});

test("prune supports an aliased results root without following descendant directory links", async () => {
  const { root, results, paths } = await fixture(2);
  const external = await fixture(1);
  await symlink(external.results, join(results, "external"));
  await symlink(results, join(root, "alias"));
  const pruned = await command(root, [
    "prune",
    "--results-root",
    "alias",
    "--latest",
  ]);
  expect(pruned.code, pruned.stderr).toBe(0);
  await expectMissing(dirname(defined(paths[0])));
  expect((await stat(defined(external.paths[0]))).isFile()).toBe(true);
  expect((await command(external.root, ["report", "--latest"])).code).toBe(0);
});

test("prune validates all evidence before deleting a result or changing latest", async () => {
  const { root, results, paths } = await fixture(2);
  const first = defined(paths[0]);
  const evidence = join(dirname(first), "run.json");
  const record = parseRecord(await readFile(evidence, "utf8"));
  record.runId = "inconsistent";
  await writeFile(evidence, JSON.stringify(record));
  const before = await readFile(join(results, "latest.json"), "utf8");
  const pruned = await command(root, ["prune", "--latest"]);
  expect(pruned.code).toBe(64);
  expect(pruned.stderr).toContain("differs");
  for (const path of paths) expect((await stat(path)).isFile()).toBe(true);
  expect(await readFile(join(results, "latest.json"), "utf8")).toBe(before);
});

test("prune retains reportable dry results with separate run-state storage", async () => {
  const { root, paths } = await fixture(2, (root) => [
    "--dry",
    "--run-state-root",
    join(root, "state"),
  ]);
  const pruned = await command(root, ["prune", "--latest"]);
  expect(pruned.code, pruned.stderr).toBe(0);
  await expectMissing(dirname(defined(paths[0])));
  expect((await readdir(join(root, "state", "active"))).length).toBe(2);
  const report = await command(root, ["report", "--latest", "--json"]);
  expect(report.code, report.stderr).toBe(0);
  expect(parseReport(report.stdout).rows[0]?.task).toBe("not_assessed");
});

test("prune breaks equal-time ties by path and accepts every documented age unit", async () => {
  const { root, results, paths } = await fixture(2);
  const future = new Date("2100-01-01T00:00:00Z");
  for (const path of paths) await utimes(path, future, future);
  for (const unit of ["ms", "s", "m", "h", "d", "w"]) {
    const pruned = await command(root, ["prune", "--older-than", `1${unit}`]);
    expect(pruned.code, pruned.stderr).toBe(0);
    expect(pruned.stdout).toContain("Removed 0 result(s); kept 2");
  }
  const latest = parseCliResult(
    await readFile(join(results, "latest.json"), "utf8"),
  );
  expect(latest.runId).toBe(
    parseCliResult(await readFile(defined([...paths].sort()[0]), "utf8")).runId,
  );
});
