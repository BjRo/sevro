import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runEvaluation, type HostAdapter } from "../src/engine";

const roots: string[] = [];
const digest = "a".repeat(64);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function git(root: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return output.trim();
}

test("repository fixtures clone a declared clean commit without remotes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-repository-test-"));
  roots.push(projectRoot);
  const sourceRoot = join(projectRoot, "sources");
  const repository = join(sourceRoot, "example");
  await mkdir(repository, { recursive: true });
  await git(repository, "init", "-b", "main");
  await writeFile(join(repository, "README.md"), "repository fixture\n");
  await git(repository, "add", "README.md");
  await git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Create fixture",
  );
  const sourceRef = "fixture-repo";
  const sources = {
    root: sourceRoot,
    refs: { [sourceRef]: pathToFileURL(repository).href },
  };
  const workspaces: string[] = [];
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run({ workspace }) {
      workspaces.push(workspace);
      expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
        "repository fixture\n",
      );
      expect(await git(workspace, "remote")).toBe("");
      return { finalMessage: "ready", complete: true };
    },
  };
  const options = {
    projectRoot,
    resultsRoot: join(projectRoot, "results"),
    case: {
      id: "repository-case",
      prompt: "Return ready.",
      fixture: { sourceRef },
      checks: [
        {
          id: "ready",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
      requiredEvidence: [],
    },
    preparationSources: sources,
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 2,
    passThreshold: 1,
  };
  const first = await runEvaluation(options);
  expect(first.result.exitCode).toBe(0);
  expect(workspaces).toHaveLength(2);
  const firstEvidence = JSON.parse(
    await readFile(first.result.evidencePath, "utf8"),
  );

  await writeFile(join(repository, "extra.txt"), "new commit\n");
  await expect(runEvaluation(options)).rejects.toThrow(/uncommitted changes/);
  await git(repository, "add", "extra.txt");
  await git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Extend fixture",
  );
  const second = await runEvaluation(options);
  const secondEvidence = JSON.parse(
    await readFile(second.result.evidencePath, "utf8"),
  );
  expect(firstEvidence.evaluationIdentity.dimensions.fixtureDigest).not.toBe(
    secondEvidence.evaluationIdentity.dimensions.fixtureDigest,
  );

  const outside = await mkdtemp(join(tmpdir(), "sevro-outside-source-"));
  roots.push(outside);
  await expect(
    runEvaluation({
      ...options,
      preparationSources: {
        root: sourceRoot,
        refs: { [sourceRef]: pathToFileURL(outside).href },
      },
    }),
  ).rejects.toThrow(/escapes its declared root/);
});
