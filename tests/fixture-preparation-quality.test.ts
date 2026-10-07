import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildBlindAdvisoryFixture } from "../src/advisory-fixture";
import {
  prepareArtifacts,
  prepareInlineArtifacts,
  safePreparationTarget,
  type PreparationArtifact,
} from "../src/preparation";
import { prepareGeneratedFixture } from "../src/generated-fixture";
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
import { defined } from "./fixtures/assertions";
import {
  cleanupTemporaryFixtures,
  fixtureGit,
  repositoryFixture,
  retainTemporaryFixture,
  temporaryFixture,
} from "./quality-fixtures/fixture-preparation-tools";

afterEach(cleanupTemporaryFixtures);

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
  for (const path of reverse ? paths.toReversed() : paths)
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
