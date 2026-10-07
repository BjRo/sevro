import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  readdir,
  symlink,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildBlindAdvisoryFixture } from "../src/advisory-fixture";
import { runEvaluation, type HostAdapter } from "../src/engine";
import { openExtensionSession } from "../src/extension-session";
import {
  prepareArtifacts,
  prepareInlineArtifacts,
  safePreparationTarget,
  type PreparationArtifact,
} from "../src/preparation";
import { prepareGeneratedFixture } from "../src/generated-fixture";
import { createFixture } from "../src/evaluation-fixture";
import { prepareFixtureSetup } from "../src/fixture-setup";
import { installFixtureTools } from "../src/fixture-tools";
import {
  applyRepositoryOverlay,
  cloneRepositorySource,
  prepareRepositoryFixture,
  resolveRepositorySource,
} from "../src/repository-fixture";
import {
  checkoutProvenance,
  packageBuildDigest,
  projectIdentityDigest,
  projectProvenance,
} from "../src/provenance";
import { defined, parseRunEvidence } from "./fixtures/assertions";
import { wireCase, wireOptions } from "./fixtures/quality-engine-session";
import {
  cleanupTemporaryFixtures,
  fixtureGit,
  repositoryFixture,
  retainTemporaryFixture,
  temporaryFixture,
} from "./quality-fixtures/fixture-preparation-tools";

afterEach(cleanupTemporaryFixtures);

const toolMessages = {
  directory: "fixture tool directory must be real",
  target: "fixture tool target must be regular",
};

test("fixture executable installation replaces only an existing regular target and sets its executable mode", async () => {
  const root = await temporaryFixture();
  const path = join(root, "ready");
  await writeFile(path, "old bytes", { mode: 0o600 });
  await installFixtureTools(
    { ready: "#!/bin/sh\necho ready\n" },
    root,
    toolMessages,
  );
  expect(await readFile(path, "utf8")).toBe("#!/bin/sh\necho ready\n");
  expect((await stat(path)).mode & 0o777).toBe(0o755);
});

test.each(["directory", "symlink"])(
  "fixture executable installation refuses an existing %s target and preserves its contents",
  async (kind) => {
    const root = await temporaryFixture();
    const external = join(root, "external");
    await mkdir(external);
    await writeFile(join(external, "original.txt"), "original bytes");
    if (kind === "directory") await mkdir(join(root, "ready"));
    else await symlink(join(external, "original.txt"), join(root, "ready"));
    const pending = installFixtureTools(
      { ready: "replaced bytes" },
      root,
      toolMessages,
    );
    expect(pending).rejects.toThrow(toolMessages.target);
    await pending.catch(() => undefined);
    expect(await readFile(join(external, "original.txt"), "utf8")).toBe(
      "original bytes",
    );
  },
);

test.each(["regular file", "symlink"])(
  "fixture executable installation refuses a %s directory boundary",
  async (kind) => {
    const root = await temporaryFixture();
    const directory = join(root, "tools");
    await mkdir(join(root, "external"));
    if (kind === "regular file") await writeFile(directory, "original bytes");
    else await symlink("external", directory);
    const pending = installFixtureTools(
      { ready: "new bytes" },
      directory,
      toolMessages,
    );
    expect(pending).rejects.toThrow(toolMessages.directory);
    await pending.catch(() => undefined);
    expect(await readdir(join(root, "external"))).toEqual([]);
  },
);

test("fixture executable installation reports a real inaccessible owned directory without changing its files", async () => {
  const root = await temporaryFixture();
  const directory = join(root, "locked");
  await mkdir(directory);
  await writeFile(join(directory, "original.txt"), "original bytes");
  await chmod(directory, 0);
  try {
    const pending = installFixtureTools(
      { ready: "new bytes" },
      directory,
      toolMessages,
    );
    expect(pending).rejects.toThrow(/EACCES/);
    await pending.catch(() => undefined);
  } finally {
    await chmod(directory, 0o700);
  }
  expect(await readdir(directory)).toEqual(["original.txt"]);
  expect(await readFile(join(directory, "original.txt"), "utf8")).toBe(
    "original bytes",
  );
});

function inlineArtifact(
  bytes = Buffer.from("prepared\n"),
): PreparationArtifact {
  return {
    id: "example.prepared",
    relativePath: "assets/prepared.txt",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"),
  };
}

test("refuses base64 with noncanonical pad bits even when its decoded bytes match the digest", () => {
  const baseline = inlineArtifact(Buffer.from("f"));
  expect(defined(prepareInlineArtifacts([baseline], [])[0]).bytes).toEqual(
    Buffer.from("f"),
  );
  const invalid = { ...baseline, contentBase64: "Zh==" };
  expect(() => prepareInlineArtifacts([invalid], [])).toThrow(
    "canonical base64",
  );
});

test("resolves mixed inline and declared source artifacts with exact bytes and flags", async () => {
  const root = await temporaryFixture();
  const source = join(root, "source.txt");
  const bytes = Buffer.from("source bytes\n");
  await writeFile(source, bytes);
  const declared = {
    ...inlineArtifact(bytes),
    id: "example.source",
    relativePath: "assets/source.txt",
    sourceRef: "source",
    contentBase64: undefined,
    gitExclude: true,
    executable: false,
  };
  const prepared = await prepareArtifacts([inlineArtifact(), declared], [], {
    root,
    refs: { source: pathToFileURL(source).href },
  });
  expect(prepared).toHaveLength(2);
  expect(defined(prepared[1]).bytes).toEqual(bytes);
  expect(defined(prepared[1]).gitExclude).toBe(true);
  expect(defined(prepared[1]).executable).toBe(false);
  expect(await readFile(source)).toEqual(bytes);
});

const sourceRefusals = [
  {
    name: "unreadable root",
    root: "missing",
    url: "source.txt",
    diagnostic: "source root is unreadable",
  },
  {
    name: "non-file URL",
    root: "",
    url: "https://example.invalid/source",
    diagnostic: "must be a file URL",
  },
  {
    name: "missing file",
    root: "",
    url: "missing.txt",
    diagnostic: "source is unreadable",
  },
  {
    name: "directory source",
    root: "",
    url: "directory",
    diagnostic: "source is unreadable",
  },
];

for (const refusal of sourceRefusals) {
  test(`refuses preparation with ${refusal.name} and preserves declared source bytes`, async () => {
    const root = await temporaryFixture();
    await writeFile(join(root, "source.txt"), "prepared\n");
    await mkdir(join(root, "directory"));
    const artifact = {
      id: "example.source",
      relativePath: "prepared.txt",
      sourceRef: "source",
      sha256: inlineArtifact().sha256,
    };
    const url = refusal.url.startsWith("https:")
      ? refusal.url
      : pathToFileURL(join(root, refusal.url)).href;
    expect(
      prepareArtifacts([artifact], [], {
        root: join(root, refusal.root),
        refs: { source: url },
      }),
    ).rejects.toThrow(refusal.diagnostic);
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("prepared\n");
  });
}

test("refuses a preparation declaration with both inline bytes and a mapped source", async () => {
  const root = await temporaryFixture();
  await writeFile(join(root, "source.txt"), "prepared\n");
  const declaration = { ...inlineArtifact(), sourceRef: "source" };
  expect(
    prepareArtifacts([declaration], [], {
      root,
      refs: { source: pathToFileURL(join(root, "source.txt")).href },
    }),
  ).rejects.toThrow("two content sources");
});

test("refuses a regular file as an artifact parent without replacing its bytes", async () => {
  const root = await temporaryFixture();
  await writeFile(join(root, "assets"), "existing content");
  expect(safePreparationTarget(root, "assets/prepared.txt")).rejects.toThrow(
    "non-directory",
  );
  expect(await readFile(join(root, "assets"), "utf8")).toBe("existing content");
});

const generatedBaseline = {
  kind: "generated",
  commits: [{ message: "Baseline", files: { "README.md": "baseline" } }],
};

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
const invalidGenerated: { name: string; value: unknown }[] = [
  { name: "a scalar instead of a declaration", value: null },
  {
    name: "an undeclared top-level property",
    value: { ...generatedBaseline, unsupported: true },
  },
  {
    name: "non-string overlay bytes",
    value: { ...generatedBaseline, files: { "file.txt": 1 } },
  },
  {
    name: "non-array staged paths",
    value: { ...generatedBaseline, staged: "README.md" },
  },
  {
    name: "non-boolean commitFiles",
    value: { ...generatedBaseline, commitFiles: "yes" },
  },
  {
    name: "a non-array commit list",
    value: { ...generatedBaseline, commits: {} },
  },
  {
    name: "a non-object commit",
    value: { ...generatedBaseline, commits: [null] },
  },
  {
    name: "an undeclared commit property",
    value: {
      ...generatedBaseline,
      commits: [
        {
          message: "Baseline",
          files: { "file.txt": "ready" },
          unsupported: true,
        },
      ],
    },
  },
  {
    name: "a blank commit message",
    value: {
      ...generatedBaseline,
      commits: [{ message: " \n", files: { "file.txt": "ready" } }],
    },
  },
  {
    name: "an empty commit file map",
    value: {
      ...generatedBaseline,
      commits: [{ message: "Baseline", files: {} }],
    },
  },
  {
    name: "non-string commit bytes",
    value: {
      ...generatedBaseline,
      commits: [{ message: "Baseline", files: { "file.txt": false } }],
    },
  },
  {
    name: "case-colliding overlay files",
    value: {
      ...generatedBaseline,
      files: { "Notes.txt": "first", "notes.txt": "second" },
    },
  },
];

for (const invalid of invalidGenerated) {
  test(`generated fixture declarations refuse ${invalid.name}`, () => {
    expect(prepareGeneratedFixture(generatedBaseline).commits).toHaveLength(1);
    expect(() => prepareGeneratedFixture(invalid.value)).toThrow();
  });
}

const repositoryBaseline = {
  kind: "repository",
  sourceRef: "source",
  files: { "notes.txt": "notes" },
};
const invalidRepository: { name: string; value: unknown }[] = [
  { name: "an array instead of a declaration", value: [] },
  {
    name: "an undeclared property",
    value: { ...repositoryBaseline, unsupported: true },
  },
  {
    name: "a non-string overlay",
    value: { ...repositoryBaseline, files: { "notes.txt": false } },
  },
  {
    name: "non-array staged paths",
    value: { ...repositoryBaseline, staged: {} },
  },
  {
    name: "non-boolean commitFiles",
    value: { ...repositoryBaseline, commitFiles: 1 },
  },
  {
    name: "a parent-child overlay collision",
    value: {
      ...repositoryBaseline,
      files: { assets: "file", "assets/notes.txt": "child" },
    },
  },
  {
    name: "duplicate staged paths",
    value: { ...repositoryBaseline, staged: ["notes.txt", "notes.txt"] },
  },
  {
    name: "committed scaffolding without files",
    value: { kind: "repository", sourceRef: "source", commitFiles: true },
  },
];
for (const invalid of invalidRepository) {
  test(`repository fixture declarations refuse ${invalid.name}`, () => {
    expect(prepareRepositoryFixture(repositoryBaseline).sourceRef).toBe(
      "source",
    );
    expect(() => prepareRepositoryFixture(invalid.value)).toThrow();
  });
}

test.each(["generated", "repository"])(
  "serialized %s fixture declarations refuse nonobject hook and executable maps",
  (kind) => {
    const baseline =
      kind === "generated" ? generatedBaseline : repositoryBaseline;
    const prepare =
      kind === "generated" ? prepareGeneratedFixture : prepareRepositoryFixture;
    expect(() => prepare({ ...baseline, hooks: [] })).toThrow(
      "invalid fixture hooks",
    );
    expect(() => prepare({ ...baseline, bin: null })).toThrow(
      "invalid fixture binaries",
    );
  },
);

test("repository declarations bound overlay count and total UTF-8 bytes", () => {
  const files = Object.fromEntries(
    Array.from({ length: 1024 }, (_, index) => [`file-${index}.txt`, "ready"]),
  );
  expect(
    Object.keys(
      prepareRepositoryFixture({ ...repositoryBaseline, files }).files ?? {},
    ),
  ).toHaveLength(1024);
  expect(() =>
    prepareRepositoryFixture({
      ...repositoryBaseline,
      files: { ...files, "extra.txt": "ready" },
    }),
  ).toThrow("repository fixture exceeds the file limit");
  expect(() =>
    prepareRepositoryFixture({
      ...repositoryBaseline,
      files: { "data.txt": "x".repeat(32 * 1024 * 1024) },
    }),
  ).toThrow("repository fixture exceeds the size limit");
});

test("generated declarations bound all history file entries and total UTF-8 bytes", () => {
  const files = Object.fromEntries(
    Array.from({ length: 1024 }, (_, index) => [`file-${index}.txt`, "ready"]),
  );
  expect(
    prepareGeneratedFixture({
      kind: "generated",
      commits: [{ message: "Baseline", files }],
    }).commits,
  ).toHaveLength(1);
  expect(() =>
    prepareGeneratedFixture({
      kind: "generated",
      commits: [{ message: "Baseline", files }],
      files: { "extra.txt": "ready" },
    }),
  ).toThrow("generated fixture exceeds the size limit");
  expect(() =>
    prepareGeneratedFixture({
      kind: "generated",
      commits: [
        {
          message: "Baseline",
          files: { "data.txt": "x".repeat(32 * 1024 * 1024) },
        },
      ],
    }),
  ).toThrow("generated fixture exceeds the size limit");
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

test("blind advisory review copies contained untracked symlinks and nested files without sharing source bytes", async () => {
  const source = await repositoryFixture();
  await mkdir(join(source.repository, "nested"));
  await writeFile(
    join(source.repository, "nested", "new.txt"),
    "candidate change\n",
  );
  await symlink("../README.md", join(source.repository, "nested", "shortcut"));
  const view = await buildBlindAdvisoryFixture(source.repository, {
    baseRevision: source.revision,
  });
  retainTemporaryFixture(view);
  expect(await realpath(view)).toBe(view);
  expect(await readlink(join(view, "nested", "shortcut"))).toBe("../README.md");
  expect(await readFile(join(view, "nested", "shortcut"), "utf8")).toBe(
    "baseline\n",
  );
  expect(await readFile(join(view, "nested", "new.txt"), "utf8")).toBe(
    "candidate change\n",
  );
  expect((await lstat(join(view, "nested", "new.txt"))).ino).not.toBe(
    (await lstat(join(source.repository, "nested", "new.txt"))).ino,
  );
  await writeFile(join(view, "nested", "new.txt"), "reviewer edit\n");
  expect(
    await readFile(join(source.repository, "nested", "new.txt"), "utf8"),
  ).toBe("candidate change\n");
  expect(await fixtureGit(view, "remote")).toBe("");
});

for (const tracked of [false, true]) {
  test(`blind advisory review refuses a ${tracked ? "tracked" : "untracked"} broken symlink`, async () => {
    const source = await repositoryFixture();
    await symlink("missing-target", join(source.repository, "broken"));
    if (tracked) {
      await fixtureGit(source.repository, "add", "broken");
      await fixtureGit(
        source.repository,
        "commit",
        "--quiet",
        "-m",
        "Broken link fixture",
      );
    }
    const revision = await fixtureGit(source.repository, "rev-parse", "HEAD");
    expect(
      buildBlindAdvisoryFixture(source.repository, { baseRevision: revision }),
    ).rejects.toThrow("broken symlink");
    expect(await readlink(join(source.repository, "broken"))).toBe(
      "missing-target",
    );
  });
}

test("blind advisory review requires an immutable base revision rather than a moving ref", async () => {
  const source = await repositoryFixture();
  expect(
    buildBlindAdvisoryFixture(source.repository, { baseRevision: "HEAD" }),
  ).rejects.toThrow("invalid advisory fixture source");
  expect(await fixtureGit(source.repository, "rev-parse", "HEAD")).toBe(
    source.revision,
  );
});

test("blind advisory review refuses an absolute symlink back to the source checkout", async () => {
  const source = await repositoryFixture();
  const original = join(source.repository, "README.md");
  await symlink(original, join(source.repository, "absolute-link"));
  expect(
    buildBlindAdvisoryFixture(source.repository, {
      baseRevision: source.revision,
    }),
  ).rejects.toThrow("escaping symlink");
  expect(await readlink(join(source.repository, "absolute-link"))).toBe(
    original,
  );
  expect(await readFile(original, "utf8")).toBe("baseline\n");
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

test("repository source resolution refuses real submodules without modifying the source", async () => {
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
    "commit",
    "--quiet",
    "-m",
    "Add fixture dependency",
  );
  const revision = await fixtureGit(source.repository, "rev-parse", "HEAD");
  const sources = {
    root: join(source.root, "sources"),
    refs: { source: pathToFileURL(source.repository).href },
  };
  expect(resolveRepositorySource("source", sources)).rejects.toThrow(
    "submodules are not supported",
  );
  expect(await fixtureGit(source.repository, "rev-parse", "HEAD")).toBe(
    revision,
  );
  expect(await fixtureGit(source.repository, "status", "--porcelain")).toBe("");
});

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

test("unborn Git repositories retain unknown project provenance rather than inventing a revision", async () => {
  const root = await temporaryFixture();
  await fixtureGit(root, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(root, "README.md"), "uncommitted content\n");
  const provenance = await projectProvenance(root);
  expect(provenance.revision).toBeNull();
  expect(provenance.dirtyPatchDigest).toBeNull();
  expect(await projectIdentityDigest(root, provenance)).toMatch(
    /^[a-f0-9]{64}$/,
  );
});

test("checkout provenance refuses a nested directory in place of the explicit Git root", async () => {
  const source = await repositoryFixture();
  await mkdir(join(source.repository, "nested"));
  const provenance = await checkoutProvenance(
    source.repository,
    "a".repeat(64),
  );
  expect(provenance.revision).toBe(source.revision);
  expect(
    checkoutProvenance(join(source.repository, "nested"), "a".repeat(64)),
  ).rejects.toThrow("checkout root does not match its Git repository");
});

test("non-Git project identity ignores relocation and timestamps but distinguishes executable content", async () => {
  const first = await temporaryFixture();
  const second = await temporaryFixture();
  await writeFile(join(first, "tool.sh"), "#!/bin/sh\necho ready\n", {
    mode: 0o600,
  });
  await writeFile(join(second, "tool.sh"), "#!/bin/sh\necho ready\n", {
    mode: 0o600,
  });
  const unknownGit = { revision: null, dirtyPatchDigest: null };
  const digest = await projectIdentityDigest(first, unknownGit);
  await utimes(
    join(second, "tool.sh"),
    new Date("2000-01-01T00:00:00Z"),
    new Date("2030-01-01T00:00:00Z"),
  );
  expect(await projectIdentityDigest(second, unknownGit)).toBe(digest);
  await chmod(join(second, "tool.sh"), 0o700);
  expect(await projectIdentityDigest(second, unknownGit)).not.toBe(digest);
  expect(await readFile(join(second, "tool.sh"), "utf8")).toBe(
    await readFile(join(first, "tool.sh"), "utf8"),
  );
});

async function packagedFixture(reverse: boolean): Promise<string> {
  const root = await temporaryFixture();
  for (const directory of ["docs", "examples", "schemas", "src"])
    await mkdir(join(root, directory));
  const paths = [
    "package.json",
    "README.md",
    "docs/spec.md",
    "examples/basic.json",
    "schemas/evidence.json",
    "src/first.ts",
    "src/second.ts",
  ];
  for (const path of reverse ? [...paths].reverse() : paths)
    await writeFile(join(root, path), `${path}\n`);
  return root;
}

test("package build identity uses declared runtime paths independent of filesystem insertion order and unrelated files", async () => {
  const first = await packagedFixture(false);
  const second = await packagedFixture(true);
  const digest = await packageBuildDigest(first);
  expect(await packageBuildDigest(second)).toBe(digest);
  await writeFile(join(second, "outside-runtime.txt"), "unrelated file\n");
  expect(await packageBuildDigest(second)).toBe(digest);
});
