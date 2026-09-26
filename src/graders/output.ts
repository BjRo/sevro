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

function validateSubsetPatterns(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(validateSubsetPatterns);
    return;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && Object.hasOwn(record, "$regex")) {
    if (typeof record.$regex !== "string")
      throw new Error("invalid subset regex");
    try {
      new RegExp(record.$regex);
    } catch {
      throw new Error("invalid subset regex");
    }
    return;
  }
  Object.values(record).forEach(validateSubsetPatterns);
}

function containsSubset(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(value) &&
      expected.every((part) => value.some((item) => containsSubset(item, part)))
    );
  if (expected && typeof expected === "object") {
    const record = expected as Record<string, unknown>;
    if (Object.keys(record).length === 1 && typeof record.$regex === "string")
      return typeof value === "string" && new RegExp(record.$regex).test(value);
    return Boolean(
      value &&
      typeof value === "object" &&
      Object.entries(record).every(([key, part]) =>
        containsSubset((value as Record<string, unknown>)[key], part),
      ),
    );
  }
  return Object.is(value, expected);
}

function compileJson(
  config: Record<string, unknown>,
): PreparedOutputCheck["evaluate"] {
  configKeys(config, ["pointer", "equals", "contains", "exactDocument"]);
  if (config.pointer !== undefined && typeof config.pointer !== "string")
    throw new Error("JSON pointer must be a string");
  if (
    config.pointer !== undefined &&
    config.pointer !== "" &&
    (!config.pointer.startsWith("/") || /~(?![01])/.test(config.pointer))
  )
    throw new Error("invalid JSON pointer");
  if (
    config.exactDocument !== undefined &&
    typeof config.exactDocument !== "boolean"
  )
    throw new Error("exactDocument must be boolean");
  if (Object.hasOwn(config, "equals")) canonicalJson(config.equals);
  if (Object.hasOwn(config, "contains")) {
    canonicalJson(config.contains);
    validateSubsetPatterns(config.contains);
  }
  return (_text, document) => {
    if (document.error) return "output is not valid JSON";
    if (config.exactDocument && !document.exact)
      return "output is not exactly one JSON document";
    let selected: unknown;
    try {
      selected = pointerValue(
        document.value,
        (config.pointer as string | undefined) ?? "",
      );
    } catch {
      return "JSON pointer does not resolve";
    }
    if (
      Object.hasOwn(config, "equals") &&
      !isDeepStrictEqual(selected, config.equals)
    )
      return "JSON value did not equal expectation";
    if (
      Object.hasOwn(config, "contains") &&
      (!Array.isArray(selected) ||
        !selected.some((item) => containsSubset(item, config.contains)))
    )
      return "JSON array did not contain expected item";
    return undefined;
  };
}

function compileSchema(
  config: Record<string, unknown>,
): PreparedOutputCheck["evaluate"] {
  configKeys(config, ["schema", "exactDocument"]);
  if (
    !config.schema ||
    typeof config.schema !== "object" ||
    Array.isArray(config.schema)
  )
    throw new Error("schema check requires an inline JSON Schema object");
  if (
    config.exactDocument !== undefined &&
    typeof config.exactDocument !== "boolean"
  )
    throw new Error("exactDocument must be boolean");
  canonicalJson(config.schema);
  let validate: ValidateFunction;
  try {
    validate = new Ajv2020({ strict: false }).compile(config.schema);
  } catch {
    throw new Error("invalid inline JSON Schema");
  }
  return (_text, document) => {
    if (document.error) return "output is not valid JSON";
    if (config.exactDocument && !document.exact)
      return "output is not exactly one JSON document";
    return validate(document.value)
      ? undefined
      : "output did not match JSON Schema";
  };
}

/** One named assertion may combine independent final-message predicates. */
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
  if (config.validJson !== undefined && typeof config.validJson !== "boolean")
    throw new Error("validJson must be a boolean");
  if (
    config.expectExact !== undefined &&
    typeof config.expectExact !== "string"
  )
    throw new Error("expectExact must be a string");
  if (
    (Object.hasOwn(config, "expectJson") ||
      Object.hasOwn(config, "containsJson")) &&
    config.jsonPath === undefined
  )
    throw new Error("JSON expectations require a pointer");
  if (
    config.flags !== undefined &&
    config.expectRegex === undefined &&
    config.notRegex === undefined
  )
    throw new Error("regex flags require a pattern");
  const stages: PreparedOutputCheck["evaluate"][] = [];
  if (config.validJson) stages.push(compileJson({ exactDocument: true }));
  if (config.schema !== undefined)
    stages.push(compileSchema({ schema: config.schema }));
  if (config.jsonPath !== undefined)
    stages.push(
      compileJson({
        pointer: config.jsonPath,
        ...(Object.hasOwn(config, "expectJson")
          ? { equals: config.expectJson }
          : {}),
        ...(Object.hasOwn(config, "containsJson")
          ? { contains: config.containsJson }
          : {}),
      }),
    );
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
  return declarations.map(({ id, grader, configuration }) => {
    if (!id || seen.has(id))
      throw new Error(`duplicate or empty check ID: ${id}`);
    seen.add(id);
    if (
      !configuration ||
      typeof configuration !== "object" ||
      Array.isArray(configuration)
    )
      throw new Error(`invalid check configuration: ${id}`);
    const evaluate =
      grader === "sevro.regex"
        ? compileRegex(configuration)
        : grader === "sevro.json"
          ? compileJson(configuration)
          : grader === "sevro.schema"
            ? compileSchema(configuration)
            : grader === "sevro.output"
              ? compileCompositeOutput(configuration)
              : undefined;
    if (!evaluate) throw new Error(`unsupported output grader: ${grader}`);
    return { id, grader, evaluate };
  });
}

function parseJsonDocument(text: string): ParsedDocument {
  try {
    return { value: JSON.parse(text), exact: true, error: false };
  } catch {
    const fences = [...text.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/gi)];
    if (fences.length !== 1) return { value: null, exact: false, error: true };
    try {
      return {
        value: JSON.parse(fences[0]![1]!),
        exact: text.trim() === fences[0]![0],
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
