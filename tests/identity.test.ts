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
