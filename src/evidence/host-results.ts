import { isRecord, validQualifiedId as validEvidenceId } from "../value-guards";
import { canonicalJson } from "../identity";
import type { HostResult } from "../evaluation/types";
import type {
  ObservationCompleteness,
  ObservationEvidence,
} from "../contract-types";

export function hostObservations(
  result: HostResult,
  hostId: string,
  existingIds: Set<string>,
): ObservationEvidence[] {
  const items = result.observations ?? [];
  if (items.length > 128) throw new Error("too many host observations");
  const ids = new Set([...existingIds, "sevro.observation.final-message"]);
  let totalBytes = 0;
  return items.map((value: unknown) => {
    const item = validatedHostObservation(value, ids);
    ids.add(item.id);
    const data = canonicalJson(item.data);
    totalBytes += Buffer.byteLength(data, "utf8");
    if (totalBytes > 8 * 1024 * 1024)
      throw new Error("host observations exceed 8 MiB");
    return {
      id: item.id,
      source: hostId,
      completeness: item.completeness,
      data: JSON.parse(data) as Record<string, unknown>,
    };
  });
}

export function hostArtifacts(result: HostResult, existingIds: Set<string>) {
  const items = result.artifacts ?? [];
  if (!Array.isArray(items) || items.length > 32)
    throw new Error("too many host artifacts");
  const ids = new Set(existingIds);
  let totalBytes = 0;
  return items.map((value: unknown) => {
    const item = validatedHostArtifact(value, ids);
    ids.add(item.id);
    totalBytes += item.bytes.byteLength;
    if (
      item.bytes.byteLength > 8 * 1024 * 1024 ||
      totalBytes > 32 * 1024 * 1024
    )
      throw new Error("host artifacts exceed the size limit");
    return { id: item.id, bytes: Buffer.from(item.bytes) };
  });
}

function validObservationId(value: unknown, ids: Set<string>): value is string {
  return (
    validEvidenceId(value) &&
    !value.startsWith("sevro.observation.") &&
    !ids.has(value)
  );
}

function validCompleteness(value: unknown): value is ObservationCompleteness {
  return value === "complete" || value === "partial" || value === "unavailable";
}

function validatedHostObservation(value: unknown, ids: Set<string>) {
  if (!isRecord(value)) throw new Error("invalid host observation");
  if (
    !validObservationId(value.id, ids) ||
    !validCompleteness(value.completeness) ||
    !isRecord(value.data)
  )
    throw new Error("invalid host observation");
  return { id: value.id, completeness: value.completeness, data: value.data };
}

function validArtifactId(value: unknown, ids: Set<string>): value is string {
  return validEvidenceId(value) && !ids.has(value);
}

function validatedHostArtifact(value: unknown, ids: Set<string>) {
  if (!isRecord(value)) throw new Error("invalid host artifact");
  if (!validArtifactId(value.id, ids) || !(value.bytes instanceof Uint8Array))
    throw new Error("invalid host artifact");
  return { id: value.id, bytes: value.bytes };
}
