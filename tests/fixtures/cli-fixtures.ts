import { symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fixtureCase, parseCliResult } from "./assertions";
import { createTemporaryFixtures } from "./filesystem";

const testDirectory = join(import.meta.dir, "..");

export const isolatedNativeHost =
  process.platform === "darwin" ||
  (process.platform === "linux" && Boolean(Bun.which("bwrap")));

export const cli = join(testDirectory, "..", "src", "cli.ts");

export const adapter = join(testDirectory, "fixtures", "host-adapter.ts");

export const semanticAdapter = join(
  testDirectory,
  "fixtures",
  "semantic-adapter.ts",
);

export const extensionSource = join(testDirectory, "fixtures", "extension.ts");

export const digest = "a".repeat(64);

export function createFixture(roots: string[]) {
  const { temporaryFixture } = createTemporaryFixtures(roots);

  async function fixture() {
    const projectRoot = await temporaryFixture(
      join(tmpdir(), "sevro-cli-test-"),
    );

    const caseFile = join(projectRoot, "case.json");
    const resultsRoot = join(projectRoot, "results");
    await writeFile(caseFile, JSON.stringify(fixtureCase()));
    const args = [
      process.execPath,
      cli,
      "run",
      "--json",
      "--case-file",
      caseFile,
      "--adapter-module",
      adapter,
      "--project-root",
      projectRoot,
      "--results-root",
      resultsRoot,
      "--runner-build-digest",
      digest,
      "--project-digest",
      digest,
      "--condition",
      "passive",
      "--trials",
      "1",
      "--threshold",
      "1",
    ];
    return { args, caseFile };
  }
  return fixture;
}

export async function invoke(
  args: string[],
  scenario = "pass",
  environment: Record<string, string> = {},
) {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SEVRO_TEST_SCENARIO: scenario, ...environment },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code, result: parseCliResult(stdout) };
}

export async function installLinuxCodexHelper(binary: string, codex: string) {
  if (process.platform === "linux")
    await symlink(codex, join(dirname(binary), "codex-linux-sandbox"));
}

export { fixtureGit as git } from "./filesystem";
