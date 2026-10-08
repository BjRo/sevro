import { isRecord, isUnknownArray } from "./value-guards";
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

function validInstrumentationId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function validRequest(value: unknown): value is InstrumentationRequest {
  return (
    isRecord(value) &&
    validInstrumentationId(value.id) &&
    isRecord(value.configuration)
  );
}

function validateSupportedInstrumentation(
  supported: InstrumentationCapability[],
): void {
  const ids = new Set(supported.map((item) => item.id));
  if (
    supported.some(
      (item) =>
        !ID.test(item.id) || typeof item.executionChanging !== "boolean",
    ) ||
    ids.size !== supported.length
  )
    throw new Error("host instrumentation capabilities are invalid");
}

function validateRequestedInstrumentation(
  requested: InstrumentationRequest[],
): void {
  const ids = new Set(requested.map((item) => item.id));
  if (
    requested.some((item) => !validRequest(item)) ||
    ids.size !== requested.length
  )
    throw new Error("requested instrumentation is invalid or duplicated");
}

function requestedCapability(
  item: InstrumentationRequest,
  supported: InstrumentationCapability[],
  negotiated: string[],
): InstrumentationCapability {
  const capability = supported.find((entry) => entry.id === item.id);
  if (!capability || !negotiated.includes(item.id))
    throw new Error(
      "extension preparation requested unsupported instrumentation",
    );
  return capability;
}

function validateInstrumentationCondition(
  capability: InstrumentationCapability,
  condition: "passive" | "enforced",
): void {
  if (condition === "passive" && capability.executionChanging)
    throw new Error(
      "passive condition cannot apply execution-changing instrumentation",
    );
}

/** Validate an extension's request before the candidate host starts. */
export function prepareInstrumentation(
  requested: InstrumentationRequest[],
  supported: InstrumentationCapability[],
  negotiated: string[],
  condition: "passive" | "enforced",
): InstrumentationRequest[] {
  validateSupportedInstrumentation(supported);
  validateRequestedInstrumentation(requested);
  for (const item of requested)
    validateInstrumentationCondition(
      requestedCapability(item, supported, negotiated),
      condition,
    );
  return snapshotInstrumentation(requested);
}

/** Own the canonical JSON parameters independently of adapter state. */
export function snapshotInstrumentation(
  requested: InstrumentationRequest[],
): InstrumentationRequest[] {
  return JSON.parse(canonicalJson(requested)) as InstrumentationRequest[];
}

/** A host must report exactly the instrumentation it applied. */
export function verifyAppliedInstrumentation(
  requested: InstrumentationRequest[],
  applied: InstrumentationRequest[] | undefined,
  requestedCondition: "passive" | "enforced",
  actualCondition: "passive" | "enforced" | "unknown" | undefined,
): InstrumentationRequest[] {
  const actual = applied ?? [];
  validateAppliedRequests(actual, requested);
  validateActualCondition(actualCondition);
  if (
    mismatchedCondition(actualCondition, requestedCondition) ||
    (requested.length > 0 && actualCondition !== requestedCondition)
  )
    throw new InstrumentationEvidenceError(
      "host did not confirm the requested condition",
    );
  return snapshotInstrumentation(actual);
}

function requestArray(value: unknown): value is InstrumentationRequest[] {
  return isUnknownArray(value) && value.every(validRequest);
}

function validateAppliedRequests(
  actual: unknown,
  requested: InstrumentationRequest[],
): asserts actual is InstrumentationRequest[] {
  if (
    !requestArray(actual) ||
    new Set(actual.map((item) => item.id)).size !== actual.length ||
    canonicalJson(actual) !== canonicalJson(requested)
  )
    throw new InstrumentationEvidenceError(
      "host applied instrumentation does not match the request",
    );
}

function validActualCondition(value: unknown): boolean {
  return (
    value === undefined ||
    value === "unknown" ||
    value === "passive" ||
    value === "enforced"
  );
}

function validateActualCondition(value: unknown): void {
  if (!validActualCondition(value))
    throw new InstrumentationEvidenceError(
      "host condition evidence is invalid",
    );
}

function mismatchedCondition(
  actual: string | undefined,
  requested: string,
): boolean {
  if (actual === undefined || actual === "unknown") return false;
  return actual !== requested;
}
