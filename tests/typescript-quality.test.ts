import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isRecord, isStringArray } from "../src/value-guards";
import { copySnapshot } from "../scripts/coverage/prepare";
import { platformCoverageScope } from "../scripts/coverage/platform-scope";
import { platformBranchCoverage } from "../scripts/coverage/platform-branches";
import { createInstrumenter } from "istanbul-lib-instrument";
import { createCoverageMap, type CoverageMapData } from "istanbul-lib-coverage";

test("release CI evidence controls require complete fresh phases and test shards", () => {
  const child = Bun.spawnSync(
    ["python3", ".github/scripts/test-release-ci.py"],
    {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stderr.toString()).toContain("OK");
});

test.each([
  { args: ["--phase"] },
  { args: ["--phase", "unknown"] },
  { args: ["--phase", "static", "extra"] },
])(
  "the public TypeScript gate refuses invalid phase selection %j",
  ({ args }) => {
    const child = Bun.spawnSync(
      [process.execPath, "run", "check:typescript", ...args],
      { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toContain(
      "--phase static|docs|tests|package",
    );
    expect(child.stdout.toString()).not.toContain("TypeScript quality:");
  },
);

function qualityInventory(root: string) {
  const value: unknown = JSON.parse(
    readFileSync(resolve(root, "typescript-sources.json"), "utf8"),
  );
  if (
    !isRecord(value) ||
    !isStringArray(value.production) ||
    !isStringArray(value.generated) ||
    !isStringArray(value.thirdParty)
  )
    throw new Error("Expected complete source inventory");
  return {
    ...value,
    production: value.production,
    generated: value.generated,
    thirdParty: value.thirdParty,
  };
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
          resolve(project, "scripts/check-typescript.ts"),
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

test("the public TypeScript inventory accepts the exact fresh upstream schema bundle", () => {
  const root = mkdtempSync(resolve(tmpdir(), "sevro-schema-inventory-"));
  try {
    const { project } = copySnapshot(resolve(import.meta.dir, ".."), root);
    writeFileSync(
      resolve(project, "typescript-sources.json"),
      JSON.stringify({
        ...qualityInventory(project),
        thirdParty: ["crates/sevro/assets/schema/ajv-8.20.0.bundle.js"],
      }),
    );
    const child = Bun.spawnSync(
      [
        process.execPath,
        resolve(project, "scripts/check-typescript.ts"),
        "--inventory",
        project,
      ],
      { cwd: project, stdout: "pipe", stderr: "pipe" },
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString()) as unknown).toMatchObject({
      thirdParty: ["crates/sevro/assets/schema/ajv-8.20.0.bundle.js"],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

function schemaInventoryRefusal(mutate: (project: string) => void) {
  const root = mkdtempSync(resolve(tmpdir(), "sevro-schema-inventory-"));
  try {
    const { project } = copySnapshot(resolve(import.meta.dir, ".."), root);
    mutate(project);
    return Bun.spawnSync(
      [
        process.execPath,
        resolve(project, "scripts/check-typescript.ts"),
        "--inventory",
        project,
      ],
      { cwd: project, stdout: "pipe", stderr: "pipe" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the public TypeScript inventory refuses authored code classified as upstream", () => {
  const child = schemaInventoryRefusal((project) => {
    const inventory = qualityInventory(project);
    inventory.production = inventory.production.filter(
      (path) => path !== "src/value-guards.ts",
    );
    inventory.thirdParty.push("src/value-guards.ts");
    writeFileSync(
      resolve(project, "typescript-sources.json"),
      JSON.stringify(inventory),
    );
  });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain(
    "Invalid thirdParty source disposition: src/value-guards.ts",
  );
}, 30000);

test("the public TypeScript inventory refuses a missing schema manifest", () => {
  const child = schemaInventoryRefusal((project) => {
    rmSync(resolve(project, "crates/sevro/assets/schema/manifest.json"));
  });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain(
    "Stale schema runtime manifest.json",
  );
}, 30000);

test("the public TypeScript inventory refuses a missing upstream schema bundle", () => {
  const child = schemaInventoryRefusal((project) => {
    rmSync(resolve(project, "crates/sevro/assets/schema/ajv-8.20.0.bundle.js"));
  });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain(
    "Missing inventoried source: crates/sevro/assets/schema/ajv-8.20.0.bundle.js",
  );
}, 30000);

test("the public TypeScript inventory refuses authored bundle changes with a matching claimed hash", () => {
  const child = schemaInventoryRefusal((project) => {
    const bundlePath = resolve(
      project,
      "crates/sevro/assets/schema/ajv-8.20.0.bundle.js",
    );
    const content =
      readFileSync(bundlePath, "utf8") +
      "\nglobalThis.authoredGrader = () => true;\n";
    writeFileSync(bundlePath, content);
    const manifestPath = resolve(
      project,
      "crates/sevro/assets/schema/manifest.json",
    );
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!isRecord(manifest) || !isRecord(manifest.bundle))
      throw new Error("Expected schema manifest");
    manifest.bundle.sha256 = createHash("sha256").update(content).digest("hex");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain(
    "Stale schema runtime ajv-8.20.0.bundle.js",
  );
}, 30000);

test("the public TypeScript inventory refuses stale upstream input provenance", () => {
  const child = schemaInventoryRefusal((project) => {
    const manifestPath = resolve(
      project,
      "crates/sevro/assets/schema/manifest.json",
    );
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!isRecord(manifest)) throw new Error("Expected schema manifest");
    manifest.inputs = [];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain(
    "Stale schema runtime manifest.json",
  );
}, 30000);

test("the public TypeScript inventory refuses another upstream asset path", () => {
  const child = schemaInventoryRefusal((project) => {
    const path = "crates/sevro/assets/schema/other.bundle.js";
    writeFileSync(resolve(project, path), "globalThis.other = true;\n");
    const inventory = qualityInventory(project);
    inventory.thirdParty.push(path);
    writeFileSync(
      resolve(project, "typescript-sources.json"),
      JSON.stringify(inventory),
    );
  });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain(
    "Invalid thirdParty source disposition: crates/sevro/assets/schema/other.bundle.js",
  );
}, 30000);

test("the public TypeScript inventory refuses unregistered JavaScript beside the upstream asset", () => {
  const child = schemaInventoryRefusal((project) => {
    writeFileSync(
      resolve(project, "crates/sevro/assets/schema/extra.js"),
      "globalThis.extra = true;\n",
    );
  });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain(
    "Unregistered source: crates/sevro/assets/schema/extra.js",
  );
}, 30000);

test("the public TypeScript inventory refuses dropping the required upstream disposition", () => {
  const child = schemaInventoryRefusal((project) => {
    rmSync(resolve(project, "crates/sevro/assets/schema/ajv-8.20.0.bundle.js"));
    const inventory = qualityInventory(project);
    inventory.thirdParty = [];
    writeFileSync(
      resolve(project, "typescript-sources.json"),
      JSON.stringify(inventory),
    );
  });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain(
    "Expected the exact pinned upstream schema bundle",
  );
}, 30000);

test("the public TypeScript gate covers host-reachable production and excludes generated validators", () => {
  const repo = resolve(import.meta.dir, "..");
  const child = Bun.spawnSync(
    [process.execPath, "run", "check:typescript", "--probe", "scope"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const observed = scopeResult(child.stdout.toString());
  expect(observed.generatedCjs).toBe("validated");
  const inventory = qualityInventory(repo);
  const scope = platformCoverageScope(inventory.production);
  for (const file of ["baseline.json", "coverage-final.json"]) {
    const files = scopeFiles(repo, file);
    expect(files).toEqual([...scope.included].sort());
    for (const excluded of scope.excluded)
      expect(files).not.toContain(excluded);
    for (const generated of inventory.generated)
      expect(files).not.toContain(generated);
  }
  const report: unknown = JSON.parse(
    readFileSync(resolve(repo, ".quality/coverage-scope/run.json"), "utf8"),
  );
  expect(report).toMatchObject({ scope });
  for (const generated of inventory.generated)
    expect(
      readFileSync(resolve(observed.root, "run/project", generated), "utf8"),
    ).toBe(readFileSync(resolve(repo, generated), "utf8"));
}, 30000);

test("platform coverage retains reachable outcomes and refuses an executed exclusion", () => {
  const root = mkdtempSync(resolve(tmpdir(), "sevro-platform-branches-"));
  try {
    const path = resolve(root, "guard.ts");
    const source = [
      'if (process.platform === "linux") linux(); else mac();',
      'if (process.platform === "linux" && enabled()) linux();',
      "if (enabled()) any();",
    ].join("\n");
    writeFileSync(path, source);
    const instrumenter = createInstrumenter({ esModules: true });
    instrumenter.instrumentSync(source, path);
    const baseline = { [path]: instrumenter.lastFileCoverage() };
    const raw = createCoverageMap(baseline);
    const mac = platformBranchCoverage(raw, root, "darwin");
    const linux = platformBranchCoverage(raw, root, "linux");
    expect(mac.exclusions.map(({ line, outcome }) => [line, outcome])).toEqual([
      [1, 0],
      [2, 0],
      [2, 1],
    ]);
    expect(
      linux.exclusions.map(({ line, outcome }) => [line, outcome]),
    ).toEqual([[1, 1]]);
    expect(mac.map.getCoverageSummary().branches.total).toBe(
      raw.getCoverageSummary().branches.total - 3,
    );
    const executed = JSON.parse(JSON.stringify(baseline)) as CoverageMapData;
    const first = mac.exclusions[0];
    if (!first) throw new Error("Expected one excluded branch");
    const counts = executed[path]?.b[first.branch];
    if (!counts) throw new Error("Expected the raw branch counters");
    counts[first.outcome] = 1;
    expect(() =>
      platformBranchCoverage(createCoverageMap(executed), root, "darwin"),
    ).toThrow("Platform-unreachable branch was executed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
        '{"production":[],"tooling":[],"tests":[],"examples":[],"declarations":[],"generated":[],"thirdParty":[]}',
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
  expect(child.stdout.toString()).toContain(
    "stored-completion-selection: exact counters",
  );
  expect(child.exitCode).toBe(0);
});
