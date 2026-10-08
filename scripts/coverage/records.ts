import type { CoverageParticipant } from "./types";
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a coverage object");
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function participant(value: unknown): CoverageParticipant {
  const entry = object(value);
  return { ...runIdentity(entry), ...processIdentity(entry) };
}

function runIdentity(entry: Record<string, unknown>) {
  const { version, runId, layout } = entry;
  if (
    version !== 1 ||
    typeof runId !== "string" ||
    typeof layout !== "string"
  ) {
    throw new Error("Invalid coverage run identity");
  }
  return { version, runId, layout };
}

function processIdentity(entry: Record<string, unknown>) {
  const { pid, ppid, argv } = entry;
  if (!counter(pid) || !counter(ppid) || pid === 0 || !strings(argv)) {
    throw new Error("Invalid coverage process identity");
  }
  return { pid, ppid, argv };
}

function countersObject(value: unknown, keys: string[]) {
  const entry = object(value);
  const actual = Object.keys(entry).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) {
    throw new Error("Incomplete coverage counters");
  }
  return entry;
}

export function numbers(value: unknown, keys: string[]) {
  const entry = countersObject(value, keys);

  const result: Record<string, number> = {};
  for (const [id, count] of Object.entries(entry)) {
    if (!counter(count)) throw new Error(`Invalid coverage counter: ${id}`);
    result[id] = count;
  }
  return result;
}

function branch(value: unknown, length: number) {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every(counter)
  ) {
    throw new Error("Invalid branch counter");
  }
  return value;
}

export function branches(value: unknown, expected: Record<string, number[]>) {
  const entry = countersObject(value, Object.keys(expected));

  const result: Record<string, number[]> = {};
  for (const [id, counts] of Object.entries(expected)) {
    result[id] = branch(entry[id], counts.length);
  }
  return result;
}
