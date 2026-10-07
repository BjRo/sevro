import { test, expect } from "bun:test";
import {
  canonicalJson,
  createEvaluationIdentity,
  hashJson,
} from "../src/identity";
const digest = "a".repeat(64);
const dimensions = {
  runnerBuildDigest: digest,
  projectDigest: digest,
  configurationDigest: digest,
  extensionDigest: null,
  extensionProtocol: null,
  caseDigest: digest,
  fixtureDigest: digest,
  checksDigest: digest,
  requiredEvidenceDigest: digest,
  evaluatorDigest: digest,
  graderDigest: digest,
  instrumentationDigest: digest,
  routeDigest: digest,
  condition: "passive" as const,
  trialCount: 2,
  passThreshold: 0.5,
};
test("canonical JSON is stable across object insertion order", () => {
  expect(canonicalJson({ b: [2, { z: true, a: "é" }], a: 1 })).toBe(
    '{"a":1,"b":[2,{"a":"é","z":true}]}',
  );
  expect(hashJson({ b: 2, a: 1 })).toBe(hashJson({ a: 1, b: 2 }));
  expect(hashJson({ a: [1, 2] })).not.toBe(hashJson({ a: [2, 1] }));
});
function changedDimension(key: keyof typeof dimensions) {
  const variants: Partial<Record<keyof typeof dimensions, unknown>> = {
    condition: "enforced",
    trialCount: 3,
    passThreshold: 0.75,
  };
  return variants[key] ?? digest.replace(/^a/, "b");
}
test("identity changes with each comparison-critical dimension", () => {
  const baseline = createEvaluationIdentity(dimensions);
  expect(baseline.algorithm).toBe("sevro.identity.v1");
  expect(baseline.digest).toMatch(/^[a-f0-9]{64}$/);
  for (const key of Object.keys(dimensions) as (keyof typeof dimensions)[]) {
    if (key === "extensionDigest" || key === "extensionProtocol") continue;
    const changed = {
      ...dimensions,
      [key]: changedDimension(key),
    };
    expect(createEvaluationIdentity(changed).digest).not.toBe(baseline.digest);
  }
  expect(
    createEvaluationIdentity({
      ...dimensions,
      extensionDigest: digest,
      extensionProtocol: "sevro.extension.v1",
    }).digest,
  ).not.toBe(baseline.digest);
});
test("identity rejects missing dimensions and non-JSON values", () => {
  const incomplete = { ...dimensions } as Record<string, unknown>;
  delete incomplete.configurationDigest;
  expect(() => createEvaluationIdentity(incomplete)).toThrow(
    /configurationDigest/,
  );
  expect(() => canonicalJson({ value: Number.NaN })).toThrow(/finite/);
  expect(() => canonicalJson({ value: undefined })).toThrow(/JSON/);
  expect(() => canonicalJson("\ud800")).toThrow(/surrogate/);
});

const invalidIdentityDocuments = [
  {
    name: "null dimensions",
    value: null,
    diagnostic: "identity dimensions must be a JSON object",
  },
  {
    name: "array dimensions",
    value: [],
    diagnostic: "identity dimensions must be a JSON object",
  },
  {
    name: "scalar dimensions",
    value: 42,
    diagnostic: "identity dimensions must be a JSON object",
  },
  {
    name: "an undeclared dimension",
    value: { ...dimensions, extra: true },
    diagnostic: "unexpected identity dimension: extra",
  },
  {
    name: "an uppercase digest",
    value: { ...dimensions, configurationDigest: "A".repeat(64) },
    diagnostic: "invalid identity dimension: configurationDigest",
  },
  {
    name: "a short digest",
    value: { ...dimensions, runnerBuildDigest: "a".repeat(63) },
    diagnostic: "invalid identity dimension: runnerBuildDigest",
  },
  {
    name: "extension content without a protocol",
    value: { ...dimensions, extensionDigest: digest },
    diagnostic: "extension identity requires its matching protocol",
  },
  {
    name: "an extension protocol without content",
    value: { ...dimensions, extensionProtocol: "sevro.extension.v1" },
    diagnostic: "extension identity requires its matching protocol",
  },
  {
    name: "an incompatible extension protocol",
    value: {
      ...dimensions,
      extensionDigest: digest,
      extensionProtocol: "sevro.extension.v2",
    },
    diagnostic: "extension identity requires its matching protocol",
  },
  {
    name: "an undeclared condition",
    value: { ...dimensions, condition: "unknown" },
    diagnostic: "invalid identity condition",
  },
  {
    name: "zero trials",
    value: { ...dimensions, trialCount: 0 },
    diagnostic: "invalid identity trial count",
  },
  {
    name: "fractional trials",
    value: { ...dimensions, trialCount: 1.5 },
    diagnostic: "invalid identity trial count",
  },
  {
    name: "an unsafe trial integer",
    value: { ...dimensions, trialCount: Number.MAX_SAFE_INTEGER + 1 },
    diagnostic: "invalid identity trial count",
  },
  {
    name: "a zero threshold",
    value: { ...dimensions, passThreshold: 0 },
    diagnostic: "invalid identity pass threshold",
  },
  {
    name: "a threshold above one",
    value: { ...dimensions, passThreshold: 1.01 },
    diagnostic: "invalid identity pass threshold",
  },
];

for (const invalid of invalidIdentityDocuments) {
  test(`identity refuses serialized comparison inputs with ${invalid.name}`, () => {
    const parsed: unknown = JSON.parse(JSON.stringify(invalid.value));
    expect(() => createEvaluationIdentity(parsed)).toThrow(invalid.diagnostic);
  });
}

test("canonical identity JSON accepts paired supplementary Unicode and refuses a lone low surrogate", () => {
  const valid: unknown = JSON.parse('"😀\\ue000"');
  expect(canonicalJson(valid)).toBe('"😀\ue000"');
  const invalid: unknown = JSON.parse('"\\udc00"');
  expect(() => canonicalJson(invalid)).toThrow(
    "JSON string contains an unpaired surrogate",
  );
});
