/** @param {unknown} value @returns {Record<string, unknown>} */
export function object(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a coverage object");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @returns {value is string[]} */
function strings(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** @param {unknown} value @returns {value is number} */
export function counter(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** @param {unknown} value @returns {import('./types').CoverageParticipant} */
export function participant(value) {
  const entry = object(value);
  return { ...runIdentity(entry), ...processIdentity(entry) };
}

/** @param {Record<string, unknown>} entry */
function runIdentity(entry) {
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

/** @param {Record<string, unknown>} entry */
function processIdentity(entry) {
  const { pid, ppid, argv } = entry;
  if (!counter(pid) || !counter(ppid) || pid === 0 || !strings(argv)) {
    throw new Error("Invalid coverage process identity");
  }
  return { pid, ppid, argv };
}

/** @param {unknown} value @param {string[]} keys */
function countersObject(value, keys) {
  const entry = object(value);
  const actual = Object.keys(entry).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) {
    throw new Error("Incomplete coverage counters");
  }
  return entry;
}

/** @param {unknown} value @param {string[]} keys */
export function numbers(value, keys) {
  const entry = countersObject(value, keys);
  /** @type {Record<string, number>} */
  const result = {};
  for (const [id, count] of Object.entries(entry)) {
    if (!counter(count)) throw new Error(`Invalid coverage counter: ${id}`);
    result[id] = count;
  }
  return result;
}

/** @param {unknown} value @param {number} length */
function branch(value, length) {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every(counter)
  ) {
    throw new Error("Invalid branch counter");
  }
  return /** @type {number[]} */ (value);
}

/** @param {unknown} value @param {Record<string, number[]>} expected */
export function branches(value, expected) {
  const entry = countersObject(value, Object.keys(expected));
  /** @type {Record<string, number[]>} */
  const result = {};
  for (const [id, counts] of Object.entries(expected)) {
    result[id] = branch(entry[id], counts.length);
  }
  return result;
}
