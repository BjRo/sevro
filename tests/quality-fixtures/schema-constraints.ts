import { isRecord, isUnknownArray } from "../../src/value-guards";

export function invalidConstraintValues(
  schema: Record<string, unknown>,
  value: unknown,
): unknown[] {
  return [
    ...numericValues(schema),
    ...stringValues(schema),
    ...arrayValues(schema, value),
    ...objectValues(schema, value),
    ...declaredValues(schema),
    ...patternValues(schema),
  ];
}

const invalidPatternExamples = new Map<string, string[]>([
  ["^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$", ["unnamespaced", "example.UPPER"]],
  ["^[a-f0-9]{64}$", ["A".repeat(64), "a".repeat(63)]],
  [
    "^sevro\\.extension\\.v[1-9][0-9]*$",
    ["sevro.extension.v0", "foreign.extension.v1"],
  ],
  ["^file:///", ["https://example.com/artifact", "file://relative"]],
]);

function patternValues(schema: Record<string, unknown>): unknown[] {
  if (typeof schema.pattern !== "string") return [];
  const invalid = invalidPatternExamples.get(schema.pattern);
  if (!invalid)
    throw new Error(`No independent pattern examples: ${schema.pattern}`);
  return invalid;
}

function numericValues(schema: Record<string, unknown>): unknown[] {
  const values: unknown[] = [];
  if (typeof schema.minimum === "number") values.push(schema.minimum - 1);
  if (typeof schema.maximum === "number") values.push(schema.maximum + 1);
  if (schema.type === "integer") values.push(0.5);
  return values;
}

function stringValues(schema: Record<string, unknown>): unknown[] {
  const values: unknown[] = [];
  if (typeof schema.minLength === "number" && schema.minLength > 0)
    values.push("");
  if (typeof schema.maxLength === "number")
    values.push("x".repeat(schema.maxLength + 1));
  return values;
}

function arrayValues(
  schema: Record<string, unknown>,
  value: unknown,
): unknown[] {
  const values: unknown[] = [];
  if (typeof schema.minItems === "number" && schema.minItems > 0)
    values.push([]);
  if (schema.uniqueItems === true) values.push(...duplicateValues(value));
  return values;
}

function duplicateValues(value: unknown): unknown[] {
  if (!isUnknownArray(value) || !value.length) return [];
  return [[value[0], value[0]]];
}

function objectValues(
  schema: Record<string, unknown>,
  value: unknown,
): unknown[] {
  if (schema.additionalProperties !== false || !isRecord(value)) return [];
  return [{ ...value, __undeclared_schema_field__: true }];
}

function declaredValues(schema: Record<string, unknown>): unknown[] {
  if (Object.hasOwn(schema, "const") || isUnknownArray(schema.enum))
    return ["__invalid_schema_choice__"];
  return [];
}
