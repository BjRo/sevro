import { expectUnknown } from "./fixtures/assertions";
import { defined } from "./fixtures/assertions";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "bun:test";
import {
  prepareArtifacts,
  prepareInlineArtifacts,
  safePreparationTarget,
} from "../src/preparation";
const content = Buffer.from("prepared data\n");
const artifact = {
  id: "generated-file",
  relativePath: "generated/data.txt",
  sha256: createHash("sha256").update(content).digest("hex"),
  contentBase64: content.toString("base64"),
};
test("preparation validates bytes, digest, and portable path containment", () => {
  expectUnknown(
    defined(prepareInlineArtifacts([artifact], ["README.md"])[0]).bytes,
  ).toEqual(content);
  expect(() =>
    prepareInlineArtifacts([{ ...artifact, relativePath: "../outside" }], []),
  ).toThrow(/invalid fixture path/);
  expect(() =>
    prepareInlineArtifacts(
      [{ ...artifact, relativePath: "README.md" }],
      ["README.md"],
    ),
  ).toThrow(/paths collide/);
  expect(() =>
    prepareInlineArtifacts(
      [{ ...artifact, relativePath: "generated" }],
      ["generated/file.txt"],
    ),
  ).toThrow(/paths collide/);
  expect(() =>
    prepareInlineArtifacts([{ ...artifact, contentBase64: "not base64" }], []),
  ).toThrow(/canonical base64/);
  expect(() =>
    prepareInlineArtifacts([{ ...artifact, sourceRef: "source-1" }], []),
  ).toThrow(/source references/);
  expect(() =>
    prepareInlineArtifacts([{ ...artifact, sha256: "a".repeat(64) }], []),
  ).toThrow(/digest/);
  expect(
    defined(prepareInlineArtifacts([{ ...artifact, gitExclude: true }], [])[0])
      .gitExclude,
  ).toBeTrue();
  expect(() =>
    prepareInlineArtifacts([{ ...artifact, gitExclude: "yes" as never }], []),
  ).toThrow(/gitExclude/);
  expect(
    defined(prepareInlineArtifacts([{ ...artifact, executable: true }], [])[0])
      .executable,
  ).toBeTrue();
  expect(() =>
    prepareInlineArtifacts([{ ...artifact, executable: "yes" as never }], []),
  ).toThrow(/executable/);
  expect(() =>
    prepareInlineArtifacts(
      [{ ...artifact, relativePath: "generated/bad\npath", gitExclude: true }],
      [],
    ),
  ).toThrow(/control characters/);
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("source references resolve only from the declared case source map", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-source-artifact-"));
  const sourceRoot = join(root, "sources");
  const outside = join(root, "outside.txt");
  try {
    await Bun.write(join(sourceRoot, "inside.txt"), content);
    await writeFile(outside, content);
    await symlink(outside, join(sourceRoot, "escape.txt"));
    const declaration = {
      id: artifact.id,
      relativePath: artifact.relativePath,
      sha256: artifact.sha256,
      sourceRef: "input-data",
    };
    const sources = {
      root: sourceRoot,
      refs: {
        "input-data": pathToFileURL(join(sourceRoot, "inside.txt")).href,
      },
    };
    expectUnknown(
      defined((await prepareArtifacts([declaration], [], sources))[0]).bytes,
    ).toEqual(content);
    expect(
      defined(
        (
          await prepareArtifacts(
            [{ ...declaration, gitExclude: true }],
            [],
            sources,
          )
        )[0],
      ).gitExclude,
    ).toBeTrue();
    expect(
      defined(
        (
          await prepareArtifacts(
            [{ ...declaration, executable: true }],
            [],
            sources,
          )
        )[0],
      ).executable,
    ).toBeTrue();
    expect(
      prepareArtifacts(
        [{ ...declaration, gitExclude: "yes" as never }],
        [],
        sources,
      ),
    ).rejects.toThrow(/gitExclude/);
    expect(prepareArtifacts([declaration], [])).rejects.toThrow(/source root/);
    expect(
      prepareArtifacts([declaration], [], { root: sourceRoot, refs: {} }),
    ).rejects.toThrow(/not declared/);
    expect(
      prepareArtifacts([declaration], [], {
        root: sourceRoot,
        refs: { "input-data": pathToFileURL(outside).href },
      }),
    ).rejects.toThrow(/escapes/);
    expect(
      prepareArtifacts([declaration], [], {
        root: sourceRoot,
        refs: {
          "input-data": pathToFileURL(join(sourceRoot, "escape.txt")).href,
        },
      }),
    ).rejects.toThrow(/escapes/);
    expect(
      prepareArtifacts(
        [{ ...declaration, sha256: "a".repeat(64) }],
        [],
        sources,
      ),
    ).rejects.toThrow(/digest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("preparation artifacts cannot follow fixture symlinks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "sevro-artifact-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "sevro-artifact-outside-"));
  try {
    await symlink(outside, join(workspace, "linked"));
    expect(
      safePreparationTarget(workspace, "linked/skills/example/SKILL.md"),
    ).rejects.toThrow(/non-directory/);
    expectUnknown(await readdir(outside)).toEqual([]);
    await mkdir(join(workspace, "skills"));
    await symlink(
      join(outside, "missing"),
      join(workspace, "skills", "SKILL.md"),
    );
    expect(safePreparationTarget(workspace, "skills/SKILL.md")).rejects.toThrow(
      /already exists/,
    );
    expect(
      safePreparationTarget(workspace, "skills/new/SKILL.md"),
    ).resolves.toBe(join(workspace, "skills", "new", "SKILL.md"));
    expectUnknown(await readdir(outside)).toEqual([]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
