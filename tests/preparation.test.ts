import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { prepareInlineArtifacts } from "../src/preparation";

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
