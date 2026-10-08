import { expectUnknown } from "./fixtures/assertions";
import { defined } from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExtensionSession } from "../src/extension-session";
import { extensionFixtureCommand } from "./fixtures/extension-command";
const source = join(import.meta.dir, "fixtures", "extension.ts");
const roots: string[] = [];
const extensionCommand = extensionFixtureCommand();
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
test("negotiates and runs resolve, prepare, and evaluate in separate processes", async () => {
  const session = await openExtensionSession({
    command: extensionCommand(source, "lifecycle"),
    sourceFiles: [source],
    configuration: {},
    redactedConfiguration: {},
    engineCapabilities: ["sevro.host.exec"],
    hostCapabilities: [],
  });
  expect(session.identity.protocol).toBe("sevro.extension.v1");
  expect(session.identity.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  const [resolved] = await session.resolve("file:///tmp/project", {});
  expect(resolved?.id).toBe("extension-case");
  const prepared = await session.prepare(
    defined(resolved),
    { id: "sevro.host.synthetic", capabilities: [] },
    "passive",
  );
  expectUnknown(prepared.extensionData).toEqual({
    "example.extension": { marker: "prepared" },
  });
  const graded = await session.evaluate({
    caseId: defined(resolved).id,
    execution: { status: "completed" },
    observations: [
      {
        id: "sevro.observation.final-message",
        source: "sevro.host.synthetic",
        completeness: "complete",
        data: { sha256: "a".repeat(64) },
      },
    ],
    builtinChecks: [],
    artifacts: [],
    extensionData: prepared.extensionData,
  });
  expectUnknown(graded.checks).toEqual([
    {
      id: "example.extension.ready",
      status: "passed",
      evidenceRefs: ["sevro.observation.final-message"],
    },
  ]);
});
test("refuses a changed extension source during the same session", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-extension-source-"));
  roots.push(root);
  const copied = join(root, "extension.ts");
  await copyFile(source, copied);
  const session = await openExtensionSession({
    command: extensionCommand(copied, "lifecycle"),
    sourceFiles: [copied],
    configuration: {},
    redactedConfiguration: {},
    engineCapabilities: ["sevro.host.exec"],
    hostCapabilities: [],
  });
  await writeFile(copied, "// changed\n");
  expect(session.resolve("file:///tmp/project", {})).rejects.toThrow(
    /source changed/,
  );
});
test("command arguments affect identity and passed checks need evidence", async () => {
  const base = {
    sourceFiles: [source],
    configuration: {},
    redactedConfiguration: {},
    engineCapabilities: ["sevro.host.exec"],
    hostCapabilities: [],
  };
  const normal = await openExtensionSession({
    ...base,
    command: extensionCommand(source, "lifecycle"),
  });
  const altered = await openExtensionSession({
    ...base,
    command: extensionCommand(source, "lifecycle-empty-evidence"),
  });
  expect(altered.identity.configurationDigest).not.toBe(
    normal.identity.configurationDigest,
  );
  const request = {
    caseId: "extension-case",
    execution: { status: "completed" as const },
    observations: [],
    builtinChecks: [],
    artifacts: [],
    extensionData: {},
  };
  expect(altered.evaluate(request)).rejects.toThrow(
    /invalid extension response/,
  );
  expect(normal.evaluate(request)).rejects.toThrow(/unknown evidence/);
});
