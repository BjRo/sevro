import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  prepareArtifacts,
  prepareInlineArtifacts,
  safePreparationTarget,
} from "../../../src/fixtures/preparation";
import { defined } from "../../fixtures/assertions";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import { inlineArtifact } from "../../fixtures/preparation-fixtures";

const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

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
