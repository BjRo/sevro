import { isRecord, isUnknownArray } from "../value-guards";
import { isDeepStrictEqual } from "node:util";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { canonicalJson } from "../identity";
import type { CheckOutcome } from "../results";

type GraderId = "sevro.regex" | "sevro.json" | "sevro.schema" | "sevro.output";

export function isOutputGrader(id: string): id is GraderId {
  return (
    id === "sevro.regex" ||
    id === "sevro.json" ||
    id === "sevro.schema" ||
    id === "sevro.output"
  );
}

export interface OutputCheckDeclaration {
  id: string;
  grader: GraderId;
  configuration: Record<string, unknown>;
}

interface ParsedDocument {
  value: unknown;
  exact: boolean;
  error: boolean;
}

export interface PreparedOutputCheck {
  id: string;
  grader: GraderId;
  evaluate: (text: string, document: ParsedDocument) => string | undefined;
}

function configKeys(config: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(config))
    if (!allowed.includes(key))
      throw new Error(`unsupported check configuration: ${key}`);
}

function regexFlags(config: Record<string, unknown>): string {
  if (config.flags !== undefined && typeof config.flags !== "string")
    throw new Error("regex flags must be a string");
  return `m${config.flags ?? ""}`;
}

function compileRegex(
  config: Record<string, unknown>,
): PreparedOutputCheck["evaluate"] {
  configKeys(config, ["pattern", "negate", "flags"]);
  if (
    typeof config.pattern !== "string" ||
    (config.negate !== undefined && typeof config.negate !== "boolean")
  )
    throw new Error("invalid regex check configuration");
  let pattern: RegExp;
  try {
    pattern = new RegExp(config.pattern, regexFlags(config));
  } catch {
    throw new Error("invalid regex pattern or flags");
  }
  return (text) => {
    pattern.lastIndex = 0;
    const matched = pattern.test(text);
    return matched !== Boolean(config.negate)
      ? undefined
      : "regex assertion failed";
  };
}

function pointerValue(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer))
    throw new Error("invalid JSON pointer");
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((current, part) => {
      if (!current || typeof current !== "object" || !(part in current))
        throw new Error("JSON pointer does not resolve");
      return (current as Record<string, unknown>)[part];
    }, value);
}

function subsetRegexPattern(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 1 && Object.hasOwn(value, "$regex");
}
function validateSubsetRegex(pattern: unknown): void {
  if (typeof pattern !== "string") throw new Error("invalid subset regex");
  try {
    new RegExp(pattern);
  } catch (cause) {
    throw new Error("invalid subset regex", { cause });
  }
}
function validateSubsetPatterns(value: unknown): void {
  if (isUnknownArray(value)) {
    value.forEach(validateSubsetPatterns);
    return;
  }
  if (!isRecord(value)) return;
  if (subsetRegexPattern(value)) {
    validateSubsetRegex(value.$regex);
    return;
  }
  Object.values(value).forEach(validateSubsetPatterns);
}

function containsSubset(value: unknown, expected: unknown): boolean {
  if (isUnknownArray(expected)) return arraySubset(value, expected);
  if (isRecord(expected)) return recordSubset(value, expected);
  return Object.is(value, expected);
}
function arraySubset(value: unknown, expected: unknown[]): boolean {
  return (
    isUnknownArray(value) &&
    expected.every((part) => value.some((item) => containsSubset(item, part)))
  );
}
function recordSubset(
  value: unknown,
  expected: Record<string, unknown>,
): boolean {
  if (Object.keys(expected).length === 1 && typeof expected.$regex === "string")
    return typeof value === "string" && new RegExp(expected.$regex).test(value);
  return objectSubset(value, expected);
}
function objectSubset(
  value: unknown,
  expected: Record<string, unknown>,
): boolean {
  if (!value || typeof value !== "object") return false;
  const actual = value as Record<string, unknown>;
  return Object.entries(expected).every(([key, part]) =>
    containsSubset(actual[key], part),
  );
}

type JsonConfiguration = Record<string, unknown> & {
  pointer?: string;
  exactDocument?: boolean;
};
function validPointer(pointer: string): boolean {
  return (
    pointer === "" || (pointer.startsWith("/") && !/~(?![01])/.test(pointer))
  );
}
function requireOptionalPointer(pointer: unknown): void {
  if (pointer === undefined) return;
  if (typeof pointer !== "string")
    throw new Error("JSON pointer must be a string");
  if (!validPointer(pointer)) throw new Error("invalid JSON pointer");
}
function requireExactDocument(value: unknown): void {
  if (value !== undefined && typeof value !== "boolean")
    throw new Error("exactDocument must be boolean");
}
function requireJsonConfiguration(
  config: Record<string, unknown>,
): asserts config is JsonConfiguration {
  requireOptionalPointer(config.pointer);
  requireExactDocument(config.exactDocument);
}

function compileJson(
  config: Record<string, unknown>,
): PreparedOutputCheck["evaluate"] {
  configKeys(config, ["pointer", "equals", "contains", "exactDocument"]);
  requireJsonConfiguration(config);
  if (Object.hasOwn(config, "equals")) canonicalJson(config.equals);
  if (Object.hasOwn(config, "contains")) {
    canonicalJson(config.contains);
    validateSubsetPatterns(config.contains);
  }
  return (_text, document) => evaluateJson(config, document);
}
function documentFailure(
  document: ParsedDocument,
  exactDocument: unknown,
): string | undefined {
  if (document.error) return "output is not valid JSON";
  if (exactDocument && !document.exact)
    return "output is not exactly one JSON document";
  return undefined;
}
function selectedDocument(
  config: JsonConfiguration,
  document: ParsedDocument,
): { value: unknown } | { failure: string } {
  try {
    return { value: pointerValue(document.value, config.pointer ?? "") };
  } catch {
    return { failure: "JSON pointer does not resolve" };
  }
}
function equalsFailure(
  selected: unknown,
  config: Record<string, unknown>,
): string | undefined {
  return Object.hasOwn(config, "equals") &&
    !isDeepStrictEqual(selected, config.equals)
    ? "JSON value did not equal expectation"
    : undefined;
}
function containsFailure(
  selected: unknown,
  config: Record<string, unknown>,
): string | undefined {
  if (!Object.hasOwn(config, "contains")) return undefined;
  if (
    !isUnknownArray(selected) ||
    !selected.some((item) => containsSubset(item, config.contains))
  )
    return "JSON array did not contain expected item";
  return undefined;
}
function evaluateJson(
  config: JsonConfiguration,
  document: ParsedDocument,
): string | undefined {
  const failure = documentFailure(document, config.exactDocument);
  if (failure) return failure;
  const selected = selectedDocument(config, document);
  if ("failure" in selected) return selected.failure;
  return (
    equalsFailure(selected.value, config) ??
    containsFailure(selected.value, config)
  );
}

function requireSchema(value: unknown): asserts value is object {
  if (!isRecord(value))
    throw new Error("schema check requires an inline JSON Schema object");
}
function compileSchema(
  config: Record<string, unknown>,
): PreparedOutputCheck["evaluate"] {
  configKeys(config, ["schema", "exactDocument"]);
  requireSchema(config.schema);
  requireExactDocument(config.exactDocument);
  canonicalJson(config.schema);
  let validate: ValidateFunction;
  try {
    validate = new Ajv2020({ strict: false }).compile(config.schema);
  } catch (cause) {
    throw new Error("invalid inline JSON Schema", { cause });
  }
  return (_text, document) =>
    documentFailure(document, config.exactDocument) ??
    (validate(document.value) ? undefined : "output did not match JSON Schema");
}

/** One named assertion may combine independent final-message predicates. */

function requireCompositeTypes(config: Record<string, unknown>): void {
  if (config.validJson !== undefined && typeof config.validJson !== "boolean")
    throw new Error("validJson must be a boolean");
  if (
    config.expectExact !== undefined &&
    typeof config.expectExact !== "string"
  )
    throw new Error("expectExact must be a string");
}
function requireCompositePointer(config: Record<string, unknown>): void {
  if (
    (Object.hasOwn(config, "expectJson") ||
      Object.hasOwn(config, "containsJson")) &&
    config.jsonPath === undefined
  )
    throw new Error("JSON expectations require a pointer");
}
function requireCompositeRegex(config: Record<string, unknown>): void {
  if (
    config.flags !== undefined &&
    config.expectRegex === undefined &&
    config.notRegex === undefined
  )
    throw new Error("regex flags require a pattern");
}
function compositePointerConfiguration(config: Record<string, unknown>) {
  return {
    pointer: config.jsonPath,
    ...(Object.hasOwn(config, "expectJson")
      ? { equals: config.expectJson }
      : {}),
    ...(Object.hasOwn(config, "containsJson")
      ? { contains: config.containsJson }
      : {}),
  };
}
function compositeJsonStages(
  config: Record<string, unknown>,
): PreparedOutputCheck["evaluate"][] {
  const stages: PreparedOutputCheck["evaluate"][] = [];
  if (config.validJson) stages.push(compileJson({ exactDocument: true }));
  if (config.schema !== undefined)
    stages.push(compileSchema({ schema: config.schema }));
  if (config.jsonPath !== undefined)
    stages.push(compileJson(compositePointerConfiguration(config)));
  return stages;
}
function compositeTextStages(
  config: Record<string, unknown>,
): PreparedOutputCheck["evaluate"][] {
  const stages: PreparedOutputCheck["evaluate"][] = [];
  if (config.expectExact !== undefined) {
    const expected = config.expectExact;
    stages.push((text) =>
      text === expected ? undefined : "exact output did not match",
    );
  }
  if (config.expectRegex !== undefined)
    stages.push(
      compileRegex({ pattern: config.expectRegex, flags: config.flags }),
    );
  if (config.notRegex !== undefined)
    stages.push(
      compileRegex({
        pattern: config.notRegex,
        negate: true,
        flags: config.flags,
      }),
    );
  return stages;
}
function compileCompositeOutput(
  config: Record<string, unknown>,
): PreparedOutputCheck["evaluate"] {
  configKeys(config, [
    "validJson",
    "schema",
    "jsonPath",
    "expectJson",
    "containsJson",
    "expectExact",
    "expectRegex",
    "notRegex",
    "flags",
  ]);
  requireCompositeTypes(config);
  requireCompositePointer(config);
  requireCompositeRegex(config);
  const stages = [
    ...compositeJsonStages(config),
    ...compositeTextStages(config),
  ];
  return (text, document) => {
    for (const stage of stages) {
      const failure = stage(text, document);
      if (failure !== undefined) return failure;
    }
    return undefined;
  };
}

/** Compile evaluator-owned checks before candidate execution. */
export function prepareOutputChecks(
  declarations: OutputCheckDeclaration[],
): PreparedOutputCheck[] {
  const seen = new Set<string>();
  return declarations.map((declaration) =>
    prepareOutputCheck(declaration, seen),
  );
}

function requireOutputConfiguration(
  value: unknown,
  id: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid check configuration: ${id}`);
}
const OUTPUT_COMPILERS = new Map<
  string,
  (config: Record<string, unknown>) => PreparedOutputCheck["evaluate"]
>([
  ["sevro.regex", compileRegex],
  ["sevro.json", compileJson],
  ["sevro.schema", compileSchema],
  ["sevro.output", compileCompositeOutput],
]);
function prepareOutputCheck(
  { id, grader, configuration }: OutputCheckDeclaration,
  seen: Set<string>,
): PreparedOutputCheck {
  if (!id || seen.has(id))
    throw new Error(`duplicate or empty check ID: ${id}`);
  seen.add(id);
  requireOutputConfiguration(configuration, id);
  const compiler = OUTPUT_COMPILERS.get(grader);
  if (!compiler) throw new Error(`unsupported output grader: ${grader}`);
  return { id, grader, evaluate: compiler(configuration) };
}

function parseJsonDocument(text: string): ParsedDocument {
  try {
    return { value: JSON.parse(text), exact: true, error: false };
  } catch {
    const fences = [...text.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/gi)];
    const [fence] = fences;
    if (fences.length !== 1 || fence === undefined)
      return { value: null, exact: false, error: true };
    try {
      return {
        value: JSON.parse(fence.slice(1, 2).join("")),
        exact: text.trim() === fence[0],
        error: false,
      };
    } catch {
      return { value: null, exact: false, error: true };
    }
  }
}

/** Grade one bounded final-message observation. Incomplete evidence is unavailable. */
export function gradeOutput(
  text: string | null,
  complete: boolean,
  checks: PreparedOutputCheck[],
): CheckOutcome[] {
  if (!complete || text === null)
    return checks.map(({ id, grader }) => ({
      id,
      grader,
      status: "unavailable",
      detail: "output observation unavailable",
    }));
  const document = checks.some((check) => check.grader !== "sevro.regex")
    ? parseJsonDocument(text)
    : { value: null, exact: false, error: true };
  return checks.map(({ id, grader, evaluate }) => {
    const failure = evaluate(text, document);
    return {
      id,
      grader,
      status: failure ? "failed" : "passed",
      detail: failure ?? "ok",
    };
  });
}
