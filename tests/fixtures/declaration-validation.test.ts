import { expect, test } from "bun:test";
import { prepareGeneratedFixture } from "../../src/fixtures/generated";
import { prepareRepositoryFixture } from "../../src/fixtures/repository";

import { generatedBaseline } from "./preparation-fixtures";

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
