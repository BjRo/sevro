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

function assertUnicode(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error("JSON string contains an unpaired surrogate");
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("JSON string contains an unpaired surrogate");
    }
  }
}

/** RFC 8785 JSON canonicalization for ordinary JSON values. */
export function canonicalJson(value: unknown): string {
  const visiting = new WeakSet<object>();
  function write(item: unknown): string {
    if (item === null) return "null";
    if (typeof item === "string") {
      assertUnicode(item);
      return JSON.stringify(item);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("JSON number must be finite");
      return JSON.stringify(item);
    }
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item !== "object") throw new Error("value is not JSON data");
    if (visiting.has(item)) throw new Error("JSON value contains a cycle");
    visiting.add(item);
    try {
      if (Array.isArray(item)) return `[${item.map(write).join(",")}]`;
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error("value is not a plain JSON object");
      if (Object.getOwnPropertySymbols(item).length)
        throw new Error("JSON object has symbol keys");
      const record = item as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map((key) => {
          assertUnicode(key);
          const descriptor = Object.getOwnPropertyDescriptor(record, key);
          if (!descriptor || !Object.hasOwn(descriptor, "value"))
            throw new Error("JSON object has an accessor property");
          return `${JSON.stringify(key)}:${write(descriptor.value)}`;
        });
      return `{${entries.join(",")}}`;
    } finally {
      visiting.delete(item);
    }
  }
  return write(value);
}

export function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function validatedDimensions(value: unknown): IdentityDimensions {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("identity dimensions must be a JSON object");
  const record = value as Record<string, unknown>;
  for (const key of DIMENSION_KEYS)
    if (!Object.hasOwn(record, key))
      throw new Error(`missing identity dimension: ${key}`);
  const unexpected = Object.keys(record).filter(
    (key) => !DIMENSION_KEYS.includes(key as (typeof DIMENSION_KEYS)[number]),
  );
  if (unexpected.length)
    throw new Error(`unexpected identity dimension: ${unexpected[0]}`);
  for (const key of DIMENSION_KEYS.filter((name) => name.endsWith("Digest"))) {
    if (key === "extensionDigest" && record[key] === null) continue;
    if (typeof record[key] !== "string" || !DIGEST.test(record[key]))
      throw new Error(`invalid identity dimension: ${key}`);
  }
  if (
    (record.extensionDigest === null) !== (record.extensionProtocol === null) ||
    (record.extensionProtocol !== null &&
      record.extensionProtocol !== "sevro.extension.v1")
  )
    throw new Error("extension identity requires its matching protocol");
  if (record.condition !== "passive" && record.condition !== "enforced")
    throw new Error("invalid identity condition");
  if (
    !Number.isSafeInteger(record.trialCount) ||
    (record.trialCount as number) < 1
  )
    throw new Error("invalid identity trial count");
  if (
    typeof record.passThreshold !== "number" ||
    !Number.isFinite(record.passThreshold) ||
    record.passThreshold <= 0 ||
    record.passThreshold > 1
  )
    throw new Error("invalid identity pass threshold");
  return record as unknown as IdentityDimensions;
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
