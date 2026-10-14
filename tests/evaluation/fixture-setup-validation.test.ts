import { expect, test } from "bun:test";
import { prepareFixtureSetup } from "../../src/fixtures/setup";

test("fixture setup validation preserves declared argv and environment placeholders without executing them", () => {
  const declaration = {
    command: [process.execPath, "-e", "return-ready"],
    environment: {
      DATA: "{{sevro.workspace}}/input",
      PROJECT: "{{sevro.project}}",
    },
  };
  expect(prepareFixtureSetup(declaration)).toEqual(declaration);
  expect(prepareFixtureSetup({ command: [process.execPath] })).toEqual({
    command: [process.execPath],
    environment: {},
  });
  expect(prepareFixtureSetup(undefined)).toBeNull();
});

const invalidDirectSetup = [
  {
    name: "null declaration",
    value: null,
    diagnostic: "invalid fixture setup",
  },
  { name: "array declaration", value: [], diagnostic: "invalid fixture setup" },
  {
    name: "scalar declaration",
    value: 42,
    diagnostic: "invalid fixture setup",
  },
  {
    name: "empty argv",
    value: { command: [] },
    diagnostic: "invalid fixture setup command",
  },
  {
    name: "nonstring argv item",
    value: { command: [process.execPath, 42] },
    diagnostic: "invalid fixture setup command",
  },
  {
    name: "more than sixteen argv items",
    value: {
      command: [
        process.execPath,
        ...Array.from({ length: 16 }, () => "argument"),
      ],
    },
    diagnostic: "invalid fixture setup command",
  },
  {
    name: "argv above 64 KiB",
    value: { command: [process.execPath, "x".repeat(64 * 1024)] },
    diagnostic: "invalid fixture setup command",
  },
  {
    name: "NUL in argv",
    value: { command: [process.execPath, "\0"] },
    diagnostic: "invalid fixture setup command",
  },
  {
    name: "array environment",
    value: { command: [process.execPath], environment: [] },
    diagnostic: "invalid fixture setup environment",
  },
  {
    name: "scalar environment",
    value: { command: [process.execPath], environment: "environment" },
    diagnostic: "invalid fixture setup environment",
  },
  {
    name: "undeclared top-level field",
    value: { command: [process.execPath], extra: true },
    diagnostic: "unsupported fixture setup field",
  },
  {
    name: "more than thirty-two environment entries",
    value: {
      command: [process.execPath],
      environment: Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`VALUE_${index}`, "x"]),
      ),
    },
    diagnostic: "invalid fixture setup environment",
  },
  {
    name: "environment above 16 KiB",
    value: {
      command: [process.execPath],
      environment: { DATA: "x".repeat(16 * 1024) },
    },
    diagnostic: "invalid fixture setup environment",
  },
  {
    name: "NUL in environment",
    value: { command: [process.execPath], environment: { DATA: "\0" } },
    diagnostic: "invalid fixture setup environment",
  },
];

for (const invalid of invalidDirectSetup) {
  test(`fixture setup validation refuses ${invalid.name} at its unknown-input boundary`, () => {
    expect(() => prepareFixtureSetup(invalid.value)).toThrow(
      invalid.diagnostic,
    );
  });
}
