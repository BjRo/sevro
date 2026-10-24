import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function fixtureGit(
  root: string,
  ...args: string[]
): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@sevro.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@sevro.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00",
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`Fixture Git ${args[0] ?? "command"} failed: ${stderr}`);
  return stdout.trim();
}

export function createTemporaryFixtures(roots: string[] = []) {
  async function temporaryFixture(
    prefix = join(tmpdir(), "sevro-fixture-quality-"),
  ): Promise<string> {
    const root = await mkdtemp(prefix);
    retainTemporaryFixture(root);
    return root;
  }
  function temporaryFixtureSync(prefix: string): string {
    const root = mkdtempSync(prefix);
    retainTemporaryFixture(root);
    return root;
  }
  function retainTemporaryFixture(path: string): void {
    if (!roots.includes(path)) roots.push(path);
  }
  async function cleanupTemporaryFixtures(): Promise<void> {
    await Promise.all(
      [...new Set(roots.splice(0))].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  }
  async function repositoryFixture() {
    const root = await temporaryFixture();
    const repository = join(root, "sources", "repository");
    await mkdir(repository, { recursive: true });
    await fixtureGit(repository, "init", "--quiet", "--initial-branch=main");
    await writeFile(join(repository, "README.md"), "baseline\n");
    await fixtureGit(repository, "add", "README.md");
    await fixtureGit(repository, "commit", "--quiet", "-m", "Fixture baseline");
    return {
      root,
      repository,
      revision: await fixtureGit(repository, "rev-parse", "HEAD"),
    };
  }
  return {
    temporaryFixture,
    temporaryFixtureSync,
    retainTemporaryFixture,
    cleanupTemporaryFixtures,
    repositoryFixture,
  };
}
