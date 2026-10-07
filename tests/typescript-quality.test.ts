import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

test("the public TypeScript gate copies exact candidate inputs and deletions with independent Git", () => {
  const child = Bun.spawnSync(
    [process.execPath, "run", "check:typescript", "--probe", "snapshot"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toContain(
    "candidate-snapshot: exact inputs, deletions and independent Git preserved",
  );
}, 30000);

test("the public TypeScript gate rejects missed branches independently", () => {
  const child = Bun.spawnSync(
    [process.execPath, "run", "check:typescript", "--probe", "branch"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain("Below 95%: branches");
  expect(child.stdout.toString()).toContain('"covered":5,"total":5');
});

test.each(["stray.ts", "stray.tsx", "stray.mts", "stray.cts"])(
  "the public TypeScript gate refuses unregistered source file %s",
  (filename) => {
    const root = mkdtempSync(resolve(tmpdir(), "sevro-inventory-"));
    try {
      writeFileSync(resolve(root, filename), "export const value = 1;\n");
      writeFileSync(
        resolve(root, "typescript-sources.json"),
        '{"production":[],"tooling":[],"tests":[],"examples":[],"declarations":[],"generated":[]}',
      );
      const child = Bun.spawnSync(
        [process.execPath, "run", "check:typescript", "--inventory", root],
        { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
      );
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toContain(
        `Unregistered source: ${filename}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("the public TypeScript gate refuses absent process reports", () => {
  const child = Bun.spawnSync(
    [process.execPath, "run", "check:typescript", "--probe", "missing-reports"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain("Missing coverage reports");
});

test("the public TypeScript gate validates process completion and report integrity", () => {
  const child = Bun.spawnSync(
    [process.execPath, "run", "check:typescript", "--probe", "integrity"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  expect(child.stdout.toString()).toContain(
    "unimported-production: zero-counted",
  );
  expect(child.stdout.toString()).toContain("missing-child: refused");
  expect(child.stdout.toString()).toContain("missing-branch-data: refused");
  expect(child.stdout.toString()).toContain("stale-report: refused");
  expect(child.stdout.toString()).toContain("incompatible-report: refused");
  expect(child.stdout.toString()).toContain("normal-checkpoint: refused");
  expect(child.stdout.toString()).toContain("unowned-force-kill: refused");
  expect(child.stdout.toString()).toContain("owned-force-kill: conservative");
  expect(child.exitCode).toBe(0);
});

test("the public TypeScript gate preserves original TypeScript counter and stack locations", () => {
  const child = Bun.spawnSync(
    [process.execPath, "run", "check:typescript", "--probe", "source-map"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  expect(child.stdout.toString()).toContain("original-typescript:6");
  expect(child.exitCode).toBe(0);
});

test("the public TypeScript gate refuses stale or observed compiler-counter exemptions", () => {
  const child = Bun.spawnSync(
    [process.execPath, "run", "check:typescript", "--probe", "exemptions"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  expect(child.stdout.toString()).toContain("compiler-guard-proof:677");
  expect(child.stdout.toString()).toContain("compiler-outcome-proof:703");
  expect(child.stdout.toString()).toContain("compiler-statement-proof:194");
  expect(child.stdout.toString()).toContain("stale-proof: refused");
  expect(child.stdout.toString()).toContain("observed-exempt-outcome: refused");
  expect(child.stdout.toString()).toContain(
    "observed-exempt-statement: refused",
  );
  expect(child.stdout.toString()).toContain("missing-derived-proof: refused");
  expect(child.exitCode).toBe(0);
});

test("the public TypeScript gate audits all stored reports before choosing completion", () => {
  const child = Bun.spawnSync(
    [process.execPath, "run", "check:typescript", "--probe", "integrity"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  expect(child.stdout.toString()).toContain("unregistered-completion: refused");
  expect(child.stdout.toString()).toContain(
    "stale-discarded-checkpoint: refused",
  );
  expect(child.stdout.toString()).toContain("misnamed-completion: refused");
  expect(child.stdout.toString()).toContain("unexpected-report-file: refused");
  expect(child.exitCode).toBe(0);
});

test("the public TypeScript gate proves only conservative compiler-local flow", () => {
  const child = Bun.spawnSync(
    [process.execPath, "run", "check:typescript", "--probe", "compiler-flow"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  for (const label of [
    "literal-array-length",
    "constant-local",
    "identical-join",
    "terminated-arm",
    "zero-counter-truth",
    "increment-counter",
    "local-array-binding",
    "null-join",
    "array-mutation",
  ])
    expect(child.stdout.toString()).toContain(`${label}: proved`);
  for (const label of [
    "infinite-literal-negation",
    "overflow-literal-negation",
    "fractional-counter",
    "helper-error-property",
    "array-method-result",
    "conditional-counter-initialization",
    "copy-before-initialization",
    "assignment",
    "different-join",
    "loop-write",
    "shadowing",
    "captured-local",
    "unsupported-syntax",
    "destructuring-write",
    "malformed-syntax",
    "labeled-block",
    "short-circuit-primitive",
    "global-counter-binding",
    "foreign-counter-value",
    "nan-counter",
    "negative-counter",
    "infinite-counter",
    "counter-overflow",
    "negative-decrement",
    "array-reassignment",
    "different-null-join",
    "nonnull-truthiness",
  ])
    expect(child.stdout.toString()).toContain(`${label}: declined`);
  expect(child.exitCode).toBe(0);
});
