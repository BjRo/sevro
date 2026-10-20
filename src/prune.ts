import { readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { assertCliResult, assertRunEvidence } from "./schema";
import type { CliResultData, RunEvidenceData } from "./schema-types";
import { createReport } from "./report";
import { atomicWriteJson } from "./storage";
import { isRecord } from "./value-guards";
import { retainedFile, withResultsLock } from "./results-lock";
import { pruneNativeTranscripts } from "./transcript-retention";

interface RetainedResult {
  directory: string;
  result: CliResultData;
  evidence: RunEvidenceData;
  time: number;
}

type RetentionPolicy =
  { keep: number; cutoff: null } | { keep: null; cutoff: number };

const durationUnits: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

function duration(value: string): number {
  const match = /^([1-9]\d*)(ms|s|m|h|d|w)$/.exec(value);
  if (!match)
    throw new Error(
      "--older-than requires a positive integer and ms, s, m, h, d or w",
    );
  const amount =
    Number.parseInt(value, 10) *
    Number(durationUnits[value.replace(/^\d+/, "")]);
  if (!Number.isSafeInteger(amount))
    throw new Error("--older-than exceeds the safe duration range");
  return amount;
}

function count(value: string): number {
  const amount = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(amount))
    throw new Error("--keep must be a positive safe integer");
  return amount;
}

function parseInvocation(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      "results-root": { type: "string" },
      keep: { type: "string" },
      latest: { type: "boolean" },
      "older-than": { type: "string" },
      "native-transcripts": { type: "boolean" },
    },
  });
  return values;
}

function policy(values: ReturnType<typeof parseInvocation>): RetentionPolicy {
  if (values.latest) return { keep: 1, cutoff: null };
  if (values["older-than"] !== undefined)
    return { keep: null, cutoff: Date.now() - duration(values["older-than"]) };
  if (values.keep !== undefined)
    return { keep: count(values.keep), cutoff: null };
  return { keep: values["native-transcripts"] ? 0 : 10, cutoff: null };
}

function invocation(args: string[]) {
  const values = parseInvocation(args);
  const policies = [values.latest, values.keep, values["older-than"]].filter(
    (value) => value !== undefined,
  );
  if (policies.length > 1) throw new Error("retention policies are exclusive");
  if (values["results-root"] === "")
    throw new Error("--results-root must not be empty");
  return {
    root: resolve(values["results-root"] ?? ".sevro/results"),
    policy: policy(values),
    nativeTranscripts: values["native-transcripts"] === true,
  };
}

async function retainedResults(root: string): Promise<RetainedResult[]> {
  const results: RetainedResult[] = [];
  for (const directory of await resultDirectories(root)) {
    const path = join(directory, "result.json");
    await retainedFile(path);
    const result: unknown = JSON.parse(await readFile(path, "utf8"));
    assertCliResult(result);
    if (!(await finalized(root, result.runId))) continue;
    if (result.evidencePath !== join(directory, "run.json"))
      throw new Error(
        `retained result references evidence outside its directory: ${path}`,
      );
    await retainedFile(result.evidencePath);
    const evidence: unknown = JSON.parse(
      await readFile(result.evidencePath, "utf8"),
    );
    assertRunEvidence(evidence);
    await createReport([path]);
    results.push({
      directory,
      result,
      evidence,
      time: (await stat(path)).mtimeMs,
    });
  }
  return results.sort(
    (left, right) =>
      right.time - left.time || left.directory.localeCompare(right.directory),
  );
}

async function resultDirectories(parent: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(parent, entry.name);
    if (await retainedFile(join(directory, "result.json")))
      paths.push(directory);
    else paths.push(...(await resultDirectories(directory)));
  }
  return paths;
}

async function finalized(root: string, runId: string | null): Promise<boolean> {
  if (!runId || basename(runId) !== runId) return false;
  const path = join(root, "active", `${runId}.json`);
  if (!(await retainedFile(path))) return true;
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) return false;
  return finalizedRecord(value, runId);
}

function finalizedRecord(
  value: Record<string, unknown>,
  runId: string,
): boolean {
  return (
    value.format === "sevro.active-run.v1" &&
    value.runId === runId &&
    ["complete", "interrupted", "diagnostic"].includes(String(value.status))
  );
}

function retainedByPolicy(results: RetainedResult[], policy: RetentionPolicy) {
  const cutoff = policy.cutoff;
  return cutoff === null
    ? results.slice(0, policy.keep)
    : results.filter((result) => result.time >= cutoff);
}

async function pruneResults(root: string, policy: RetentionPolicy) {
  const results = await retainedResults(root);
  const remaining = retainedByPolicy(results, policy);
  const latest = remaining[0];
  if (latest) await atomicWriteJson(join(root, "latest.json"), latest.result);
  else await rm(join(root, "latest.json"), { force: true });
  const removed = results.filter((result) => !remaining.includes(result));
  for (const result of removed) await rm(result.directory, { recursive: true });
  return { removed: removed.length, kept: remaining.length };
}

async function pruneTranscripts(root: string, policy: RetentionPolicy) {
  const results = await retainedResults(root);
  const preserved = retainedByPolicy(results, policy);
  let removed = 0;
  for (const { evidence } of results.filter(
    (item) => !preserved.includes(item),
  )) {
    removed += await pruneNativeTranscripts(evidence);
  }
  return { removed, kept: results.length };
}

async function prune(options: ReturnType<typeof invocation>) {
  const root = await realpath(options.root).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  });
  if (root === null) return { removed: 0, kept: 0 };
  return withResultsLock(root, () =>
    options.nativeTranscripts
      ? pruneTranscripts(root, options.policy)
      : pruneResults(root, options.policy),
  );
}

/** Explicitly remove old retained runs while keeping report's latest index usable. */
export async function pruneCommand(args: string[]): Promise<number> {
  try {
    const options = invocation(args);
    const result = await prune(options);
    const unit = options.nativeTranscripts
      ? "native transcript bundle(s)"
      : "result(s)";
    process.stdout.write(
      `Removed ${result.removed} ${unit}; kept ${result.kept}${options.nativeTranscripts ? " result(s)" : ""}.\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `sevro prune: ${error instanceof Error ? error.message : "pruning failed"}\n`,
    );
    return 64;
  }
}
