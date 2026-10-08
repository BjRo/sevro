import cliSchema from "../../schemas/cli-result-v1.schema.json";
import {
  isRecord,
  isStringArray,
  isUnknownArray,
} from "../../src/value-guards";
import type { Path } from "./schema-boundaries";

interface Boundary {
  path: Path;
  types: Set<string>;
}
const candidates = [
  { type: "array", value: [] },
  { type: "object", value: {} },
  { type: "boolean", value: false },
  { type: "string", value: "wrong JSON type" },
  { type: "number", value: 0 },
  { type: "null", value: null },
];

function schemaMember(value: unknown, key: string): unknown {
  if (!isRecord(value)) throw new Error("Expected a schema reference object");
  return value[key];
}

function referenceTarget(reference: string, root: unknown) {
  const [id, fragment = ""] = reference.split("#");
  const targetRoot = id ? cliSchema : root;
  if (id && id !== "urn:sevro:schema:cli-result:v1")
    throw new Error(`Unsupported published schema reference: ${id}`);
  const target = fragment
    .split("/")
    .filter(Boolean)
    .reduce<unknown>(
      (value, key) =>
        schemaMember(value, key.replaceAll("~1", "/").replaceAll("~0", "~")),
      targetRoot,
    );
  return { target, root: targetRoot };
}

function collectTypes(
  schema: Record<string, unknown>,
  path: Path,
  boundaries: Map<string, Boundary>,
): void {
  const declared =
    typeof schema.type === "string" ? [schema.type] : schema.type;
  if (!isStringArray(declared)) return;
  const key = JSON.stringify(path);
  const boundary = boundaries.get(key) ?? { path, types: new Set<string>() };
  for (const type of declared) boundary.types.add(jsonType(type));
  boundaries.set(key, boundary);
}

function jsonType(schemaType: string): string {
  return schemaType === "integer" ? "number" : schemaType;
}

function properties(
  schema: Record<string, unknown>,
  value: unknown,
  path: Path,
  root: unknown,
  boundaries: Map<string, Boundary>,
): void {
  if (!isRecord(value) || !isRecord(schema.properties)) return;
  for (const [key, child] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(value, key)) continue;
    visit(child, value[key], [...path, key], root, boundaries);
  }
}

function items(
  schema: Record<string, unknown>,
  value: unknown,
  path: Path,
  root: unknown,
  boundaries: Map<string, Boundary>,
): void {
  if (!isUnknownArray(value)) return;
  for (const [index, child] of value.entries())
    visit(schema.items, child, [...path, index], root, boundaries);
}

function variants(
  schema: Record<string, unknown>,
  value: unknown,
  path: Path,
  root: unknown,
  boundaries: Map<string, Boundary>,
): void {
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    const choices = schema[key];
    if (!isUnknownArray(choices)) continue;
    for (const choice of choices) visit(choice, value, path, root, boundaries);
  }
}

function visit(
  schema: unknown,
  value: unknown,
  path: Path,
  root: unknown,
  boundaries: Map<string, Boundary>,
): void {
  if (!isRecord(schema)) return;
  if (typeof schema.$ref === "string") {
    const resolved = referenceTarget(schema.$ref, root);
    visit(resolved.target, value, path, resolved.root, boundaries);
    return;
  }
  collectTypes(schema, path, boundaries);
  properties(schema, value, path, root, boundaries);
  items(schema, value, path, root, boundaries);
  variants(schema, value, path, root, boundaries);
}

/** The published type declaration, rather than validator output, supplies the oracle. */
export function forbiddenJsonTypes(schema: unknown, value: unknown) {
  const boundaries = new Map<string, Boundary>();
  visit(schema, value, [], schema, boundaries);
  return [...boundaries.values()].flatMap((boundary) =>
    candidates
      .filter((candidate) => !boundary.types.has(candidate.type))
      .map((candidate) => ({
        path: boundary.path,
        type: candidate.type,
        replacement: candidate.value,
      })),
  );
}
