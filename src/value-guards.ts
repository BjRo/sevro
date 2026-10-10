/** Narrow JSON containers before accessing untrusted members. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return (
    isUnknownArray(value) && value.every((item) => typeof item === "string")
  );
}

export function isOptionalNonblankString(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "string" && Boolean(value.trim()))
  );
}
