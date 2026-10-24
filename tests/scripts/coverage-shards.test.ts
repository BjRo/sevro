import { afterEach, expect, test } from "bun:test";
import { createCoverageMap, type CoverageMapData } from "istanbul-lib-coverage";
import { createInstrumenter } from "istanbul-lib-instrument";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { object } from "../../scripts/coverage/records";
import { enforceThresholds } from "../../scripts/coverage/run";
import {
  mergeShardResults,
  type ShardContext,
} from "../../scripts/coverage/shard-merge";
import {
  coverageLayout,
  relocateCoverage,
} from "../../scripts/coverage/shard-output";
import {
  balanceTests,
  shardIndex,
  testShards,
} from "../../scripts/coverage/shard-plan";
import { defined } from "../fixtures/assertions";
import {
  coverageShardCandidate,
  exerciseCoverageShards,
} from "../fixtures/coverage-shards";
import { createTemporaryFixtures } from "../fixtures/filesystem";

const { temporaryFixtureSync, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

function branchCoverage(flag: boolean) {
  const instrumenter = createInstrumenter({
    coverageGlobalScope: "globalThis",
  });
  const code = instrumenter.instrumentSync(
    "function pick(flag) { if (flag) return 1; return 0; } pick(flag);",
    "/snapshot/src/pick.ts",
  );
  const context: { flag: boolean; __coverage__?: CoverageMapData } = { flag };
  runInNewContext(code, context);
  return {
    baseline: { "/snapshot/src/pick.ts": instrumenter.lastFileCoverage() },
    coverage: defined(context.__coverage__),
  };
}

function shardFixture() {
  const positive = branchCoverage(true);
  const negative = branchCoverage(false);
  const baseline = relocateCoverage(positive.baseline, "/snapshot", ".");
  const plan = balanceTests(
    ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"],
    4,
  );
  const expected: ShardContext = {
    candidate: "candidate",
    batch: "123",
    platform: "linux",
    arch: "x64",
    bun: "1.3.13",
    layout: coverageLayout(baseline),
    baseline,
    plan,
  };
  const measurements = [
    positive.coverage,
    negative.coverage,
    positive.baseline,
    negative.baseline,
  ];
  const inputs = plan.map((shard, index) => ({
    format: "sevro.coverage-shard.v1",
    candidate: expected.candidate,
    batch: expected.batch,
    platform: expected.platform,
    arch: expected.arch,
    bun: expected.bun,
    layout: expected.layout,
    runId: `run-${shard.index}`,
    shard,
    coverage: relocateCoverage(defined(measurements[index]), "/snapshot", "."),
  }));
  return { expected, inputs };
}

test("four coverage shards jointly satisfy branches that each partial run misses", () => {
  const { expected, inputs } = shardFixture();
  const partial = createCoverageMap(defined(inputs[0]).coverage);
  expect(() => {
    enforceThresholds(partial.getCoverageSummary().toJSON());
  }).toThrow("branches");
  const merged = mergeShardResults(inputs, expected);
  expect(merged.files()).toEqual(["src/pick.ts"]);
  expect(() => {
    enforceThresholds(merged.getCoverageSummary().toJSON());
  }).not.toThrow();
  expect(merged.getCoverageSummary().branches.pct).toBe(100);
});

test.each(["candidate", "batch", "platform", "arch", "bun", "layout"] as const)(
  "coverage aggregation refuses a shard with different %s",
  (field) => {
    const { expected, inputs } = shardFixture();
    defined(inputs[1])[field] = "different";
    expect(() => mergeShardResults(inputs, expected)).toThrow(
      `${field} mismatch`,
    );
  },
);

test("coverage aggregation refuses missing and duplicate shards", () => {
  const { expected, inputs } = shardFixture();
  expect(() => mergeShardResults(inputs.slice(1), expected)).toThrow(
    "Missing coverage shards",
  );
  inputs[1] = defined(inputs[0]);
  expect(() => mergeShardResults(inputs, expected)).toThrow(
    "Duplicate coverage shard",
  );
});

test("failed-job reruns can reuse passing shards from the same workflow run", () => {
  const { expected, inputs } = shardFixture();
  const attempts = inputs.map((input, index) => ({
    ...input,
    attempt: String(index + 1),
  }));
  const merged = mergeShardResults(attempts, expected);
  expect(merged.getCoverageSummary().branches.pct).toBe(100);
  defined(attempts[0]).batch = "another-workflow-run";
  expect(() => mergeShardResults(attempts, expected)).toThrow("batch mismatch");
});

test("coverage aggregation refuses reused run identities and changed file assignments", () => {
  const { expected, inputs } = shardFixture();
  const first = defined(inputs[0]);
  const second = defined(inputs[1]);
  second.runId = first.runId;
  expect(() => mergeShardResults(inputs, expected)).toThrow(
    "Duplicate coverage shard",
  );
  second.runId = "second-run";
  second.shard = { ...second.shard, files: ["other.test.ts"] };
  expect(() => mergeShardResults(inputs, expected)).toThrow(
    "assignment mismatch",
  );
});

test("coverage aggregation preserves the whole inventory and rejects incomplete counters", () => {
  const missing = shardFixture();
  Reflect.deleteProperty(defined(missing.inputs[0]).coverage, "src/pick.ts");
  expect(() => mergeShardResults(missing.inputs, missing.expected)).toThrow(
    "source inventory",
  );
  const incomplete = shardFixture();
  defined(defined(incomplete.inputs[0]).coverage["src/pick.ts"]).b = {};
  expect(() =>
    mergeShardResults(incomplete.inputs, incomplete.expected),
  ).toThrow("Incomplete coverage counters");
});

test("coverage aggregation includes unimported zero-count files in the final denominator", () => {
  const { expected, inputs } = shardFixture();
  const unused = structuredClone(defined(expected.baseline["src/pick.ts"]));
  unused.path = "src/unimported.ts";
  expected.baseline[unused.path] = unused;
  expected.layout = coverageLayout(expected.baseline);
  for (const input of inputs) {
    input.layout = expected.layout;
    input.coverage[unused.path] = structuredClone(unused);
  }
  const merged = mergeShardResults(inputs, expected);
  expect(merged.files()).toContain("src/unimported.ts");
  expect(() => {
    enforceThresholds(merged.getCoverageSummary().toJSON());
  }).toThrow("Below 95%");
});

test("coverage normalization combines different snapshot paths without changing layout", () => {
  const { baseline, coverage } = branchCoverage(true);
  const other = relocateCoverage(coverage, "/snapshot", "/another/source");
  const first = relocateCoverage(coverage, "/snapshot", ".");
  const second = relocateCoverage(other, "/another/source", ".");
  expect(second).toEqual(first);
  expect(coverageLayout(first)).toBe(
    coverageLayout(relocateCoverage(baseline, "/snapshot", ".")),
  );
  expect(() => relocateCoverage(coverage, "/outside", ".")).toThrow(
    "escapes source snapshot",
  );
});

test("the shard plan executes every discovered test file exactly once and separates guide groups", () => {
  const root = resolve(import.meta.dir, "../..");
  const plan = testShards(root);
  const assigned = plan.flatMap(({ files }) => files);
  const discovered = [
    ...new Bun.Glob("tests/**/*.test.ts").scanSync({ cwd: root }),
  ];
  expect(plan).toHaveLength(4);
  expect(assigned.sort()).toEqual(discovered.sort());
  expect(new Set(assigned).size).toBe(assigned.length);
  for (const shard of plan)
    expect(
      shard.files.filter((file) => file.startsWith("tests/guide/")),
    ).toHaveLength(1);
  expect(balanceTests(discovered.reverse(), 4)).toEqual(plan);
});

test.each(["0/4", "5/4", "1/3", "1/4extra", undefined])(
  "shard selection refuses invalid index %s",
  (value) => {
    expect(() => shardIndex(value)).toThrow("Expected --shard");
  },
);

test("public shard commands merge real subprocess counters and enforce coverage once", async () => {
  const root = temporaryFixtureSync(
    resolve(tmpdir(), "sevro-shard-integration-"),
  );
  try {
    const project = await coverageShardCandidate(
      resolve(import.meta.dir, "../.."),
      root,
    );
    const observed = await exerciseCoverageShards(project);
    const percentages = observed.runs.map(
      (run) => object(object(object(run).summary).branches).pct,
    );
    expect(percentages).toContain(50);
    const combined = object(observed.combined);
    expect(combined.shards).toHaveLength(4);
    expect(object(object(combined.summary).statements).pct).toBe(100);
    expect(object(object(combined.summary).branches).pct).toBe(100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
