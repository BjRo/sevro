import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runEvaluation, type HostAdapter } from "../../src/engine";
import { openExtensionSession } from "../../src/extension-session";
import { prepareInlineArtifacts } from "../../src/fixtures/preparation";
import { prepareGeneratedFixture } from "../../src/fixtures/generated";
import { createFixture } from "../../src/fixtures/create";
import { prepareFixtureSetup } from "../../src/fixtures/setup";
import { defined, parseRunEvidence } from "./assertions";
import { wireCase, wireOptions } from "./engine-session";
import { fixtureGit, createTemporaryFixtures } from "./filesystem";
import { inlineArtifact, generatedBaseline } from "./preparation-fixtures";

const { temporaryFixture, retainTemporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

test("direct fixture creation owns a real empty temporary workspace without a reservation", async () => {
  const root = await temporaryFixture();
  const workspace = await createFixture(
    { files: {} },
    [],
    undefined,
    null,
    null,
    null,
    null,
    root,
  );
  retainTemporaryFixture(workspace);
  expect(workspace).toBe(await realpath(workspace));
  expect(workspace).not.toBe(root);
  expect(await readdir(workspace)).toEqual([]);
  expect((await stat(workspace)).mode & 0o777).toBe(0o700);
});

test("direct fixture creation copies inline bytes and verified artifacts with private file modes", async () => {
  const root = await temporaryFixture();
  await writeFile(join(root, "source.txt"), "unchanged source\n");
  const fixture = { files: { "nested/answer.txt": "original answer\n" } };
  const declarations = [
    inlineArtifact(),
    {
      ...inlineArtifact(Buffer.from("#!/bin/sh\necho ready\n")),
      id: "example.executable",
      relativePath: "tools/ready",
      executable: true,
    },
  ];
  const workspace = await createFixture(
    fixture,
    prepareInlineArtifacts(declarations, []),
    undefined,
    null,
    null,
    null,
    null,
    root,
  );
  retainTemporaryFixture(workspace);
  expect(await readFile(join(workspace, "nested/answer.txt"), "utf8")).toBe(
    fixture.files["nested/answer.txt"],
  );
  expect((await stat(join(workspace, "nested"))).mode & 0o777).toBe(0o700);
  expect((await stat(join(workspace, "nested/answer.txt"))).mode & 0o777).toBe(
    0o600,
  );
  expect(await readFile(join(workspace, "assets/prepared.txt"), "utf8")).toBe(
    "prepared\n",
  );
  expect(
    (await stat(join(workspace, "assets/prepared.txt"))).mode & 0o777,
  ).toBe(0o600);
  expect(await readFile(join(workspace, "tools/ready"), "utf8")).toBe(
    "#!/bin/sh\necho ready\n",
  );
  expect((await stat(join(workspace, "tools/ready"))).mode & 0o777).toBe(0o700);
  await writeFile(join(workspace, "nested/answer.txt"), "candidate edit\n");
  expect(fixture.files["nested/answer.txt"]).toBe("original answer\n");
  expect(await readFile(join(root, "source.txt"), "utf8")).toBe(
    "unchanged source\n",
  );
});

test("direct Git fixture preparation excludes bracket and space filenames literally while retaining lookalike candidate files", async () => {
  const root = await temporaryFixture();
  const generated = prepareGeneratedFixture(generatedBaseline);
  const relativePath = "assets/[probe] file.txt";
  const artifacts = prepareInlineArtifacts(
    [{ ...inlineArtifact(), relativePath, gitExclude: true }],
    [],
  );
  const workspace = await createFixture(
    generated,
    artifacts,
    undefined,
    null,
    null,
    generated,
    null,
    root,
  );
  retainTemporaryFixture(workspace);
  const revision = await fixtureGit(workspace, "rev-parse", "HEAD");
  await writeFile(join(workspace, "assets/p file.txt"), "candidate bytes\n");
  expect(await fixtureGit(workspace, "check-ignore", "--", relativePath)).toBe(
    relativePath,
  );
  const status = await fixtureGit(
    workspace,
    "status",
    "--porcelain",
    "--untracked-files=all",
  );
  expect(status).toContain("assets/p file.txt");
  expect(status).not.toContain(relativePath);
  expect(await readFile(join(workspace, relativePath), "utf8")).toBe(
    "prepared\n",
  );
  expect(await readFile(join(workspace, "assets/p file.txt"), "utf8")).toBe(
    "candidate bytes\n",
  );
  expect(await fixtureGit(workspace, "rev-parse", "HEAD")).toBe(revision);
});

test("direct unreserved fixture creation removes its owned workspace after ordinary setup exit seven", async () => {
  const root = await temporaryFixture();
  const scriptPath = join(root, "setup.ts");
  const receipt = join(root, "workspace.txt");
  const script = `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], process.cwd());
process.exit(7);
`;
  await writeFile(scriptPath, script);
  await writeFile(join(root, "source.txt"), "unchanged source\n");
  const setup = defined(
    prepareFixtureSetup({
      command: [process.execPath, scriptPath, receipt],
    }),
  );
  const generated = prepareGeneratedFixture(generatedBaseline);
  const pending = createFixture(
    generated,
    [],
    undefined,
    null,
    null,
    generated,
    setup,
    root,
  );
  expect(pending).rejects.toThrow("fixture setup failed (7)");
  await pending.catch(() => undefined);
  const workspace = await readFile(receipt, "utf8");
  expect(workspace).not.toBe(root);
  expect(existsSync(workspace)).toBe(false);
  expect(await readFile(scriptPath, "utf8")).toBe(script);
  expect(await readFile(join(root, "source.txt"), "utf8")).toBe(
    "unchanged source\n",
  );
});

test("engine refuses a setup-created regular file in place of the fixture binary directory", async () => {
  const root = await temporaryFixture();
  const fixture = {
    kind: "generated" as const,
    commits: [{ message: "Baseline", files: { "README.md": "baseline\n" } }],
  };
  const setup = wireOptions({
    describe: {
      extension: { id: "example.extension", version: "1.0.0" },
      protocols: ["sevro.extension.v1"],
      requiredCapabilities: ["sevro.fixture.setup"],
      optionalCapabilities: [],
      graders: ["example.extension"],
      taskVerdictPolicies: [],
    },
    resolve: { cases: [{ ...wireCase, fixture }] },
    prepare: {
      artifacts: [],
      requestedInstrumentation: [],
      extensionData: {},
      fixtureSetup: {
        command: [
          process.execPath,
          "-e",
          'await Bun.write(".git/fixture-bin", "not a directory");',
        ],
      },
    },
  });
  setup.engineCapabilities = ["sevro.fixture.setup"];
  const session = await openExtensionSession(setup);
  const resolved = defined(
    (await session.resolve(pathToFileURL(root).href, {}))[0],
  );
  let calls = 0;
  const pending = runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    case: { ...resolved, fixture },
    extension: { session, resolvedCase: resolved },
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
  expect(pending).rejects.toThrow("fixture binary directory is invalid");
  await pending.catch(() => undefined);
  expect(calls).toBe(0);
});

test("engine clears nested permission-locked owned contents while retaining outside bytes and trial evidence", async () => {
  const root = await temporaryFixture();
  const external = join(root, "external");
  await mkdir(external);
  await writeFile(join(external, "retained.txt"), "external retained\n");
  await chmod(external, 0o500);
  const originalMode = (await lstat(external)).mode;
  let workspace = "";
  const host: HostAdapter = {
    id: "example.host",
    model: "fixture",
    effort: "none",
    async run(request) {
      workspace = request.workspace;
      const locked = join(workspace, "locked"),
        nested = join(locked, "nested");
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "value.txt"), "candidate output\n");
      await symlink(external, join(nested, "external"));
      await chmod(nested, 0o000);
      await chmod(locked, 0o000);
      return { finalMessage: "ready", complete: true };
    },
  };
  try {
    const outcome = await runEvaluation({
      projectRoot: root,
      resultsRoot: join(root, "results"),
      host,
      runnerBuildDigest: "a".repeat(64),
      projectDigest: "b".repeat(64),
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
      case: {
        id: "nested-cleanup",
        prompt: "Return ready.",
        fixture: { files: { "README.md": "fixture\n" } },
        checks: [
          {
            id: "ready",
            grader: "sevro.regex",
            configuration: { pattern: "^ready$" },
          },
        ],
        requiredEvidence: [],
      },
    });
    expect(outcome.result.exitCode).toBe(0);
    const evidence = parseRunEvidence(
      await readFile(outcome.result.evidencePath, "utf8"),
    );
    expect(outcome.result.task.verdict).toBe("passed");
    expect(
      await readFile(
        new URL(defined(defined(evidence.trials[0]).rawResult.path)),
        "utf8",
      ),
    ).toBe("ready");
    expect(await lstat(workspace).catch(() => null)).toBeNull();
    expect(await readFile(join(external, "retained.txt"), "utf8")).toBe(
      "external retained\n",
    );
    expect((await lstat(external)).mode).toBe(originalMode);
  } finally {
    if (workspace)
      for (const path of [
        workspace,
        join(workspace, "locked"),
        join(workspace, "locked/nested"),
      ])
        await chmod(path, 0o700).catch(() => undefined);
    await chmod(external, 0o700);
  }
});
