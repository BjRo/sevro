#!/usr/bin/env bun
import { resolvedFixture } from "./resolved-case";
import { isStringArray } from "./value-guards";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EvaluationConfigurationError,
  runEvaluation,
  type HostAdapter,
  type ResolvedCase,
} from "./engine";
import { createCodexHost } from "./hosts/codex";
import {
  codexAgentConcurrency,
  configurationRoot,
} from "./hosts/codex-configuration";
import { createClaudeHost } from "./hosts/claude";
import { prepareGeneratedFixture } from "./generated-fixture";
import { prepareRepositoryFixture } from "./repository-fixture";
import { prepareInstrumentation } from "./instrumentation";
import { openExtensionSession, type ExtensionCase } from "./extension-session";
import { assertCliResult } from "./schema";
import { reportCommand } from "./report";
import {
  packageBuildDigest,
  projectIdentityDigest,
  projectProvenance,
} from "./provenance";

import { InvocationError, parseInvocation } from "./cli-invocation";
import {
  loadRuntimeConfiguration,
  runtimeNativeGoalEnabled,
} from "./runtime-config";
import { canonicalRuntimeRoot, requireRuntimeReadRoots } from "./runtime-paths";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validGeneratedFixture(value: Record<string, unknown>): boolean {
  try {
    prepareGeneratedFixture(value);
    return true;
  } catch {
    return false;
  }
}

function validRepositoryFixture(value: Record<string, unknown>): boolean {
  try {
    prepareRepositoryFixture({ kind: "repository", ...value });
    return true;
  } catch {
    return false;
  }
}

function validInlineFixture(value: Record<string, unknown>): boolean {
  return (
    !Object.hasOwn(value, "sourceRef") &&
    record(value.files) &&
    Object.values(value.files).every((content) => typeof content === "string")
  );
}

function fixtureFields(value: Record<string, unknown>): boolean {
  if (Object.hasOwn(value, "sourceRef")) return validRepositoryFixture(value);
  return Object.hasOwn(value, "files") && validInlineFixture(value);
}

function validFixture(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.kind === "generated") return validGeneratedFixture(value);
  if (value.kind !== undefined) return false;
  return fixtureFields(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function followUpPrompt(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "string" && Boolean(value.trim()))
  );
}

function validCaseDetails(value: Record<string, unknown>): boolean {
  return (
    nonemptyString(value.id) &&
    nonemptyString(value.prompt) &&
    followUpPrompt(value.followUpPrompt) &&
    validFixture(value.fixture)
  );
}

function validCheck(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.grader === "string" &&
    record(value.configuration)
  );
}

function validChecks(value: unknown): boolean {
  return Array.isArray(value) && value.every(validCheck);
}

function parseCase(value: unknown): ResolvedCase {
  if (
    !record(value) ||
    !validCaseDetails(value) ||
    !validChecks(value.checks) ||
    !isStringArray(value.requiredEvidence)
  )
    throw new InvocationError("invalid resolved case file");
  return value as unknown as ResolvedCase;
}

async function loadCase(path: string): Promise<ResolvedCase> {
  try {
    return parseCase(JSON.parse(await readFile(path, "utf8")));
  } catch (cause) {
    throw new InvocationError("resolved case file is unreadable or invalid", {
      cause,
    });
  }
}

async function loadJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new InvocationError(`${label} is unreadable or invalid`, { cause });
  }
}

function validExtensionCommand(value: unknown): value is string[] {
  return (
    isStringArray(value) &&
    value.length > 0 &&
    value.every((part) => part.length > 0) &&
    isAbsolute(value[0] ?? "")
  );
}

async function loadExtensionCommand(path: string): Promise<string[]> {
  const command = await loadJson(path, "extension command file");
  if (!validExtensionCommand(command))
    throw new InvocationError(
      "extension command must be an absolute argv array",
    );
  return command;
}

async function loadExtensionOptions(
  selected: NonNullable<ReturnType<typeof parseInvocation>["extension"]>,
) {
  const command = await loadExtensionCommand(selected.commandFile);
  const configuration = selected.configurationFile
    ? await loadJson(selected.configurationFile, "extension configuration file")
    : {};
  const redactedConfiguration = selected.redactedConfigurationFile
    ? await loadJson(
        selected.redactedConfigurationFile,
        "redacted extension configuration file",
      )
    : {};
  if (!record(configuration) || !record(redactedConfiguration))
    throw new InvocationError("extension configuration must be JSON objects");
  return { command, configuration, redactedConfiguration };
}

async function loadPreparationSources(
  selected: ReturnType<typeof parseInvocation>,
) {
  if (!selected.caseSourceRoot || !selected.caseSourceMapFile) return undefined;
  const refs = await loadJson(
    selected.caseSourceMapFile,
    "case source map file",
  );
  if (
    !record(refs) ||
    !Object.values(refs).every(
      (value) => typeof value === "string" && value.startsWith("file:///"),
    )
  )
    throw new InvocationError("case source map must contain file URLs");
  return {
    root: selected.caseSourceRoot,
    refs: refs as Record<string, string>,
  };
}

function selectExtensionCase(
  cases: ExtensionCase[],
  caseId: string,
): { caseData: ResolvedCase; resolvedCase: ExtensionCase } {
  const resolvedCase = cases.find((item) => item.id === caseId);
  if (!resolvedCase)
    throw new InvocationError("extension did not resolve the selected case");
  const caseData = parseCase({
    ...resolvedCase,
    fixture: resolvedFixture(resolvedCase.fixture),
  });
  return { caseData, resolvedCase };
}

async function adapterModule(path: string): Promise<unknown> {
  try {
    return await import(pathToFileURL(path).href);
  } catch (cause) {
    throw new InvocationError("host adapter module could not be loaded", {
      cause,
    });
  }
}

async function loadHost(path: string): Promise<HostAdapter> {
  const module = await adapterModule(path);
  const host = record(module) ? module.default : null;
  if (!validHostAdapter(host))
    throw new InvocationError(
      "host adapter module has no valid default adapter",
    );
  validateHostInstrumentation(host);
  validateHostCapabilities(host.hostCapabilities);
  return host as unknown as HostAdapter;
}

function validateHostInstrumentation(host: Record<string, unknown>): void {
  try {
    prepareInstrumentation(
      [],
      (host.instrumentation as HostAdapter["instrumentation"]) ?? [],
      [],
      "passive",
    );
  } catch (cause) {
    throw new InvocationError("host adapter instrumentation is invalid", {
      cause,
    });
  }
}

function validHostAdapter(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.model === "string" &&
    typeof value.effort === "string" &&
    typeof value.run === "function"
  );
}

function validateHostCapabilities(value: unknown): void {
  if (value === undefined) return;
  if (
    !isStringArray(value) ||
    value.some((id) => !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(id)) ||
    new Set(value).size !== value.length
  )
    throw new InvocationError("host adapter capabilities are invalid");
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
    cases: Array<{
      caseId: string;
      trials: Array<{
        trial: number;
        domainOutcomes: Array<{ id: string; status: string }>;
      }>;
    }>;
  };
  process.stdout.write(
    `execution=${result.execution.status} grading=${result.grading.status} task=${result.task.verdict}\n`,
  );
  displayDomainOutcomes(result.cases);
  if (result.evidencePath)
    process.stdout.write(`evidence=${result.evidencePath}\n`);
}

function displayDomainOutcomes(
  cases: Array<{
    caseId: string;
    trials: Array<{
      trial: number;
      domainOutcomes: Array<{ id: string; status: string }>;
    }>;
  }>,
): void {
  for (const selected of cases)
    for (const trial of selected.trials)
      for (const outcome of trial.domainOutcomes)
        process.stdout.write(
          `domain case=${selected.caseId} trial=${trial.trial} outcome=${outcome.id} status=${outcome.status}\n`,
        );
}

type Invocation = ReturnType<typeof parseInvocation>;
type PreparationSources = Awaited<ReturnType<typeof loadPreparationSources>>;

function protectMappedSources(
  invocation: Invocation,
  preparationSources: PreparationSources,
): void {
  const sourceRoots = mappedSourceRoots(preparationSources);
  for (const native of [
    invocation.codex,
    invocation.claude,
    invocation.semanticCodex,
    invocation.advisoryCodex,
  ]) {
    if (native)
      native.additionalProtectedRoots = [
        ...native.additionalProtectedRoots,
        ...sourceRoots,
      ];
  }
  invocation.shellIsolation?.protectedRoots.push(...sourceRoots);
}

async function selectedConcurrency(
  invocation: Invocation,
  configRoot: string,
): Promise<number | null> {
  return [
    invocation.codex,
    invocation.semanticCodex,
    invocation.advisoryCodex,
  ].some(Boolean)
    ? codexAgentConcurrency(configRoot)
    : null;
}

async function candidateHost(
  invocation: Invocation,
  agentConcurrencyLimit: number | null,
): Promise<HostAdapter> {
  if (invocation.codex)
    return createCodexHost({ ...invocation.codex, agentConcurrencyLimit });
  if (invocation.claude) return createClaudeHost(invocation.claude);
  if (!invocation.adapterModule)
    throw new InvocationError("missing --adapter-module or --host");
  return loadHost(invocation.adapterModule);
}

async function secondaryHost(
  module: string | undefined,
  codex: Invocation["semanticCodex"],
  agentConcurrencyLimit: number | null,
): Promise<HostAdapter | undefined> {
  if (module) return loadHost(module);
  if (codex) return createCodexHost({ ...codex, agentConcurrencyLimit });
  return undefined;
}

async function prepareRunInvocation(argv: string[]) {
  const invocation = parseInvocation(argv);
  warnDeprecatedRuntimeOptions(invocation);
  const preparationSources = await loadPreparationSources(invocation);
  protectMappedSources(invocation, preparationSources);
  const runtimePolicy = await loadRuntimeConfiguration(
    invocation.projectRoot,
    invocation.runtimeConfigFile,
    await invocationProtectedRuntimeRoots(invocation),
  );
  requireRuntimeOptionCompatibility(invocation, runtimePolicy);
  selectRuntimeTransport(invocation, runtimePolicy);
  const configRoot = await configurationRoot(invocation.configRoot);
  await validateInvocationRuntime(invocation, runtimePolicy);
  const agentConcurrencyLimit = await selectedConcurrency(
    invocation,
    configRoot,
  );
  const caseData = invocation.caseFile
    ? await loadCase(invocation.caseFile)
    : undefined;
  const host = await candidateHost(invocation, agentConcurrencyLimit);
  const semanticHost = await secondaryHost(
    invocation.semanticAdapterModule,
    invocation.semanticCodex,
    agentConcurrencyLimit,
  );
  const advisoryHost = await secondaryHost(
    invocation.advisoryAdapterModule,
    invocation.advisoryCodex,
    agentConcurrencyLimit,
  );
  return {
    invocation,
    runtimePolicy,
    preparationSources,
    caseData,
    host,
    semanticHost,
    advisoryHost,
  };
}

function selectRuntimeTransport(
  invocation: Invocation,
  policy: Awaited<ReturnType<typeof loadRuntimeConfiguration>>,
): void {
  if (!runtimeNativeGoalEnabled(policy)) return;
  if (invocation.codex) selectCodexGoalTransport(invocation.codex);
}

function selectCodexGoalTransport(
  codex: NonNullable<Invocation["codex"]>,
): void {
  if (codex.entrypoint === "exec")
    throw new InvocationError(
      "native-goal runtime policy requires Codex app-server",
    );
  codex.entrypoint = "app-server";
}

function warnDeprecatedRuntimeOptions(invocation: Invocation): void {
  for (const option of invocation.deprecatedRuntimeOptions)
    console.warn(
      `--${option} is deprecated; declare the runtime in sevro.json or --runtime-config-file instead`,
    );
}

function requireRuntimeOptionCompatibility(
  invocation: Invocation,
  policy: Awaited<ReturnType<typeof loadRuntimeConfiguration>>,
): void {
  if (policy && invocation.deprecatedRuntimeOptions.length)
    throw new InvocationError(
      "runtime configuration cannot be combined with deprecated runtime options",
    );
}

type PreparedInvocation = Awaited<ReturnType<typeof prepareRunInvocation>>;

async function validateInvocationRuntime(
  invocation: Invocation,
  policy: Awaited<ReturnType<typeof loadRuntimeConfiguration>>,
): Promise<void> {
  if (!policy) return;
  const protectedRoots = await invocationProtectedRuntimeRoots(invocation);
  requireRuntimeReadRoots(policy.readOnlyRoots, protectedRoots);
  requireRuntimeReadRoots(
    (policy.seeds ?? []).map((seed) => seed.source),
    protectedRoots,
  );
}

async function invocationProtectedRuntimeRoots(
  invocation: Invocation,
): Promise<string[]> {
  const native = [
    invocation.codex,
    invocation.claude,
    invocation.semanticCodex,
    invocation.advisoryCodex,
  ];
  const protectedRoots = [
    join(import.meta.dir, ".."),
    invocation.projectRoot,
    invocation.configRoot,
    invocation.resultsRoot,
    invocation.runStateRoot,
    ...native.flatMap((host) => host?.additionalProtectedRoots ?? []),
    ...(invocation.shellIsolation?.protectedRoots ?? []),
  ];
  return Promise.all(protectedRoots.map(canonicalRuntimeRoot));
}

async function resolveSelectedExtension(
  prepared: PreparedInvocation,
  selected: NonNullable<Invocation["extension"]>,
  signal: AbortSignal,
) {
  const { invocation, host } = prepared;
  const options = await loadExtensionOptions(selected);
  const hostCapabilities = [
    ...(host.instrumentation ?? []).map((item) => item.id),
    ...(host.hostCapabilities ?? []),
  ];
  const session = await openExtensionSession({
    ...options,
    sourceFiles: selected.sourceFiles,
    engineCapabilities: [
      "sevro.host.exec",
      "sevro.fixture.setup",
      "sevro.case.host-route",
    ],
    hostCapabilities,
    taskVerdictPolicy: selected.taskVerdictPolicy,
    replaceBuiltinGraders: selected.replaceBuiltinGraders,
    signal,
  });
  const chosen = selectExtensionCase(
    await session.resolve(
      pathToFileURL(invocation.projectRoot).href,
      { caseIds: [selected.caseId] },
      {
        id: host.id,
        model: host.model,
        effort: host.effort,
        capabilities: hostCapabilities,
      },
    ),
    selected.caseId,
  );
  return {
    caseData: chosen.caseData,
    extension: { session, resolvedCase: chosen.resolvedCase },
  };
}

async function selectedCase(prepared: PreparedInvocation, signal: AbortSignal) {
  if (prepared.invocation.extension)
    return resolveSelectedExtension(
      prepared,
      prepared.invocation.extension,
      signal,
    );
  if (!prepared.caseData)
    throw new InvocationError("invalid resolved case file");
  return { caseData: prepared.caseData, extension: undefined };
}

async function evaluateInvocation(
  prepared: PreparedInvocation,
  signal: AbortSignal,
) {
  const { invocation, preparationSources, host, semanticHost, advisoryHost } =
    prepared;
  const { caseData, extension } = await selectedCase(prepared, signal);
  return runEvaluation({
    runtimePolicy: prepared.runtimePolicy,
    projectRoot: invocation.projectRoot,
    resultsRoot: invocation.resultsRoot,
    runStateRoot: invocation.runStateRoot,
    case: caseData,
    extension,
    preparationSources,
    host,
    semanticHost,
    advisoryHost,
    advisoryExcludedPaths: invocation.advisoryExcludedPaths,
    shellIsolation: invocation.shellIsolation,
    runnerBuildDigest:
      invocation.runnerBuildDigest ?? (await packageBuildDigest()),
    runnerCheckoutRoot: invocation.runnerCheckoutRoot,
    projectDigest:
      invocation.projectDigest ??
      (await projectIdentityDigest(
        invocation.projectRoot,
        await projectProvenance(invocation.projectRoot),
        [invocation.resultsRoot, invocation.runStateRoot],
      )),
    condition: invocation.condition,
    trialCount: invocation.trialCount,
    jobs: invocation.jobs,
    passThreshold: invocation.passThreshold,
    dry: invocation.dry,
    signal,
  });
}

class CommandCancellation {
  private readonly controller = new AbortController();
  private readonly interrupt = () => {
    this.controller.abort("SIGINT");
  };
  private readonly terminate = () => {
    this.controller.abort("SIGTERM");
  };
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  constructor() {
    process.on("SIGINT", this.interrupt);
    process.on("SIGTERM", this.terminate);
  }
  dispose(): void {
    process.off("SIGINT", this.interrupt);
    process.off("SIGTERM", this.terminate);
  }
}

function runnerFailureCategory(error: unknown): 64 | 70 {
  return error instanceof EvaluationConfigurationError ||
    error instanceof InvocationError
    ? 64
    : 70;
}

function displayFailure(
  error: unknown,
  json: boolean,
  code: 64 | 70,
  fallback: string,
): void {
  display(
    failure(code, error instanceof Error ? error.message : fallback),
    json,
  );
  process.exitCode = code;
}

async function main(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  let prepared: PreparedInvocation;
  try {
    prepared = await prepareRunInvocation(argv);
  } catch (error) {
    displayFailure(error, json, 64, "invalid invocation");
    return;
  }
  const cancellation = new CommandCancellation();
  try {
    const { result } = await evaluateInvocation(prepared, cancellation.signal);
    display(result, prepared.invocation.json);
    process.exitCode = result.exitCode;
  } catch (error) {
    displayFailure(
      error,
      prepared.invocation.json,
      runnerFailureCategory(error),
      "runner failure",
    );
  } finally {
    cancellation.dispose();
  }
}

if (process.argv[2] === "report")
  process.exitCode = await reportCommand(process.argv.slice(2));
else await main(process.argv.slice(2));

function mappedSourceRoots(preparationSources: PreparationSources): string[] {
  return Object.values(preparationSources?.refs ?? {}).map((url) =>
    fileURLToPath(url),
  );
}
