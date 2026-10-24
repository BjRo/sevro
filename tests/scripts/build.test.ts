import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTemporaryFixtures } from "../fixtures/filesystem";

const source = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

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
  const built = Bun.spawnSync([process.execPath, "run", "build"], {
    cwd: root,
  });
  expect(built.exitCode, built.stderr.toString()).toBe(0);
  const run = Bun.spawnSync(["node", join(root, "dist/src/cli.js")], {
    cwd: root,
  });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  expect(run.stdout.toString()).toBe("evaluator.ts\n");
});
