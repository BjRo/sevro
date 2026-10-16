import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { copySnapshot } from "../../scripts/coverage/prepare";
import { sourceInventory } from "../../scripts/typescript-inventory";
import { aggregateCoverage } from "../../scripts/coverage/aggregate";
import { object } from "../../scripts/coverage/records";

const hostModules = [
  "src/hosts/linux-sandbox.ts",
  "src/hosts/claude-keychain.ts",
  "src/hosts/mac-sandbox.ts",
  "src/runtime/discovery-apple.ts",
];

function writeSource(project: string, file: string, source: string) {
  const target = join(project, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

function copyGenerated(
  repo: string,
  project: string,
  files: string[] | undefined,
) {
  if (!files) throw new Error("Expected the generated source inventory");
  mkdirSync(join(project, "src/generated"), { recursive: true });
  for (const file of files) cpSync(join(repo, file), join(project, file));
}

export function coverageShardCandidate(repo: string, root: string) {
  const inventory = sourceInventory(repo);
  const { project } = copySnapshot(repo, root);
  for (const name of ["src", "tests", "examples", "bunfig.toml"])
    rmSync(join(project, name), { recursive: true, force: true });
  for (const name of hostModules) writeSource(project, name, "export {};\n");
  cpSync(
    join(repo, "src/value-guards.ts"),
    join(project, "src/value-guards.ts"),
  );
  writeSource(
    project,
    "src/pick.ts",
    "export function pick(flag: boolean) { if (flag) return 1; return 0; }\n",
  );
  writeSource(
    project,
    "src/cli.ts",
    "import { pick } from './pick'; pick(true); process.exitCode = 64;\n",
  );
  copyGenerated(repo, project, inventory.generated);
  const tests = [1, 2, 3, 4].map((index) => `tests/shard-${index}.test.ts`);
  for (const [index, file] of tests.entries())
    writeSource(
      project,
      file,
      'import { test, expect } from "bun:test"; import { pick } from "../src/pick";\n' +
        'import { isRecord, isUnknownArray, isStringArray, isOptionalNonblankString } from "../src/value-guards";\n' +
        `test("branch ${index}", () => { expect(pick(${index % 2 === 0})).toBe(${index % 2 === 0 ? 1 : 0});\n` +
        "expect(isRecord({})).toBe(true); expect(isRecord(null)).toBe(false); expect(isRecord([])).toBe(false);\n" +
        "expect(isUnknownArray([])).toBe(true); expect(isUnknownArray({})).toBe(false);\n" +
        'expect(isStringArray(["ready"])).toBe(true); expect(isStringArray([1])).toBe(false); expect(isStringArray(null)).toBe(false);\n' +
        'expect(isOptionalNonblankString(undefined)).toBe(true); expect(isOptionalNonblankString("ready")).toBe(true); expect(isOptionalNonblankString(" ")).toBe(false); expect(isOptionalNonblankString(1)).toBe(false); });\n',
    );
  writeFileSync(
    join(project, "typescript-sources.json"),
    JSON.stringify({
      production: [
        "src/cli.ts",
        "src/pick.ts",
        "src/value-guards.ts",
        ...hostModules,
      ],
      generated: inventory.generated,
      thirdParty: inventory.thirdParty,
      declarations: [],
      tooling: inventory.tooling,
      tests,
      examples: [],
    }),
  );
  return project;
}

async function executeShard(project: string, index: number) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(project, "scripts/check-typescript.ts"),
      "--shard",
      `${index}/4`,
    ],
    { cwd: project, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`Fixture shard ${index} failed: ${stdout}\n${stderr}`);
}

export async function exerciseCoverageShards(project: string) {
  await Promise.all([1, 2, 3, 4].map((index) => executeShard(project, index)));
  const pickBranches = [1, 2, 3, 4].map((index) => {
    const value: unknown = JSON.parse(
      readFileSync(
        join(
          project,
          ".quality/shards",
          String(index),
          "coverage-portable.json",
        ),
        "utf8",
      ),
    );
    return object(object(object(value)["src/pick.ts"]).b);
  });
  const runs = [1, 2, 3, 4].map((index) => {
    const value: unknown = JSON.parse(
      readFileSync(
        join(project, ".quality/shards", String(index), "run.json"),
        "utf8",
      ),
    );
    return value;
  });
  aggregateCoverage(project, join(project, ".quality/shards"));
  const combined: unknown = JSON.parse(
    readFileSync(join(project, ".quality/coverage/run.json"), "utf8"),
  );
  return { runs, pickBranches, combined };
}
