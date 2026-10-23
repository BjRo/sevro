/** Narrow JSON containers before accessing untrusted members. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

export function validQualifiedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(value)
  );
}

export function containsControl(value: string): boolean {
  return Array.from(value).some(
    (character) =>
      character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
  );
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
