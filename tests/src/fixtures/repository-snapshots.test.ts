import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runEvaluation } from "../../../src/engine";
import {
  applyRepositoryOverlay,
  cloneRepositorySource,
  prepareRepositoryFixture,
  resolveRepositorySource,
} from "../../../src/fixtures/repository";
import { createTemporaryFixtures, fixtureGit } from "../../fixtures/filesystem";

const { repositoryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

async function withGitEnvironment<T>(
  values: Record<string, string>,
  action: () => Promise<T>,
): Promise<T> {
  const previous = Object.keys(values).map(
    (key) => [key, process.env[key]] as const,
  );
  Object.assign(process.env, values);
  try {
    return await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

async function evaluateRepositoryFixture(
  source: Awaited<ReturnType<typeof repositoryFixture>>,
) {
  let calls = 0;
  const outcome = await runEvaluation({
    projectRoot: source.root,
    resultsRoot: join(source.root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    preparationSources: {
      root: join(source.root, "sources"),
      refs: { source: pathToFileURL(source.repository).href },
    },
    case: {
      id: "isolated-repository",
      prompt: "Return ready.",
      fixture: {
        sourceRef: "source",
        files: { "notes.txt": "evaluation scaffolding\n" },
        commitFiles: true,
      },
      checks: [],
      requiredEvidence: [],
    },
    host: {
      id: "example.host",
      model: "fixture",
      effort: "none",
      async run({ workspace }) {
        calls++;
        expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
          "baseline\n",
        );
        expect(await fixtureGit(workspace, "rev-parse", "HEAD^")).toBe(
          source.revision,
        );
        expect(await fixtureGit(workspace, "show", "HEAD:notes.txt")).toBe(
          "evaluation scaffolding",
        );
        expect(await fixtureGit(workspace, "remote")).toBe("");
        expect(await fixtureGit(workspace, "status", "--porcelain")).toBe("");
        return { finalMessage: "ready", complete: true };
      },
    },
  });
  expect(calls).toBe(1);
  expect(outcome.result.exitCode).toBe(0);
  return outcome;
}

test.each(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const)(
  "repository evaluations ignore caller %s without modifying another repository",
  async (variable) => {
    const source = await repositoryFixture();
    const other = await repositoryFixture();
    await writeFile(join(other.repository, "README.md"), "other repository\n");
    await fixtureGit(other.repository, "add", "README.md");
    const index = await readFile(join(other.repository, ".git", "index"));
    const values = {
      GIT_DIR: { GIT_DIR: join(other.repository, ".git") },
      GIT_WORK_TREE: { GIT_WORK_TREE: other.repository },
      GIT_INDEX_FILE: {
        GIT_INDEX_FILE: join(other.repository, ".git", "index"),
      },
    };
    await withGitEnvironment(values[variable], () =>
      evaluateRepositoryFixture(source),
    );
    expect(await fixtureGit(source.repository, "rev-parse", "HEAD")).toBe(
      source.revision,
    );
    expect(await fixtureGit(source.repository, "status", "--porcelain")).toBe(
      "",
    );
    expect(await fixtureGit(other.repository, "rev-parse", "HEAD")).toBe(
      other.revision,
    );
    expect(await readFile(join(other.repository, ".git", "index"))).toEqual(
      index,
    );
    expect(await readFile(join(other.repository, "README.md"), "utf8")).toBe(
      "other repository\n",
    );
  },
);

test("repository evaluations suppress checkout hooks supplied by Git templates", async () => {
  const source = await repositoryFixture();
  const template = join(source.root, "template");
  const marker = join(source.root, "checkout-hook-ran");
  const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  await mkdir(join(template, "hooks"), { recursive: true });
  await writeFile(
    join(template, "hooks", "post-checkout"),
    `#!/bin/sh\nprintf 'checkout hook ran\\n' > ${quote(marker)}\n`,
    { mode: 0o700 },
  );
  await fixtureGit(
    source.root,
    "-c",
    `init.templateDir=${template}`,
    "clone",
    "--quiet",
    source.repository,
    join(source.root, "control"),
  );
  expect(await readFile(marker, "utf8")).toBe("checkout hook ran\n");
  await rm(marker);

  const executable = Bun.which("git");
  if (!executable) throw new Error("Git is required for the template fixture");
  const bin = join(source.root, "bin");
  await mkdir(bin);
  // Model an installation's default template while delegating every operation to real Git.
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\nexec ${quote(executable)} -c ${quote(`init.templateDir=${template}`)} "$@"\n`,
    { mode: 0o700 },
  );
  await withGitEnvironment(
    { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    async () => {
      expect(
        await fixtureGit(source.root, "config", "--get", "init.templateDir"),
      ).toBe(template);
      await evaluateRepositoryFixture(source);
    },
  );
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("repository resolution refuses an undeclared source reference without changing the declared source", async () => {
  const source = await repositoryFixture();
  const sources = {
    root: join(source.root, "sources"),
    refs: { source: pathToFileURL(source.repository).href },
  };
  expect(resolveRepositorySource("missing-reference", sources)).rejects.toThrow(
    "repository source reference is not declared",
  );
  expect(await fixtureGit(source.repository, "rev-parse", "HEAD")).toBe(
    source.revision,
  );
  expect(await fixtureGit(source.repository, "status", "--porcelain")).toBe("");
});

test("repository overlay refuses a regular file as a parent and retains its original bytes", async () => {
  const source = await repositoryFixture();
  const overlay = prepareRepositoryFixture({
    kind: "repository",
    sourceRef: "source",
    files: { "README.md/child.txt": "replacement" },
  });
  expect(applyRepositoryOverlay(overlay, source.repository)).rejects.toThrow(
    "repository fixture overlay traverses a non-directory",
  );
  expect(await readFile(join(source.repository, "README.md"), "utf8")).toBe(
    "baseline\n",
  );
  expect(await fixtureGit(source.repository, "rev-parse", "HEAD")).toBe(
    source.revision,
  );
});

const repositorySources = [
  {
    name: "non-file URL",
    target: "https://example.invalid/repository",
    diagnostic: "must be a file URL",
  },
  {
    name: "missing repository",
    target: "missing",
    diagnostic: "source is unreadable",
  },
  {
    name: "regular file",
    target: "file.txt",
    diagnostic: "source is unreadable",
  },
];

for (const invalid of repositorySources) {
  test(`repository source maps refuse a ${invalid.name}`, async () => {
    const source = await repositoryFixture();
    await writeFile(
      join(source.root, "sources", "file.txt"),
      "source record\n",
    );
    const target = invalid.target.startsWith("https:")
      ? invalid.target
      : pathToFileURL(join(source.root, "sources", invalid.target)).href;
    const sources = {
      root: join(source.root, "sources"),
      refs: { source: target },
    };
    expect(resolveRepositorySource("source", sources)).rejects.toThrow(
      invalid.diagnostic,
    );
    expect(await fixtureGit(source.repository, "rev-parse", "HEAD")).toBe(
      source.revision,
    );
  });
}

test("repository source resolution refuses a nested directory instead of the declared repository root", async () => {
  const source = await repositoryFixture();
  await mkdir(join(source.repository, "nested"));
  const sources = {
    root: join(source.root, "sources"),
    refs: { source: pathToFileURL(join(source.repository, "nested")).href },
  };
  expect(resolveRepositorySource("source", sources)).rejects.toThrow(
    "must name the repository root",
  );
  expect(await fixtureGit(source.repository, "status", "--porcelain")).toBe("");
});

async function repositoryWithSubmodule() {
  const source = await repositoryFixture();
  const child = await repositoryFixture();
  await fixtureGit(
    source.repository,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    child.repository,
    "dependency",
  );
  await fixtureGit(
    source.repository,
    "config",
    "--file",
    ".gitmodules",
    "submodule.dependency.url",
    "https://example.invalid/unavailable-dependency.git",
  );
  await fixtureGit(source.repository, "add", ".gitmodules");
  await fixtureGit(
    source.repository,
    "commit",
    "--quiet",
    "-m",
    "Add fixture dependency",
  );
  return { source, child };
}

test.each(["uninitialized", "initialized"])(
  "repository fixtures preserve pinned submodule declarations with %s sources",
  // eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
  async (initialized) => {
    const { source, child } = await repositoryWithSubmodule();
    if (initialized === "uninitialized")
      await fixtureGit(
        source.repository,
        "submodule",
        "deinit",
        "--force",
        "dependency",
      );
    const revision = await fixtureGit(source.repository, "rev-parse", "HEAD");
    const modules = await readFile(
      join(source.repository, ".gitmodules"),
      "utf8",
    );
    const submoduleStatus = await fixtureGit(
      source.repository,
      "submodule",
      "status",
    );
    const sources = {
      root: join(source.root, "sources"),
      refs: { source: pathToFileURL(source.repository).href },
    };
    let calls = 0;
    const outcome = await runEvaluation({
      projectRoot: source.root,
      resultsRoot: join(source.root, "results"),
      runnerBuildDigest: "a".repeat(64),
      projectDigest: "b".repeat(64),
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
      preparationSources: sources,
      case: {
        id: "submodule-source",
        prompt: "Return ready.",
        fixture: { sourceRef: "source" },
        checks: [
          {
            id: "ready",
            grader: "sevro.regex",
            configuration: { pattern: "^ready$" },
          },
        ],
        requiredEvidence: [],
      },
      host: {
        id: "example.host",
        model: "fixture",
        effort: "none",
        async run({ workspace }) {
          calls++;
          expect(await fixtureGit(workspace, "rev-parse", "HEAD")).toBe(
            revision,
          );
          expect(
            await fixtureGit(workspace, "ls-tree", "HEAD", "dependency"),
          ).toBe(`160000 commit ${child.revision}\tdependency`);
          expect(await readFile(join(workspace, ".gitmodules"), "utf8")).toBe(
            modules,
          );
          expect(await readdir(join(workspace, "dependency"))).toEqual([]);
          expect(await fixtureGit(workspace, "submodule", "status")).toBe(
            `-${child.revision} dependency`,
          );
          expect(await fixtureGit(workspace, "remote")).toBe("");
          expect(await fixtureGit(workspace, "status", "--porcelain")).toBe("");
          return { finalMessage: "ready", complete: true };
        },
      },
    });
    expect(calls).toBe(1);
    expect(outcome.result.execution.status).toBe("completed");
    expect(outcome.result.grading.status).toBe("completed");
    expect(outcome.result.task.verdict).toBe("passed");
    expect(outcome.result.exitCode).toBe(0);
    expect(await fixtureGit(source.repository, "rev-parse", "HEAD")).toBe(
      revision,
    );
    expect(await fixtureGit(source.repository, "status", "--porcelain")).toBe(
      "",
    );
    expect(await fixtureGit(source.repository, "submodule", "status")).toBe(
      submoduleStatus,
    );
    expect(await readFile(join(source.repository, ".gitmodules"), "utf8")).toBe(
      modules,
    );
  },
);

test.each(["tracked", "untracked", "revision"])(
  "repository fixtures refuse ignored submodule %s changes before candidate execution",
  async (change) => {
    const { source } = await repositoryWithSubmodule();
    await fixtureGit(
      source.repository,
      "config",
      "--file",
      ".gitmodules",
      "submodule.dependency.ignore",
      "all",
    );
    await fixtureGit(source.repository, "add", ".gitmodules");
    await fixtureGit(
      source.repository,
      "commit",
      "--quiet",
      "-m",
      "Ignore dependency changes",
    );
    const dependency = join(source.repository, "dependency");
    if (change === "revision")
      await fixtureGit(
        dependency,
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "Advance dependency",
      );
    else
      await writeFile(
        join(dependency, change === "tracked" ? "README.md" : "untracked.txt"),
        "changed dependency\n",
      );
    expect(await fixtureGit(source.repository, "status", "--porcelain")).toBe(
      "",
    );
    let calls = 0;
    const pending = runEvaluation({
      projectRoot: source.root,
      resultsRoot: join(source.root, "results"),
      runnerBuildDigest: "a".repeat(64),
      projectDigest: "b".repeat(64),
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
      preparationSources: {
        root: join(source.root, "sources"),
        refs: { source: pathToFileURL(source.repository).href },
      },
      case: {
        id: "dirty-submodule-source",
        prompt: "Return ready.",
        fixture: { sourceRef: "source" },
        checks: [],
        requiredEvidence: [],
      },
      host: {
        id: "example.host",
        model: "fixture",
        effort: "none",
        run() {
          calls++;
          return Promise.resolve({ finalMessage: "ready", complete: true });
        },
      },
    });
    expect(pending).rejects.toThrow(
      "repository source has uncommitted changes",
    );
    await pending.catch(() => undefined);
    expect(calls).toBe(0);
  },
);

test("repository cloning refuses a source revision that changed after resolution", async () => {
  const source = await repositoryFixture();
  const sources = {
    root: join(source.root, "sources"),
    refs: { source: pathToFileURL(source.repository).href },
  };
  const expected = await resolveRepositorySource("source", sources);
  await writeFile(join(source.repository, "README.md"), "new revision\n");
  await fixtureGit(source.repository, "add", "README.md");
  await fixtureGit(
    source.repository,
    "commit",
    "--quiet",
    "-m",
    "Advance fixture",
  );
  const workspace = join(source.root, "clone");
  await mkdir(workspace);
  expect(
    cloneRepositorySource("source", sources, expected, workspace),
  ).rejects.toThrow("source changed during run");
  expect(await readdir(workspace)).toEqual([]);
});

test("repository overlays create nested directories but refuse symlink parents and existing directory targets", async () => {
  const source = await repositoryFixture();
  const overlay = prepareRepositoryFixture({
    kind: "repository",
    sourceRef: "source",
    files: { "new/nested.txt": "new file" },
  });
  await applyRepositoryOverlay(overlay, source.repository);
  expect(
    await readFile(join(source.repository, "new", "nested.txt"), "utf8"),
  ).toBe("new file");
  await symlink("new", join(source.repository, "linked"));
  const linked = prepareRepositoryFixture({
    kind: "repository",
    sourceRef: "source",
    files: { "linked/nested.txt": "replaced" },
  });
  expect(applyRepositoryOverlay(linked, source.repository)).rejects.toThrow(
    "non-directory",
  );
  const directory = prepareRepositoryFixture({
    kind: "repository",
    sourceRef: "source",
    files: { new: "replaced" },
  });
  expect(applyRepositoryOverlay(directory, source.repository)).rejects.toThrow(
    "non-file",
  );
  expect(
    await readFile(join(source.repository, "new", "nested.txt"), "utf8"),
  ).toBe("new file");
});
