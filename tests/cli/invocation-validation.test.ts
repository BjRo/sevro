import { defined } from "../fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  extensionSource,
  digest,
  fixtureExtensionCommand,
  invoke,
} from "../fixtures/cli-fixtures";
import { createFixture } from "../fixtures/cli-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixture = createFixture(roots);

test("CLI reports invalid invocation as versioned JSON without a run", async () => {
  const { args, caseFile } = await fixture();
  const invalid = await invoke(
    args.map((arg) => (arg === caseFile ? join(caseFile, "missing") : arg)),
  );
  expect(invalid.code).toBe(64);
  expect(invalid.result).toMatchObject({
    format: "sevro.cli-result.v1",
    execution: { status: "not_run" },
    grading: { status: "not_requested" },
    task: { verdict: "not_assessed" },
    exitCode: 64,
    evidencePath: null,
    cases: [],
  });
  const badDigest = await invoke(
    args.map((arg) => (arg === digest ? "invalid-digest" : arg)),
  );
  expect(badDigest.code).toBe(64);
  expect(badDigest.result.evidencePath).toBeNull();
});

const invalidExternalFlags: {
  name: string;
  extension: boolean;
  flags: string[];
  diagnostic: RegExp;
}[] = [
  {
    name: "Codex timeout without a Codex host route",
    extension: false,
    flags: ["--codex-timeout-ms", "1200000"],
    diagnostic: /Codex options require a Codex host route/,
  },
  {
    name: "unknown flag",
    extension: false,
    flags: ["--unknown-sevro-option"],
    diagnostic: /invalid CLI arguments/,
  },
  {
    name: "missing option value",
    extension: false,
    flags: ["--results-root"],
    diagnostic: /invalid CLI arguments/,
  },
  {
    name: "extra positional command",
    extension: false,
    flags: ["extra-command"],
    diagnostic: /expected the run command/,
  },
  {
    name: "missing extension source closure",
    extension: true,
    flags: [],
    diagnostic: /missing --extension-source-file/,
  },
  {
    name: "relative extension source",
    extension: true,
    flags: ["--extension-source-file", "relative-extension.ts"],
    diagnostic: /--extension-source-file must be absolute/,
  },
  {
    name: "private configuration without redacted file",
    extension: true,
    flags: [
      "--extension-source-file",
      "SOURCE",
      "--extension-configuration-file",
      "CONFIG",
    ],
    diagnostic: /extension configuration requires a redacted file/,
  },
  {
    name: "redacted configuration without private file",
    extension: true,
    flags: [
      "--extension-source-file",
      "SOURCE",
      "--extension-redacted-configuration-file",
      "CONFIG",
    ],
    diagnostic: /extension configuration requires a redacted file/,
  },
];

test.each(invalidExternalFlags.map((entry) => [entry.name, entry] as const))(
  "CLI refuses %s before run admission",
  async (_name, entry) => {
    const { args, caseFile } = await fixture();
    const commandFile = join(dirname(caseFile), "extension-command.json");
    const configuration = join(dirname(caseFile), "configuration.json");
    await writeFile(
      commandFile,
      JSON.stringify(fixtureExtensionCommand(extensionSource, "lifecycle")),
    );
    await writeFile(configuration, "{}");
    const files: Record<string, string> = {
      SOURCE: extensionSource,
      CONFIG: configuration,
    };
    const base = entry.extension
      ? args.filter((arg) => arg !== "--case-file" && arg !== caseFile)
      : args;
    const declaration = entry.extension
      ? ["--extension-command-file", commandFile, "--case-id", "extension-case"]
      : [];
    const invalid = await invoke([
      ...base,
      ...declaration,
      ...entry.flags.map((arg) => files[arg] ?? arg),
    ]);
    expect(invalid.code).toBe(64);
    expect(defined(invalid.result.diagnostic).message).toMatch(
      entry.diagnostic,
    );
    expect(invalid.result).toMatchObject({
      execution: { status: "not_run" },
      grading: { status: "not_requested" },
      task: { verdict: "not_assessed" },
      exitCode: 64,
      evidencePath: null,
      cases: [],
    });
  },
);
