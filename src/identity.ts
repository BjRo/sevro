import { createHash } from "node:crypto";

const ALGORITHM = "sevro.identity.v1";
const DIGEST = /^[a-f0-9]{64}$/;
const DIMENSION_KEYS = [
  "runnerBuildDigest",
  "projectDigest",
  "configurationDigest",
  "extensionDigest",
  "extensionProtocol",
  "caseDigest",
  "fixtureDigest",
  "checksDigest",
  "requiredEvidenceDigest",
  "evaluatorDigest",
  "graderDigest",
  "instrumentationDigest",
  "routeDigest",
  "condition",
  "trialCount",
  "passThreshold",
] as const;

export interface IdentityDimensions {
  runnerBuildDigest: string;
  projectDigest: string;
  configurationDigest: string;
  extensionDigest: string | null;
  extensionProtocol: "sevro.extension.v1" | null;
  caseDigest: string;
  fixtureDigest: string;
  checksDigest: string;
  requiredEvidenceDigest: string;
  evaluatorDigest: string;
  graderDigest: string;
  instrumentationDigest: string;
  routeDigest: string;
  condition: "passive" | "enforced";
  trialCount: number;
  passThreshold: number;
}

function surrogateKind(code: number): "high" | "low" | null {
  if (code >= 0xd800 && code <= 0xdbff) return "high";
  return code >= 0xdc00 && code <= 0xdfff ? "low" : null;
}

function assertUnicode(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const kind = surrogateKind(value.charCodeAt(index));
    if (kind === "high") {
      if (surrogateKind(value.charCodeAt(++index)) !== "low")
        throw new Error("JSON string contains an unpaired surrogate");
    } else if (kind === "low") {
      throw new Error("JSON string contains an unpaired surrogate");
    }
  }
}

class CanonicalJsonWriter {
  private readonly visiting = new WeakSet();

  write(item: unknown): string {
    if (item === null) return "null";
    switch (typeof item) {
      case "string":
        assertUnicode(item);
        return JSON.stringify(item);
      case "number":
        return this.number(item);
      case "boolean":
        return item ? "true" : "false";
      case "object":
        return this.object(item);
      default:
        throw new Error("value is not JSON data");
    }
  }

  private number(item: number): string {
    if (!Number.isFinite(item)) throw new Error("JSON number must be finite");
    return JSON.stringify(item);
  }

  private object(item: object): string {
    if (this.visiting.has(item)) throw new Error("JSON value contains a cycle");
    this.visiting.add(item);
    try {
      if (Array.isArray(item))
        return `[${item.map((value: unknown) => this.write(value)).join(",")}]`;
      this.assertPlainObject(item);
      const entries = Object.keys(item)
        .sort()
        .map((key) => this.property(item, key));
      return `{${entries.join(",")}}`;
    } finally {
      this.visiting.delete(item);
    }
  }

  private assertPlainObject(item: object): void {
    const prototype: unknown = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("value is not a plain JSON object");
    if (Object.getOwnPropertySymbols(item).length)
      throw new Error("JSON object has symbol keys");
  }

  private property(item: object, key: string): string {
    assertUnicode(key);
    const descriptor = Object.getOwnPropertyDescriptor(item, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      throw new Error("JSON object has an accessor property");
    const value: unknown = descriptor.value;
    return `${JSON.stringify(key)}:${this.write(value)}`;
  }
}

/** RFC 8785 JSON canonicalization for ordinary JSON values. */
export function canonicalJson(value: unknown): string {
  return new CanonicalJsonWriter().write(value);
}

/** Hash exact bytes, or a string's UTF-8 bytes, without JSON canonicalization. */
export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

function validatedDimensions(value: unknown): IdentityDimensions {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("identity dimensions must be a JSON object");
  const record = value as Record<string, unknown>;
  validateDimensionKeys(record);
  validateDigestDimensions(record);
  validateExtensionDimension(record);
  validateTrialDimensions(record);
  return record as unknown as IdentityDimensions;
}

function validateDimensionKeys(record: Record<string, unknown>): void {
  for (const key of DIMENSION_KEYS)
    if (!Object.hasOwn(record, key))
      throw new Error(`missing identity dimension: ${key}`);
  const unexpected = Object.keys(record).filter(
    (key) => !DIMENSION_KEYS.includes(key as (typeof DIMENSION_KEYS)[number]),
  );
  const firstUnexpected = unexpected[0];
  if (firstUnexpected !== undefined)
    throw new Error(`unexpected identity dimension: ${firstUnexpected}`);
}

function validateDigestDimensions(record: Record<string, unknown>): void {
  for (const key of DIMENSION_KEYS.filter((name) => name.endsWith("Digest"))) {
    if (key === "extensionDigest" && record[key] === null) continue;
    if (!validDigest(record[key]))
      throw new Error(`invalid identity dimension: ${key}`);
  }
}

function validateExtensionDimension(record: Record<string, unknown>): void {
  if (
    (record.extensionDigest === null) !== (record.extensionProtocol === null) ||
    (record.extensionProtocol !== null &&
      record.extensionProtocol !== "sevro.extension.v1")
  )
    throw new Error("extension identity requires its matching protocol");
}

function validateTrialDimensions(record: Record<string, unknown>): void {
  if (record.condition !== "passive" && record.condition !== "enforced")
    throw new Error("invalid identity condition");
  if (
    !Number.isSafeInteger(record.trialCount) ||
    (record.trialCount as number) < 1
  )
    throw new Error("invalid identity trial count");
  validatePassThreshold(record.passThreshold);
}

function validatePassThreshold(value: unknown): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 1
  )
    throw new Error("invalid identity pass threshold");
}

/** Digest the exact comparison dimensions with a versioned domain prefix. */
export function createEvaluationIdentity(dimensions: unknown): {
  algorithm: typeof ALGORITHM;
  digest: string;
  dimensions: IdentityDimensions;
} {
  const checked = validatedDimensions(dimensions);
  const digest = createHash("sha256")
    .update(`${ALGORITHM}\n`, "utf8")
    .update(canonicalJson(checked), "utf8")
    .digest("hex");
  return { algorithm: ALGORITHM, digest, dimensions: checked };
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}
