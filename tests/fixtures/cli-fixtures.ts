import { fixtureCase, parseCliResult } from "./assertions";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extensionFixtureCommand } from "./extension-command";

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

export const fixtureExtensionCommand = extensionFixtureCommand();

export function createFixture(roots: string[]) {
  async function fixture() {
    const projectRoot = await mkdtemp(join(tmpdir(), "sevro-cli-test-"));
    roots.push(projectRoot);
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

export async function git(root: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [error, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(error);
}

export async function installLinuxCodexHelper(binary: string, codex: string) {
  if (process.platform === "linux")
    await symlink(codex, join(dirname(binary), "codex-linux-sandbox"));
}
