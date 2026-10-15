import type { CoverageMapData } from "istanbul-lib-coverage";
import { join, relative, isAbsolute } from "node:path";
import { writeFileSync } from "node:fs";
import type { CoverageIdentity } from "./types";
import { coverageBatch, coverageDigest, type TestShard } from "./shard-plan";
import type { prepare } from "./prepare";

export function relocateCoverage(
  data: CoverageMapData,
  from: string,
  to: string,
) {
  const relocated: CoverageMapData = {};
  for (const [path, file] of Object.entries(data)) {
    const name = relative(from, path);
    if (isAbsolute(name) || name.startsWith(".."))
      throw new Error(`Coverage path escapes source snapshot: ${path}`);
    const target = join(to, name);
    relocated[target] = {
      path: target,
      statementMap: file.statementMap,
      fnMap: file.fnMap,
      branchMap: file.branchMap,
      s: file.s,
      f: file.f,
      b: file.b,
    };
  }
  return relocated;
}

export function writeShard(
  output: string,
  prepared: ReturnType<typeof prepare>,
  identity: CoverageIdentity,
  shard: TestShard,
  raw: CoverageMapData,
) {
  const baseline = relocateCoverage(prepared.baseline, prepared.source, ".");
  const manifest = {
    format: "sevro.coverage-shard.v1",
    candidate: prepared.content,
    batch: coverageBatch(),
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    layout: coverageLayout(baseline),
    runId: identity.runId,
    shard,
  };
  writeFileSync(join(output, "shard.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(output, "coverage-portable.json"),
    JSON.stringify(relocateCoverage(raw, prepared.source, ".")),
  );
}

export function coverageLayout(baseline: CoverageMapData) {
  return coverageDigest(
    Object.entries(baseline).map(([path, file]) => ({
      path,
      statementMap: file.statementMap,
      fnMap: file.fnMap,
      branchMap: file.branchMap,
    })),
  );
}
