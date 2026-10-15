import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { isResolvedCase, resolvedCaseIssue } from "../case-validation";
import type { HostAdapter, ResolvedCase } from "../engine";
import { prepareInstrumentation } from "../instrumentation";
import { isRecord, isStringArray } from "../value-guards";
import { InvocationError, type Invocation } from "./invocation";

export function parseCase(value: unknown): ResolvedCase {
  if (!isResolvedCase(value))
    throw new InvocationError(
      `invalid resolved case file: ${resolvedCaseIssue(value) ?? "invalid case"}`,
    );
  return value;
}

export async function loadCase(path: string): Promise<ResolvedCase> {
  try {
    return parseCase(JSON.parse(await readFile(path, "utf8")));
  } catch (cause) {
    const detail = cause instanceof InvocationError ? `: ${cause.message}` : "";
    throw new InvocationError(
      `resolved case file is unreadable or invalid at ${path}${detail}; supply --case-file with readable JSON and correct the named field`,
      {
        cause,
      },
    );
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

export async function loadExtensionOptions(
  selected: NonNullable<Invocation["extension"]>,
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
  if (!isRecord(configuration) || !isRecord(redactedConfiguration))
    throw new InvocationError("extension configuration must be JSON objects");
  return { command, configuration, redactedConfiguration };
}

export async function loadPreparationSources(selected: Invocation) {
  if (!selected.caseSourceRoot || !selected.caseSourceMapFile) return undefined;
  const refs = await loadJson(
    selected.caseSourceMapFile,
    "case source map file",
  );
  if (
    !isRecord(refs) ||
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

async function adapterModule(path: string): Promise<unknown> {
  try {
    return await import(pathToFileURL(path).href);
  } catch (cause) {
    throw new InvocationError(
      `host adapter module could not be loaded at ${path}; check that the module exists and imports successfully, then correct --adapter-module or the selected grading adapter option`,
      { cause },
    );
  }
}

export async function loadHost(path: string): Promise<HostAdapter> {
  const module = await adapterModule(path);
  const host = isRecord(module) ? module.default : null;
  if (!validHostAdapter(host))
    throw new InvocationError(
      `host adapter module has no valid default adapter at ${path}; export a default adapter with string id, model, effort and a run function`,
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
    isRecord(value) &&
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
