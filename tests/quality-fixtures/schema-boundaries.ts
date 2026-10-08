import {
  isRecord,
  isUnknownArray,
  isStringArray,
} from "../../src/value-guards";
import cliSchema from "../../schemas/cli-result-v1.schema.json";
import runSchema from "../../schemas/run-evidence-v1.schema.json";
import reportSchema from "../../schemas/report-v1.schema.json";
import { invalidConstraintValues } from "./schema-constraints";
export type Path = Array<string | number>;
type Collector = (
  schema: Record<string, unknown>,
  value: unknown,
  path: Path,
) => Path[];
const registry = new Map<string, unknown>([
  ["urn:sevro:schema:cli-result:v1", cliSchema],
  ["urn:sevro:schema:run-evidence:v1", runSchema],
  ["urn:sevro:schema:report:v1", reportSchema],
]);

const wrongTypeCandidates = [
  { type: "array", value: [] },
  { type: "object", value: {} },
  { type: "boolean", value: false },
  { type: "string", value: "" },
  { type: "number", value: 0 },
  { type: "null", value: null },
];

function typeCollector(replacements: Map<string, unknown>): Collector {
  return (schema, value, path) => {
    if (value === undefined) return [];
    const types = schemaTypes(schema.type);
    if (!types.length) return [];
    const wrong = wrongTypeCandidates.find(
      (candidate) => !types.includes(candidate.type),
    );
    if (!wrong) return [];
    replacements.set(JSON.stringify(path), wrong.value);
    return [path];
  };
}

function schemaTypes(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return isStringArray(value) ? value : [];
}

function assign(value: unknown, key: string | number, replacement: unknown) {
  if (isUnknownArray(value) && typeof key === "number")
    value[key] = replacement;
  else if (isRecord(value) && typeof key === "string") value[key] = replacement;
  else throw new Error("Cannot replace schema field");
}

function replace(value: unknown, path: Path, replacement: unknown): unknown {
  if (!path.length) return replacement;
  const clone: unknown = structuredClone(value);
  const key = path.at(-1);
  if (key === undefined) throw new Error("Expected a mutation field");
  const parent = path
    .slice(0, -1)
    .reduce<unknown>((current, part) => member(current, part), clone);
  assign(parent, key, replacement);
  return clone;
}

function member(value: unknown, key: string | number): unknown {
  if (isUnknownArray(value) && typeof key === "number") return value[key];
  if (isRecord(value) && typeof key === "string") return value[key];
  throw new Error("Schema mutation path is not a container");
}

function resolveReference(reference: string, schemaRoot: unknown): unknown {
  const [id, fragment = ""] = reference.split("#");
  let value = id ? registry.get(id) : schemaRoot;
  for (const part of fragment.split("/").filter(Boolean))
    value = member(value, part.replaceAll("~1", "/").replaceAll("~0", "~"));
  return value;
}

function requiredFields(
  schema: Record<string, unknown>,
  value: unknown,
  path: Path,
): Path[] {
  if (!isRecord(value) || !isStringArray(schema.required)) return [];
  return schema.required
    .filter((key) => Object.hasOwn(value, key))
    .map((key) => [...path, key]);
}

function propertyPaths(
  schema: Record<string, unknown>,
  value: unknown,
  path: Path,
  schemaRoot: unknown,
  collector: Collector,
): Path[] {
  if (!isRecord(value)) return [];
  const properties = isRecord(schema.properties)
    ? Object.entries(schema.properties)
    : [];
  return [
    ...properties.flatMap(([key, child]) =>
      collectRequired(child, value[key], [...path, key], schemaRoot, collector),
    ),
    ...extraPropertyPaths(schema, value, path, schemaRoot, collector),
  ];
}

function extraPropertyPaths(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: Path,
  schemaRoot: unknown,
  collector: Collector,
): Path[] {
  if (!isRecord(schema.additionalProperties)) return [];
  const known = isRecord(schema.properties)
    ? Object.keys(schema.properties)
    : [];
  return Object.entries(value)
    .filter(([key]) => !known.includes(key))
    .flatMap(([key, current]) =>
      collectRequired(
        schema.additionalProperties,
        current,
        [...path, key],
        schemaRoot,
        collector,
      ),
    );
}

function itemPaths(
  schema: Record<string, unknown>,
  value: unknown,
  path: Path,
  schemaRoot: unknown,
  collector: Collector,
): Path[] {
  if (!isUnknownArray(value)) return [];
  return value.flatMap((item, index) =>
    collectRequired(
      schema.items,
      item,
      [...path, index],
      schemaRoot,
      collector,
    ),
  );
}

function variants(
  schema: Record<string, unknown>,
  value: unknown,
  path: Path,
  schemaRoot: unknown,
  collector: Collector,
): Path[] {
  return ["allOf", "oneOf", "anyOf"].flatMap((key) => {
    const choices = schema[key];
    if (!isUnknownArray(choices)) return [];
    const selected = choices.filter((choice) => declaredVariant(choice, value));
    if (
      collector !== requiredFields &&
      key !== "allOf" &&
      selected.length !== 1
    )
      return [];
    return selected.flatMap((choice) =>
      collectRequired(choice, value, path, schemaRoot, collector),
    );
  });
}

// Select the fixture's declared discriminator variant. A generated fixture's
// optional files must not be mistaken for the inline variant's required files.
function declaredVariant(schema: unknown, value: unknown): boolean {
  if (!isRecord(schema) || !isRecord(value)) return true;
  if (!isRecord(schema.properties)) return true;
  return Object.entries(schema.properties).every(([key, property]) => {
    if (!isRecord(property) || !Object.hasOwn(property, "const")) return true;
    return property.const === value[key];
  });
}

function collectRequired(
  schema: unknown,
  value: unknown,
  path: Path,
  schemaRoot: unknown,
  collector: Collector,
): Path[] {
  if (!isRecord(schema)) return [];
  if (typeof schema.$ref === "string") {
    const reference = schema.$ref;
    const targetRoot = reference.startsWith("#")
      ? schemaRoot
      : registry.get(reference.split("#")[0] ?? "");
    return collectRequired(
      resolveReference(reference, schemaRoot),
      value,
      path,
      targetRoot,
      collector,
    );
  }
  return [
    ...collector(schema, value, path),
    ...propertyPaths(schema, value, path, schemaRoot, collector),
    ...itemPaths(schema, value, path, schemaRoot, collector),
    ...variants(schema, value, path, schemaRoot, collector),
  ];
}

function remove(value: unknown, path: Path): unknown {
  const clone: unknown = structuredClone(value);
  const key = path.at(-1);
  if (key === undefined) throw new Error("Cannot delete a document root");
  const parent = path
    .slice(0, -1)
    .reduce<unknown>((current, part) => member(current, part), clone);
  if (!isRecord(parent)) throw new Error("Required fields belong to objects");
  Reflect.deleteProperty(parent, key);
  return clone;
}

export function requiredMutationPaths(
  schema: unknown,
  value: unknown,
  schemaRoot: unknown = schema,
): Path[] {
  return collectRequired(schema, value, [], schemaRoot, requiredFields);
}
export function typedMutations(
  schema: unknown,
  value: unknown,
  schemaRoot: unknown = schema,
) {
  const replacements = new Map<string, unknown>();
  return collectRequired(
    schema,
    value,
    [],
    schemaRoot,
    typeCollector(replacements),
  ).map((path) => ({
    path,
    replacement: replacements.get(JSON.stringify(path)),
  }));
}
export { remove, replace };

function optionalFields(
  schema: Record<string, unknown>,
  value: unknown,
  path: Path,
): Path[] {
  if (!isRecord(value) || !isRecord(schema.properties)) return [];
  const required = localRequiredKeys(schema, value);
  return Object.keys(schema.properties)
    .filter((key) => !required.includes(key) && Object.hasOwn(value, key))
    .map((key) => [...path, key]);
}

function localRequiredKeys(
  schema: Record<string, unknown>,
  value: unknown,
): string[] {
  const direct = isStringArray(schema.required) ? schema.required : [];
  const composed = ["allOf", "oneOf", "anyOf"].flatMap((key) =>
    composedRequired(schema[key], value),
  );
  return [...direct, ...composed];
}

function composedRequired(choices: unknown, value: unknown): string[] {
  if (!isUnknownArray(choices)) return [];
  return choices
    .filter(isRecord)
    .filter((choice) => declaredVariant(choice, value))
    .flatMap((choice) => localRequiredKeys(choice, value));
}

export function optionalMutationPaths(
  schema: unknown,
  value: unknown,
  schemaRoot: unknown = schema,
): Path[] {
  return collectRequired(schema, value, [], schemaRoot, optionalFields);
}

export function constraintMutations(
  schema: unknown,
  value: unknown,
  schemaRoot: unknown = schema,
) {
  const constraints = new Map<string, { path: Path; replacement: unknown }[]>();
  const collector: Collector = (boundary, current, path) => {
    if (current === undefined) return [];
    const replacements = invalidConstraintValues(boundary, current);
    if (!replacements.length) return [];
    constraints.set(
      JSON.stringify(path),
      replacements.map((replacement) => ({ path, replacement })),
    );
    return [path];
  };
  collectRequired(schema, value, [], schemaRoot, collector);
  return [...constraints.values()].flat();
}
