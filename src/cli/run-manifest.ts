import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isRecord, isStringArray } from "../value-guards";
import {
  CLI_ONLY,
  LIST_OPTIONS,
  NUMBER_OPTIONS,
  PATH_OPTIONS,
  PATH_LIST_OPTIONS,
  RUN_OPTIONS,
  type RunValues,
} from "./run-options";
import { overrideRunSelections } from "./run-overrides";

const FILE_LIMIT = 64 * 1024;

function fieldError(field: string, requirement: string): never {
  throw new Error(`run manifest ${field}: ${requirement}`);
}

function manifestSettings(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fieldError("$", "expected an object");
  validateManifestFields(value);
  if (value.format !== "sevro.run.v1")
    fieldError("format", 'expected "sevro.run.v1"');
  if (!isRecord(value.settings))
    fieldError("settings", "expected an object of run options");
  return value.settings;
}

function validateManifestFields(value: Record<string, unknown>): void {
  for (const key of Object.keys(value))
    if (!["format", "settings"].includes(key))
      fieldError(key, "unknown field; use format and settings");
}

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function nonemptyString(value: unknown): boolean {
  return typeof value === "string" && Boolean(value.trim());
}

function nonemptyStringList(value: unknown): boolean {
  return isStringArray(value) && value.every(nonemptyString);
}

function validateSetting(name: string, value: unknown): void {
  if (!Object.hasOwn(RUN_OPTIONS, name) || CLI_ONLY.has(name))
    fieldError(
      `settings.${name}`,
      "unknown saved option; see sevro run --help",
    );
  if (NUMBER_OPTIONS.has(name)) {
    if (!finiteNumber(value))
      fieldError(`settings.${name}`, "expected a finite number");
    return;
  }
  validateOrdinarySetting(name, value);
}

function validateOrdinarySetting(name: string, value: unknown): void {
  if (LIST_OPTIONS.has(name)) {
    if (!nonemptyStringList(value))
      fieldError(`settings.${name}`, "expected an array of nonempty strings");
    return;
  }
  const option = RUN_OPTIONS[name as keyof typeof RUN_OPTIONS];
  validateScalar(name, value, option.type);
}

function validateScalar(name: string, value: unknown, type: string): void {
  if (type === "boolean") {
    if (typeof value !== "boolean")
      fieldError(`settings.${name}`, "expected a boolean");
  } else if (!nonemptyString(value))
    fieldError(`settings.${name}`, "expected a nonempty string");
}

function resolvedSetting(name: string, value: unknown, base: string) {
  const pathOption = (PATH_OPTIONS as readonly string[]).includes(name);
  if (pathOption) return resolve(base, value as string);
  if ((PATH_LIST_OPTIONS as readonly string[]).includes(name))
    return (value as string[]).map((path) => resolve(base, path));
  return NUMBER_OPTIONS.has(name) ? String(value) : value;
}

async function readManifest(path: string): Promise<RunValues> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > FILE_LIMIT)
    fieldError("$", "use a regular, non-symlink JSON file of at most 64 KiB");
  const source = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new Error("run manifest $: invalid JSON; check the JSON syntax", {
      cause,
    });
  }
  const settings = manifestSettings(value);
  const base = dirname(await realpath(path));
  const resolved: Record<string, unknown> = {};
  for (const [name, setting] of Object.entries(settings)) {
    validateSetting(name, setting);
    resolved[name] = resolvedSetting(name, setting, base);
  }
  return resolved;
}

/** Explicit flags replace saved selections and lists; defaults are applied later. */
export async function savedRunValues(explicit: RunValues): Promise<RunValues> {
  const file = explicit["run-manifest-file"];
  if (!file) return explicit;
  const path = resolve(file);
  try {
    const saved = await readManifest(path);
    overrideRunSelections(saved, explicit);
    return { ...saved, ...explicit };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "cannot read file";
    throw new Error(
      `--run-manifest-file ${path}: ${detail}; correct the named field or select a readable manifest`,
      { cause },
    );
  }
}
