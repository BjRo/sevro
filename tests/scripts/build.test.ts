import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTemporaryFixtures } from "../fixtures/filesystem";

const source = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

async function writePublicApiFixture(root: string): Promise<void> {
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        types: ["node"],
      },
    }),
  );
  await writeFile(
    join(root, "src/api-types.ts"),
    "export interface BuildInput { label: string }\nexport interface BuildResult { label: string }\n",
  );
  await writeFile(
    join(root, "src/index.ts"),
    'import { label } from "./label";\nimport type { BuildInput, BuildResult } from "./api-types";\nexport type { BuildInput, BuildResult } from "./api-types";\nexport function evaluate(input: BuildInput): Promise<BuildResult> { return Promise.resolve({ label: input.label + " " + label }); }\n',
  );
}

test("build preserves filename data while emitting runnable Node modules", async () => {
  const root = await temporaryFixture();
  for (const directory of ["scripts", "src", "examples"])
    await mkdir(join(root, directory));
  await cp(join(source, "scripts/build.ts"), join(root, "scripts/build.ts"));
  await symlink(join(source, "node_modules"), join(root, "node_modules"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { build: "bun scripts/build.ts" },
    }),
  );
  await writeFile(
    join(root, "src/label.ts"),
    'export const label: string = "evaluator.ts";\n',
  );
  await writeFile(
    join(root, "src/cli.ts"),
    '#!/usr/bin/env node\nimport { label } from "./label";\nconsole.log(label);\n',
  );
  await writePublicApiFixture(root);
  const built = Bun.spawnSync([process.execPath, "run", "build"], {
    cwd: root,
  });
  expect(built.exitCode, built.stderr.toString()).toBe(0);
  const run = Bun.spawnSync(["node", join(root, "dist/src/cli.js")], {
    cwd: root,
  });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  expect(run.stdout.toString()).toBe("evaluator.ts\n");
  await writeFile(
    join(root, "consumer.ts"),
    'import { evaluate, type BuildInput } from "./dist/src/index.js";\nconst input: BuildInput = { label: "consumer.ts" };\n// @ts-expect-error public declaration constrains the caller\nconst invalid: BuildInput = { label: 42 };\nconst result = await evaluate(input);\nif (result.label !== "consumer.ts evaluator.ts") throw new Error("wrong fixture evaluation");\n',
  );
  const compiled = Bun.spawnSync(
    [
      "node",
      join(root, "node_modules/typescript/bin/tsc"),
      "consumer.ts",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--strict",
      "--skipLibCheck",
      "false",
      "--types",
      "node",
    ],
    { cwd: root },
  );
  expect(
    compiled.exitCode,
    compiled.stderr.toString() + compiled.stdout.toString(),
  ).toBe(0);
  const consumer = Bun.spawnSync(["node", join(root, "consumer.js")], {
    cwd: root,
  });
  expect(consumer.exitCode, consumer.stderr.toString()).toBe(0);
});
