import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  materializeFixture,
  prepareArtifacts,
  prepareFixtureSetup,
} from "../../../src/fixtures/index";
import { defined, expectUnknown } from "../../fixtures/assertions";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const { temporaryFixture, retainTemporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures();
afterEach(cleanupTemporaryFixtures);

const content = Buffer.from("prepared data\n");
const artifact = {
  id: "generated-file",
  relativePath: "generated/data.txt",
  sha256: createHash("sha256").update(content).digest("hex"),
  contentBase64: content.toString("base64"),
};
test("preparation validates bytes, digest, and portable path containment", async () => {
  const prepare = (
    overrides: Record<string, unknown>,
    fixturePaths: string[] = [],
  ) => prepareArtifacts([{ ...artifact, ...overrides }], fixturePaths);
  expectUnknown(defined((await prepare({}, ["README.md"]))[0]).bytes).toEqual(
    content,
  );
  expect(prepare({ relativePath: "../outside" })).rejects.toThrow(
    /invalid fixture path/,
  );
  expect(prepare({ relativePath: "README.md" }, ["README.md"])).rejects.toThrow(
    /paths collide/,
  );
  expect(
    prepare({ relativePath: "generated" }, ["generated/file.txt"]),
  ).rejects.toThrow(/paths collide/);
  expect(prepare({ contentBase64: "not base64" })).rejects.toThrow(
    /canonical base64/,
  );
  expect(prepare({ sha256: "a".repeat(64) })).rejects.toThrow(/digest/);
  expect(
    defined((await prepare({ gitExclude: true }))[0]).gitExclude,
  ).toBeTrue();
  expect(prepare({ gitExclude: "yes" })).rejects.toThrow(/gitExclude/);
  expect(
    defined((await prepare({ executable: true }))[0]).executable,
  ).toBeTrue();
  expect(prepare({ executable: "yes" })).rejects.toThrow(/executable/);
  expect(
    prepare({ relativePath: "generated/bad\npath", gitExclude: true }),
  ).rejects.toThrow(/control characters/);
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("source references resolve only from the declared case source map", async () => {
  const root = await temporaryFixture(join(tmpdir(), "sevro-source-artifact-"));
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
async function fixtureWithSetupLink(
  projectRoot: string,
  target: string,
  link: string,
  relativePath: string,
): Promise<string> {
  const setup = defined(
    prepareFixtureSetup({
      command: [
        process.execPath,
        "-e",
        `const { mkdirSync, symlinkSync } = require("node:fs");
const { dirname } = require("node:path");
mkdirSync(dirname(${JSON.stringify(link)}), { recursive: true });
symlinkSync(${JSON.stringify(target)}, ${JSON.stringify(link)});`,
      ],
    }),
  );
  const workspace = await materializeFixture(
    { kind: "inline", files: {} },
    {
      setup,
      artifacts: await prepareArtifacts([{ ...artifact, relativePath }], []),
      projectRoot,
    },
  );
  retainTemporaryFixture(workspace);
  return workspace;
}

test("preparation artifacts cannot follow setup-created fixture symlinks", async () => {
  const projectRoot = await temporaryFixture(
    join(tmpdir(), "sevro-artifact-project-"),
  );
  const outside = await temporaryFixture(
    join(tmpdir(), "sevro-artifact-outside-"),
  );
  const linkedParent = fixtureWithSetupLink(
    projectRoot,
    outside,
    "linked",
    "linked/skills/example/SKILL.md",
  );
  expect(linkedParent).rejects.toThrow(/non-directory/);
  await linkedParent.catch(() => undefined);
  const existingLink = fixtureWithSetupLink(
    projectRoot,
    join(outside, "missing"),
    "skills/SKILL.md",
    "skills/SKILL.md",
  );
  expect(existingLink).rejects.toThrow(/already exists/);
  await existingLink.catch(() => undefined);
  const workspace = await fixtureWithSetupLink(
    projectRoot,
    join(outside, "missing"),
    "skills/SKILL.md",
    "skills/new/SKILL.md",
  );
  expect(await readFile(join(workspace, "skills", "new", "SKILL.md"))).toEqual(
    content,
  );
  expectUnknown(await readdir(outside)).toEqual([]);
});
