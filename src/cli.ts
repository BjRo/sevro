#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  EvaluationConfigurationError,
  runEvaluation,
  type HostAdapter,
  type ResolvedCase,
} from "./engine";
import { assertCliResult } from "./schema";

class InvocationError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredOption(value: string | undefined, name: string): string {
  if (!value) throw new InvocationError(`missing ${name}`);
  return value;
}

function absoluteOption(value: string | undefined, name: string): string {
  const path = requiredOption(value, name);
  if (!isAbsolute(path)) throw new InvocationError(`${name} must be absolute`);
  return path;
}

function parseCase(value: unknown): ResolvedCase {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.prompt !== "string" ||
    !value.prompt ||
    !record(value.fixture) ||
    !record(value.fixture.files) ||
    !Object.values(value.fixture.files).every(
      (content) => typeof content === "string",
    ) ||
    !Array.isArray(value.checks) ||
    !value.checks.every(
      (check) =>
        record(check) &&
        typeof check.id === "string" &&
        typeof check.grader === "string" &&
        record(check.configuration),
    ) ||
    !Array.isArray(value.requiredEvidence) ||
    !value.requiredEvidence.every((item) => typeof item === "string")
  )
    throw new InvocationError("invalid resolved case file");
  return value as unknown as ResolvedCase;
}

function parseInvocation(argv: string[]) {
  const parsed = (() => {
    try {
      return parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          json: { type: "boolean" },
          "case-file": { type: "string" },
          "adapter-module": { type: "string" },
          "project-root": { type: "string" },
          "results-root": { type: "string" },
          "runner-build-digest": { type: "string" },
          "project-digest": { type: "string" },
          condition: { type: "string" },
          trials: { type: "string" },
          threshold: { type: "string" },
        },
      } as const);
    } catch {
      throw new InvocationError("invalid CLI arguments");
    }
  })();
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "run")
    throw new InvocationError("expected the run command");
  const values = parsed.values;
  const condition = requiredOption(values.condition, "--condition");
  if (condition !== "passive" && condition !== "enforced")
    throw new InvocationError("invalid --condition");
  const trialCount = Number(requiredOption(values.trials, "--trials"));
  const passThreshold = Number(requiredOption(values.threshold, "--threshold"));
  if (!Number.isSafeInteger(trialCount) || trialCount < 1)
    throw new InvocationError("invalid --trials");
  if (
    !Number.isFinite(passThreshold) ||
    passThreshold <= 0 ||
    passThreshold > 1
  )
    throw new InvocationError("invalid --threshold");
  return {
    json: values.json ?? false,
    caseFile: absoluteOption(values["case-file"], "--case-file"),
    adapterModule: absoluteOption(values["adapter-module"], "--adapter-module"),
    projectRoot: absoluteOption(values["project-root"], "--project-root"),
    resultsRoot: absoluteOption(values["results-root"], "--results-root"),
    runnerBuildDigest: requiredOption(
      values["runner-build-digest"],
      "--runner-build-digest",
    ),
    projectDigest: requiredOption(values["project-digest"], "--project-digest"),
    condition: condition as "passive" | "enforced",
    trialCount,
    passThreshold,
  };
}

async function loadCase(path: string): Promise<ResolvedCase> {
  try {
    return parseCase(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new InvocationError("resolved case file is unreadable or invalid");
  }
}

async function loadHost(path: string): Promise<HostAdapter> {
  let module: unknown;
  try {
    module = await import(pathToFileURL(path).href);
  } catch {
    throw new InvocationError("host adapter module could not be loaded");
  }
  const host = record(module) ? module.default : null;
  if (
    !record(host) ||
    typeof host.id !== "string" ||
    typeof host.model !== "string" ||
    typeof host.effort !== "string" ||
    typeof host.run !== "function"
  )
    throw new InvocationError(
      "host adapter module has no valid default adapter",
    );
  return host as unknown as HostAdapter;
}

function failure(code: 64 | 70, message: string) {
  const result = {
    format: "sevro.cli-result.v1",
    runId: null,
    execution: { status: "not_run" },
    grading: { status: "not_requested" },
    task: { verdict: "not_assessed" },
    exitCode: code,
    evidencePath: null,
    cases: [],
    diagnostic: {
      code: code === 64 ? "sevro.invocation.invalid" : "sevro.runner.error",
      message: message.slice(0, 4096),
    },
  };
  assertCliResult(result);
  return result;
}

function display(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  const result = value as {
    execution: { status: string };
    grading: { status: string };
    task: { verdict: string };
    evidencePath: string | null;
  };
  process.stdout.write(
    `execution=${result.execution.status} grading=${result.grading.status} task=${result.task.verdict}\n`,
  );
  if (result.evidencePath)
    process.stdout.write(`evidence=${result.evidencePath}\n`);
}

async function main(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  let invocation: ReturnType<typeof parseInvocation>;
  let caseData: ResolvedCase;
  let host: HostAdapter;
  try {
    invocation = parseInvocation(argv);
    caseData = await loadCase(invocation.caseFile);
    host = await loadHost(invocation.adapterModule);
  } catch (error) {
    const result = failure(
      64,
      error instanceof Error ? error.message : "invalid invocation",
    );
    display(result, json);
    process.exitCode = 64;
    return;
  }
  try {
    const { result } = await runEvaluation({
      projectRoot: invocation.projectRoot,
      resultsRoot: invocation.resultsRoot,
      case: caseData,
      host,
      runnerBuildDigest: invocation.runnerBuildDigest,
      projectDigest: invocation.projectDigest,
      condition: invocation.condition,
      trialCount: invocation.trialCount,
      passThreshold: invocation.passThreshold,
    });
    display(result, invocation.json);
    process.exitCode = result.exitCode;
  } catch (error) {
    const code = error instanceof EvaluationConfigurationError ? 64 : 70;
    const message = error instanceof Error ? error.message : "runner failure";
    const result = failure(code, message);
    display(result, invocation.json);
    process.exitCode = code;
  }
}

await main(process.argv.slice(2));
