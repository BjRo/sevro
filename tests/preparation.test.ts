import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";
import { prepareArtifacts, prepareInlineArtifacts } from "../src/preparation";

const content = Buffer.from("prepared data\n");
const artifact = {
  id: "generated-file",
  relativePath: "generated/data.txt",
  sha256: createHash("sha256").update(content).digest("hex"),
  contentBase64: content.toString("base64"),
};

test("preparation validates bytes, digest, and portable path containment", () => {
  expect(prepareInlineArtifacts([artifact], ["README.md"])[0]?.bytes).toEqual(
    content,
  );
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
});

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
      refs: { "input-data": pathToFileURL(join(sourceRoot, "inside.txt")).href },
    };
    expect((await prepareArtifacts([declaration], [], sources))[0]?.bytes).toEqual(
      content,
    );
    await expect(prepareArtifacts([declaration], [])).rejects.toThrow(/source root/);
    await expect(
      prepareArtifacts([declaration], [], { root: sourceRoot, refs: {} }),
    ).rejects.toThrow(/not declared/);
    await expect(
      prepareArtifacts([declaration], [], {
        root: sourceRoot,
        refs: { "input-data": pathToFileURL(outside).href },
      }),
    ).rejects.toThrow(/escapes/);
    await expect(
      prepareArtifacts([declaration], [], {
        root: sourceRoot,
        refs: {
          "input-data": pathToFileURL(join(sourceRoot, "escape.txt")).href,
        },
      }),
    ).rejects.toThrow(/escapes/);
    await expect(
      prepareArtifacts([{ ...declaration, sha256: "a".repeat(64) }], [], sources),
    ).rejects.toThrow(/digest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
