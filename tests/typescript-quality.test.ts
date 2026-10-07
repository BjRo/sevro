import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isRecord, isStringArray } from "../src/value-guards";
import { copySnapshot } from "../scripts/coverage/prepare.mjs";

function qualityInventory(root: string) {
  const value: unknown = JSON.parse(
    readFileSync(resolve(root, "typescript-sources.json"), "utf8"),
  );
  if (
    !isRecord(value) ||
    !isStringArray(value.production) ||
    !isStringArray(value.generated)
  )
    throw new Error("Expected complete source inventory");
  return { ...value, production: value.production, generated: value.generated };
}

function mutateCoverageCandidate(project: string, kind: string) {
  const inventory = qualityInventory(project);
  switch (kind) {
    case "missing source":
      rmSync(resolve(project, "src/value-guards.ts"));
      break;
    case "overlapping dispositions":
      inventory.generated.push("src/value-guards.ts");
      break;
    case "misclassified CJS":
      writeFileSync(
        resolve(project, "src/coverage-control.cjs"),
        "const value = 1;\n",
      );
      inventory.generated.push("src/coverage-control.cjs");
      break;
    default: {
      const extension = kind === "unregistered TypeScript" ? "ts" : "cjs";
      writeFileSync(
        resolve(project, `src/coverage-control.${extension}`),
        "const value = 1;\n",
      );
    }
  }
  writeFileSync(
    resolve(project, "typescript-sources.json"),
    JSON.stringify(inventory),
  );
}

function scopeResult(output: string) {
  const value: unknown = JSON.parse(output);
  if (!isRecord(value) || typeof value.root !== "string")
    throw new Error("Expected scope probe result");
  return { root: value.root, generatedCjs: value.generatedCjs };
}

function scopeFiles(repo: string, file: string) {
  const report: unknown = JSON.parse(
    readFileSync(resolve(repo, ".quality/coverage-scope", file), "utf8"),
  );
  if (!isRecord(report)) throw new Error("Expected scope coverage report");
  return Object.keys(report)
    .map((path) => path.slice(path.lastIndexOf("/src/") + 1))
    .sort();
}

test.each([
  ["unregistered CJS", "Unregistered source: src/coverage-control.cjs"],
  ["unregistered TypeScript", "Unregistered source: src/coverage-control.ts"],
  ["missing source", "Missing inventoried source: src/value-guards.ts"],
  ["overlapping dispositions", "Duplicate source inventory entry"],
  [
    "misclassified CJS",
    "Invalid generated source disposition: src/coverage-control.cjs",
  ],
])(
  "direct public coverage refuses %s",
  (kind, diagnostic) => {
    const root = mkdtempSync(resolve(tmpdir(), "sevro-coverage-inventory-"));
    try {
      const { project } = copySnapshot(resolve(import.meta.dir, ".."), root);
      mutateCoverageCandidate(project, kind);
      const child = Bun.spawnSync(
        [
          process.execPath,
          resolve(project, "scripts/check-typescript.mjs"),
          "--coverage",
          "tests/schema.test.ts",
        ],
        { cwd: project, stdout: "pipe", stderr: "pipe" },
      );
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toContain(diagnostic);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);

test("the public TypeScript gate covers every authored production file and excludes exactly generated validators", () => {
  const repo = resolve(import.meta.dir, "..");
  const child = Bun.spawnSync(
    [process.execPath, "run", "check:typescript", "--probe", "scope"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const observed = scopeResult(child.stdout.toString());
  expect(observed.generatedCjs).toBe("validated");
  const inventory = qualityInventory(repo);
  for (const file of ["baseline.json", "coverage-final.json"]) {
    const files = scopeFiles(repo, file);
    expect(files).toEqual([...inventory.production].sort());
    for (const generated of inventory.generated)
      expect(files).not.toContain(generated);
  }
  for (const generated of inventory.generated)
    expect(
      readFileSync(resolve(observed.root, "run/project", generated), "utf8"),
    ).toBe(readFileSync(resolve(repo, generated), "utf8"));
}, 30000);

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
