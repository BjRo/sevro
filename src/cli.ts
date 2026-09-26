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
import { createCodexHost } from "./hosts/codex";
import { openExtensionSession, type ExtensionCase } from "./extension-session";
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

function validFixture(value: unknown): boolean {
  if (!record(value)) return false;
  if (Object.hasOwn(value, "files"))
    return (
      !Object.hasOwn(value, "sourceRef") &&
      record(value.files) &&
      Object.values(value.files).every((content) => typeof content === "string")
    );
  return typeof value.sourceRef === "string" && Boolean(value.sourceRef);
}

function parseCase(value: unknown): ResolvedCase {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.prompt !== "string" ||
    !value.prompt ||
    !validFixture(value.fixture) ||
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
          dry: { type: "boolean" },
          "case-file": { type: "string" },
          "case-id": { type: "string" },
          "extension-command-file": { type: "string" },
          "extension-source-file": { type: "string", multiple: true },
          "extension-configuration-file": { type: "string" },
          "extension-redacted-configuration-file": { type: "string" },
          "task-verdict-policy": { type: "string" },
          "case-source-root": { type: "string" },
          "case-source-map-file": { type: "string" },
          "adapter-module": { type: "string" },
          "semantic-adapter-module": { type: "string" },
          "semantic-host": { type: "string" },
          "semantic-model": { type: "string" },
          "semantic-effort": { type: "string" },
          host: { type: "string" },
          "codex-bin": { type: "string" },
          "codex-auth-file": { type: "string" },
          model: { type: "string" },
          effort: { type: "string" },
          "shell-isolation": { type: "boolean" },
          "protected-root": { type: "string", multiple: true },
          "project-root": { type: "string" },
          "results-root": { type: "string" },
          "run-state-root": { type: "string" },
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
  const protectedRoots = values["protected-root"] ?? [];
  if (protectedRoots.some((path) => !isAbsolute(path)))
    throw new InvocationError("--protected-root must be absolute");
  const codex = values.host === "codex";
  const semanticCodex = values["semantic-host"] === "codex";
  if (values.host && !codex) throw new InvocationError("unsupported --host");
  if (values["semantic-host"] && !semanticCodex)
    throw new InvocationError("unsupported --semantic-host");
  if (semanticCodex && values["semantic-adapter-module"])
    throw new InvocationError(
      "--semantic-host and --semantic-adapter-module are exclusive",
    );
  if (codex && values["adapter-module"])
    throw new InvocationError("--host and --adapter-module are exclusive");
  if (!codex && !values["adapter-module"])
    throw new InvocationError("missing --adapter-module or --host");
  if (!codex && (values.model || values.effort))
    throw new InvocationError("--model and --effort require --host codex");
  if (!semanticCodex && (values["semantic-model"] || values["semantic-effort"]))
    throw new InvocationError(
      "semantic model options require --semantic-host codex",
    );
  if (
    !codex &&
    !semanticCodex &&
    (values["codex-bin"] || values["codex-auth-file"])
  )
    throw new InvocationError("Codex options require a Codex host route");
  if (
    protectedRoots.length &&
    !values["shell-isolation"] &&
    !codex &&
    !semanticCodex
  )
    throw new InvocationError("--protected-root requires isolation");
  const projectRoot = absoluteOption(values["project-root"], "--project-root");
  const resultsRoot = absoluteOption(values["results-root"], "--results-root");
  const runStateRoot = values["run-state-root"]
    ? absoluteOption(values["run-state-root"], "--run-state-root")
    : resultsRoot;
  const extensionCommandFile = values["extension-command-file"];
  const taskVerdictPolicy = values["task-verdict-policy"];
  if (
    taskVerdictPolicy !== undefined &&
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(taskVerdictPolicy)
  )
    throw new InvocationError("invalid --task-verdict-policy");
  if (Boolean(values["case-file"]) === Boolean(extensionCommandFile))
    throw new InvocationError(
      "select exactly one of --case-file or --extension-command-file",
    );
  if (extensionCommandFile) {
    if (!values["case-id"]) throw new InvocationError("missing --case-id");
    if (!values["extension-source-file"]?.length)
      throw new InvocationError("missing --extension-source-file");
    if (values["extension-source-file"].some((path) => !isAbsolute(path)))
      throw new InvocationError("--extension-source-file must be absolute");
  } else if (
    values["case-id"] ||
    values["extension-source-file"] ||
    values["extension-configuration-file"] ||
    values["extension-redacted-configuration-file"] ||
    taskVerdictPolicy !== undefined
  )
    throw new InvocationError(
      "extension options require --extension-command-file",
    );
  if (
    Boolean(values["extension-configuration-file"]) !==
    Boolean(values["extension-redacted-configuration-file"])
  )
    throw new InvocationError(
      "extension configuration requires a redacted file",
    );
  if (
    Boolean(values["case-source-root"]) !==
    Boolean(values["case-source-map-file"])
  )
    throw new InvocationError("case sources require a root and map file");
  const privateRoots = [
    ...protectedRoots,
    ...(values["case-file"] ? [values["case-file"]] : []),
    ...(extensionCommandFile ? [extensionCommandFile] : []),
    ...(values["extension-source-file"] ?? []),
    ...(values["extension-configuration-file"]
      ? [values["extension-configuration-file"]]
      : []),
    ...(values["extension-redacted-configuration-file"]
      ? [values["extension-redacted-configuration-file"]]
      : []),
    ...(values["case-source-root"] ? [values["case-source-root"]] : []),
    ...(values["case-source-map-file"] ? [values["case-source-map-file"]] : []),
  ];
  const codexCommon =
    codex || semanticCodex
      ? {
          binary: absoluteOption(values["codex-bin"], "--codex-bin"),
          authFile: absoluteOption(
            values["codex-auth-file"],
            "--codex-auth-file",
          ),
          projectRoot,
          resultsRoot,
          additionalProtectedRoots: [...privateRoots, runStateRoot],
        }
      : undefined;
  return {
    json: values.json ?? false,
    dry: values.dry ?? false,
    caseFile: values["case-file"]
      ? absoluteOption(values["case-file"], "--case-file")
      : undefined,
    extension: extensionCommandFile
      ? {
          commandFile: absoluteOption(
            extensionCommandFile,
            "--extension-command-file",
          ),
          sourceFiles: values["extension-source-file"]!,
          caseId: values["case-id"]!,
          configurationFile: values["extension-configuration-file"]
            ? absoluteOption(
                values["extension-configuration-file"],
                "--extension-configuration-file",
              )
            : undefined,
          redactedConfigurationFile: values[
            "extension-redacted-configuration-file"
          ]
            ? absoluteOption(
                values["extension-redacted-configuration-file"],
                "--extension-redacted-configuration-file",
              )
            : undefined,
          taskVerdictPolicy,
        }
      : undefined,
    caseSourceRoot: values["case-source-root"]
      ? absoluteOption(values["case-source-root"], "--case-source-root")
      : undefined,
    caseSourceMapFile: values["case-source-map-file"]
      ? absoluteOption(values["case-source-map-file"], "--case-source-map-file")
      : undefined,
    adapterModule: codex
      ? undefined
      : absoluteOption(values["adapter-module"], "--adapter-module"),
    semanticAdapterModule: values["semantic-adapter-module"]
      ? absoluteOption(
          values["semantic-adapter-module"],
          "--semantic-adapter-module",
        )
      : undefined,
    semanticCodex: semanticCodex
      ? {
          ...codexCommon!,
          model: requiredOption(values["semantic-model"], "--semantic-model"),
          effort: requiredOption(
            values["semantic-effort"],
            "--semantic-effort",
          ),
        }
      : undefined,
    codex: codex
      ? {
          ...codexCommon!,
          model: requiredOption(values.model, "--model"),
          effort: requiredOption(values.effort, "--effort"),
        }
      : undefined,
    shellIsolation: values["shell-isolation"]
      ? { protectedRoots: privateRoots }
      : undefined,
    projectRoot,
    resultsRoot,
    runStateRoot,
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

async function loadJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new InvocationError(`${label} is unreadable or invalid`);
  }
}

async function loadExtensionOptions(
  selected: NonNullable<ReturnType<typeof parseInvocation>["extension"]>,
) {
  const command = await loadJson(
    selected.commandFile,
    "extension command file",
  );
  if (
    !Array.isArray(command) ||
    !command.length ||
    !command.every((part) => typeof part === "string" && part.length) ||
    !isAbsolute(command[0])
  )
    throw new InvocationError(
      "extension command must be an absolute argv array",
    );
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
  return { command: command as string[], configuration, redactedConfiguration };
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
    fixture:
      resolvedCase.fixture.kind === "inline"
        ? { files: resolvedCase.fixture.files }
        : { sourceRef: resolvedCase.fixture.sourceRef },
  });
  return { caseData, resolvedCase };
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
  let caseData: ResolvedCase | undefined;
  let host: HostAdapter;
  let semanticHost: HostAdapter | undefined;
  try {
    invocation = parseInvocation(argv);
    if (invocation.caseFile) caseData = await loadCase(invocation.caseFile);
    host = invocation.codex
      ? createCodexHost(invocation.codex)
      : await loadHost(invocation.adapterModule!);
    if (invocation.semanticAdapterModule)
      semanticHost = await loadHost(invocation.semanticAdapterModule);
    else if (invocation.semanticCodex)
      semanticHost = createCodexHost(invocation.semanticCodex);
  } catch (error) {
    const result = failure(
      64,
      error instanceof Error ? error.message : "invalid invocation",
    );
    display(result, json);
    process.exitCode = 64;
    return;
  }
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort("SIGINT");
  const terminate = () => cancellation.abort("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const preparationSources = await loadPreparationSources(invocation);
    let extension:
      | {
          session: Awaited<ReturnType<typeof openExtensionSession>>;
          resolvedCase: ExtensionCase;
        }
      | undefined;
    if (invocation.extension) {
      const selected = invocation.extension;
      const options = await loadExtensionOptions(selected);
      const session = await openExtensionSession({
        ...options,
        sourceFiles: selected.sourceFiles,
        engineCapabilities: ["sevro.host.exec"],
        hostCapabilities: [],
        taskVerdictPolicy: selected.taskVerdictPolicy,
        signal: cancellation.signal,
      });
      const chosen = selectExtensionCase(
        await session.resolve(pathToFileURL(invocation.projectRoot).href, {
          caseIds: [selected.caseId],
        }),
        selected.caseId,
      );
      caseData = chosen.caseData;
      extension = { session, resolvedCase: chosen.resolvedCase };
    }
    const { result } = await runEvaluation({
      projectRoot: invocation.projectRoot,
      resultsRoot: invocation.resultsRoot,
      runStateRoot: invocation.runStateRoot,
      case: caseData!,
      extension,
      preparationSources,
      host,
      semanticHost,
      shellIsolation: invocation.shellIsolation,
      runnerBuildDigest: invocation.runnerBuildDigest,
      projectDigest: invocation.projectDigest,
      condition: invocation.condition,
      trialCount: invocation.trialCount,
      passThreshold: invocation.passThreshold,
      dry: invocation.dry,
      signal: cancellation.signal,
    });
    display(result, invocation.json);
    process.exitCode = result.exitCode;
  } catch (error) {
    const code =
      error instanceof EvaluationConfigurationError ||
      error instanceof InvocationError
        ? 64
        : 70;
    const message = error instanceof Error ? error.message : "runner failure";
    const result = failure(code, message);
    display(result, invocation.json);
    process.exitCode = code;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

await main(process.argv.slice(2));
