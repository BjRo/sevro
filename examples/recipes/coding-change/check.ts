import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Addition {
  add: (left: number, right: number) => number;
}
function isAddition(value: unknown): value is Addition {
  return (
    typeof value === "object" &&
    value !== null &&
    "add" in value &&
    typeof value.add === "function"
  );
}
const candidate: unknown = await import(
  pathToFileURL(join(process.cwd(), "math.cjs")).href
);
assert.ok(isAddition(candidate), "Candidate must export add");
assert.equal(candidate.add(2, 3), 5);
assert.equal(candidate.add(-2, 3), 1);
assert.equal(candidate.add(0, 0), 0);
console.log("coding checks passed");
