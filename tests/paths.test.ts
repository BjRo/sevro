import { expect, test } from "bun:test";
import fc from "fast-check";
import { join, resolve, sep } from "node:path";
import { insideRoot, minimalRoots } from "../src/paths";

test.each([
  ["/safe", "/safe", true],
  ["/safe", "/safe/child", true],
  ["/safe", "/safe/../safe/child", true],
  ["/safe", "/safe/..hidden", true],
  ["/safe", "/safe/..", false],
  ["/safe", "/safe/../secret", false],
  ["/safe", "/safe-sibling/child", false],
  ["/safe/child", "/safe", false],
  ["/", "/safe/child", true],
] as const)("containment of %s and %s is %s", (root, path, contained) => {
  expect(insideRoot(root, path)).toBe(contained);
});

test("root minimisation removes duplicates and descendants in stable input order", () => {
  const roots = ["/safe/child", "/other", "/safe", "/safe", "/safe-sibling"];
  expect(minimalRoots(roots)).toEqual(["/other", "/safe", "/safe-sibling"]);
  expect(roots).toHaveLength(5);
  expect(minimalRoots(["/safe/", "/safe/child", "/safe/."])).toEqual([
    "/safe/",
  ]);
  expect(minimalRoots(["/safe", "/", "/other", "/"])).toEqual(["/"]);
  expect(minimalRoots([])).toEqual([]);
});

test("minimisation preserves every grant and is idempotent for generated root sets", () => {
  const root = resolve(sep, "safe");
  const path = fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 4 });
  fc.assert(
    fc.property(fc.array(path, { maxLength: 16 }), (parts) => {
      const roots = parts.map((parts) => join(root, ...parts));
      const selected = minimalRoots(roots);
      expect(minimalRoots(selected)).toEqual(selected);
      expect(
        roots.every((path) => selected.some((root) => insideRoot(root, path))),
      ).toBe(true);
      expect(insideRoot(root, `${root}-sibling`)).toBe(false);
    }),
    { seed: 20261007, numRuns: 200, endOnFailure: true },
  );
});
