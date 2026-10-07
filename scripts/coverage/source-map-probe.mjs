import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instrumentFile } from "./prepare.mjs";

export function sourceMapProbe() {
  const root = mkdtempSync(join(tmpdir(), "sevro-source-map-"));
  const source = join(root, "original.ts");
  const target = join(root, "instrumented.ts");
  writeFileSync(
    source,
    "export interface Shape {\n  value: number;\n}\n\nexport function fail(input: Shape): never {\n  throw new Error('source-map-probe');\n}\n\nfail({ value: 1 });\n",
  );
  const metadata = instrumentFile(
    source,
    target,
    join(import.meta.dir, "capture.cjs"),
  );
  const env = { ...process.env };
  delete env.SEVRO_COVERAGE_REPORTS;
  const child = Bun.spawnSync([process.execPath, target], {
    cwd: tmpdir(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = child.stderr.toString();
  if (child.exitCode === 0 || !stderr.includes(`${source}:6:`))
    throw new Error("Runtime stack does not map to original TypeScript");
  const statement = Object.values(metadata.statementMap).find(
    (location) => location.start.line === 6,
  );
  if (statement?.start.column !== 2)
    throw new Error("Counter does not map to original TypeScript throw");
  console.log("original-typescript:6");
  return { root, source, statement, stderr };
}
