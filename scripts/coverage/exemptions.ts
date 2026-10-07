import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCoverageMap } from "istanbul-lib-coverage";
import type { CoverageMap, FileCoverageData } from "istanbul-lib-coverage";
import { createInstrumenter } from "istanbul-lib-instrument";
import { readCompilerManifest, sourceDigest } from "./compiler-manifest";
import type { Manifest, ManifestFile } from "./compiler-manifest";
import { deriveCompilerExemptions, exemptionKey } from "./compiler-exemptions";
import type { CompilerExemption } from "./compiler-exemptions";

export const readExemptions = readCompilerManifest;

function verifiedFile(
  map: CoverageMap,
  sourceRoot: string,
  entry: ManifestFile,
) {
  const path = join(sourceRoot, entry.file),
    text = readFileSync(path, "utf8");
  if (sourceDigest(text) !== entry.sha256)
    throw new Error(`Stale coverage exemption proof: ${entry.file}`);
  const file = map.fileCoverageFor(path).data;
  const derived = deriveCompilerExemptions(text, file);
  if (
    JSON.stringify(entry.proofs) !== JSON.stringify(derived.proofs) ||
    JSON.stringify(entry.exemptions) !== JSON.stringify(derived.exemptions)
  )
    throw new Error(`Missing or stale derived compiler proof: ${entry.file}`);
  return { file, derived };
}

function requireZero(file: FileCoverageData, entry: CompilerExemption): void {
  const count = exemptionCounter(file, entry);
  if (count !== 0)
    throw new Error(
      `Excluded compiler ${entry.metric === "statements" ? "statement" : "outcome"} was observed: ${file.path}:${entry.id}`,
    );
}

function exemptionCounter(
  file: FileCoverageData,
  entry: CompilerExemption,
): number | undefined {
  if (entry.metric === "statements") return file.s[entry.id];
  if (entry.outcome === undefined)
    throw new Error("Missing compiler outcome index");
  return file.b[entry.id]?.[entry.outcome];
}

export function exemptionCounts(
  map: CoverageMap,
  sourceRoot: string,
  manifest: Manifest,
) {
  const raw = map.getCoverageSummary().toJSON();
  const exempted = { statements: 0, branches: 0, guards: 0 };
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    const { file, derived } = verifiedFile(map, sourceRoot, entry);
    exempted.guards += derived.proofs.length;
    for (const item of derived.exemptions) {
      const key = `${entry.file}:${exemptionKey(item)}`;
      if (seen.has(key))
        throw new Error("Duplicate coverage exemption outcome");
      seen.add(key);
      requireZero(file, item);
      exempted[item.metric]++;
    }
  }
  return {
    raw,
    adjusted: {
      statements: adjustedMetric(raw.statements, exempted.statements),
      branches: adjustedMetric(raw.branches, exempted.branches),
    },
    exemptedBranchOutcomes: exempted.branches,
    exemptedStatements: exempted.statements,
    provenGuards: exempted.guards,
    policyStatus: manifest.status,
    reasonId: manifest.reasonId,
  };
}

function adjustedMetric(
  metric: {
    covered: number;
    total: number;
    skipped: number;
    pct: number | "Unknown";
  },
  exclusions: number,
) {
  const total = metric.total - exclusions;
  if (total < metric.covered)
    throw new Error("Invalid compiler exemption denominator");
  return {
    ...metric,
    total,
    pct: total ? (metric.covered * 100) / total : 100,
  };
}

export function enforceAdjusted(
  summary: ReturnType<typeof exemptionCounts>["adjusted"],
): void {
  const failed = (["statements", "branches"] as const).filter(
    (metric) => summary[metric].covered * 100 < summary[metric].total * 95,
  );
  if (failed.length)
    throw new Error(
      `Below 95%: ${failed.join(", ")} (review-contingent compiler-local exemptions)`,
    );
}

function refused(action: () => unknown, expected: string, label: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expected)) {
      console.log(`${label}: refused`);
      return;
    }
    throw new Error(`Incorrect ${label} diagnostic`, { cause: error });
  }
  throw new Error(`${label} was accepted`);
}

function baselineMap(sourceRoot: string, manifest: Manifest): CoverageMap {
  const baseline: Record<string, FileCoverageData> = {};
  for (const entry of manifest.files) {
    const path = join(sourceRoot, entry.file),
      instrumenter = createInstrumenter({
        esModules: false,
        parserPlugins: ["typescript"],
        compact: false,
      });
    instrumenter.instrumentSync(readFileSync(path, "utf8"), path);
    baseline[path] = instrumenter.lastFileCoverage();
  }
  return createCoverageMap(baseline);
}

export function exemptionProbe(repo: string): void {
  const manifest = readExemptions(repo),
    sourceRoot = process.env.SEVRO_COVERAGE_SOURCE_ROOT ?? repo;
  const map = baselineMap(sourceRoot, manifest),
    counts = exemptionCounts(map, sourceRoot, manifest);
  console.log(`compiler-guard-proof:${counts.provenGuards}`);
  console.log(`compiler-outcome-proof:${counts.exemptedBranchOutcomes}`);
  console.log(`compiler-statement-proof:${counts.exemptedStatements}`);
  const stale = {
    ...manifest,
    files: manifest.files.map((entry) => ({
      ...entry,
      sha256: "0".repeat(64),
    })),
  };
  refused(
    () => exemptionCounts(map, sourceRoot, stale),
    "Stale coverage exemption proof",
    "stale-proof",
  );
  const missing = {
    ...manifest,
    files: manifest.files.map((entry) => ({ ...entry, proofs: [] })),
  };
  refused(
    () => exemptionCounts(map, sourceRoot, missing),
    "Missing or stale derived compiler proof",
    "missing-derived-proof",
  );
  observedProbe(map, sourceRoot, manifest, "branches", "outcome");
  observedProbe(
    baselineMap(sourceRoot, manifest),
    sourceRoot,
    manifest,
    "statements",
    "statement",
  );
}

function observedProbe(
  map: CoverageMap,
  sourceRoot: string,
  manifest: Manifest,
  metric: "branches" | "statements",
  label: string,
): void {
  const entry = manifest.files[0];
  if (!entry) throw new Error("Missing compiler fixture");
  const { file, derived } = verifiedFile(map, sourceRoot, entry);
  const item = derived.exemptions.find(
    (candidate) => candidate.metric === metric,
  );
  if (!item) throw new Error("Missing compiler counter fixture");
  setObserved(file, item);
  refused(
    () => exemptionCounts(map, sourceRoot, manifest),
    `Excluded compiler ${label} was observed`,
    `observed-exempt-${label}`,
  );
}

function setObserved(file: FileCoverageData, item: CompilerExemption): void {
  if (item.metric === "statements") {
    file.s[item.id] = 1;
    return;
  }
  const branch = file.b[item.id];
  if (!branch || item.outcome === undefined)
    throw new Error("Missing compiler fixture branch");
  branch[item.outcome] = 1;
}
