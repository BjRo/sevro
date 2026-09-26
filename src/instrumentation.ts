import { canonicalJson } from "./identity";

export interface InstrumentationRequest {
  id: string;
  configuration: Record<string, unknown>;
}

export interface InstrumentationCapability {
  id: string;
  executionChanging: boolean;
}

export class InstrumentationEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstrumentationEvidenceError";
  }
}

const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;

function validRequest(value: InstrumentationRequest): boolean {
  return (
    Boolean(value && ID.test(value.id)) &&
    Boolean(
      value.configuration &&
      typeof value.configuration === "object" &&
      !Array.isArray(value.configuration),
    )
  );
}

/** Validate an extension's request before the candidate host starts. */
export function prepareInstrumentation(
  requested: InstrumentationRequest[],
  supported: InstrumentationCapability[],
  negotiated: string[],
  condition: "passive" | "enforced",
): InstrumentationRequest[] {
  const supportedIds = new Set(supported.map((item) => item.id));
  if (
    supported.some(
      (item) =>
        !ID.test(item.id) || typeof item.executionChanging !== "boolean",
    ) ||
    supportedIds.size !== supported.length
  )
    throw new Error("host instrumentation capabilities are invalid");
  const requestedIds = new Set(requested.map((item) => item.id));
  if (
    requested.some((item) => !validRequest(item)) ||
    requestedIds.size !== requested.length
  )
    throw new Error("requested instrumentation is invalid or duplicated");
  for (const item of requested) {
    const capability = supported.find((entry) => entry.id === item.id);
    if (!capability || !negotiated.includes(item.id))
      throw new Error(
        "extension preparation requested unsupported instrumentation",
      );
    if (condition === "passive" && capability.executionChanging)
      throw new Error(
        "passive condition cannot apply execution-changing instrumentation",
      );
  }
  canonicalJson(requested);
  return requested;
}

/** A host must report exactly the instrumentation it applied. */
export function verifyAppliedInstrumentation(
  requested: InstrumentationRequest[],
  applied: InstrumentationRequest[] | undefined,
  requestedCondition: "passive" | "enforced",
  actualCondition: "passive" | "enforced" | "unknown" | undefined,
): InstrumentationRequest[] {
  const actual = applied ?? [];
  if (
    !Array.isArray(actual) ||
    actual.some((item) => !validRequest(item)) ||
    new Set(actual.map((item) => item.id)).size !== actual.length ||
    canonicalJson(actual) !== canonicalJson(requested)
  )
    throw new InstrumentationEvidenceError(
      "host applied instrumentation does not match the request",
    );
  if (
    actualCondition !== undefined &&
    actualCondition !== "unknown" &&
    actualCondition !== "passive" &&
    actualCondition !== "enforced"
  )
    throw new InstrumentationEvidenceError(
      "host condition evidence is invalid",
    );
  if (
    (actualCondition !== undefined &&
      actualCondition !== "unknown" &&
      actualCondition !== requestedCondition) ||
    (requested.length > 0 && actualCondition !== requestedCondition)
  )
    throw new InstrumentationEvidenceError(
      "host did not confirm the requested condition",
    );
  return actual;
}
