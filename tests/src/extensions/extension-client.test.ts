import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExtensionSession } from "../../../src/extensions/index";
import { expectUnknown } from "../../fixtures/assertions";
import { wireCase, wireOptions } from "../../fixtures/engine-session";

type SessionOptions = Parameters<typeof openExtensionSession>[0];

const fixture = join(import.meta.dir, "../../fixtures/extension.ts");
const command = (scenario = "echo") => [process.execPath, fixture, scenario];

function options(
  scenario = "echo",
  overrides: Partial<SessionOptions> = {},
): SessionOptions {
  return {
    command: command(scenario),
    sourceFiles: [fixture],
    configuration: {},
    redactedConfiguration: {},
    engineCapabilities: ["sevro.host.exec"],
    hostCapabilities: [],
    ...overrides,
  };
}

test("discovers a validated identity from a fresh extension process", async () => {
  const session = await openExtensionSession(options());
  expect(session.identity).toMatchObject({
    id: "example.extension",
    version: "1.0.0",
    protocol: "sevro.extension.v1",
  });
});

test.each([
  ["malformed", "extension did not return one UTF-8 JSON response"],
  ["wrong-id", "extension response does not match request"],
  ["nonzero", "extension exited with code 7"],
])("rejects a %s discovery response", (scenario, diagnostic) => {
  expect(openExtensionSession(options(scenario))).rejects.toThrow(diagnostic);
});

test("rejects an oversized discovery response", () => {
  const oversized = `await Bun.stdin.text(); await Bun.write(Bun.stdout, "x".repeat(${8 * 1024 * 1024 + 1}));`;
  expect(
    openExtensionSession({
      ...options(),
      command: [process.execPath, "-e", oversized],
    }),
  ).rejects.toThrow("extension message exceeds 8 MiB");
});

test.each(["wrong-protocol", "id-array", "result-array", "null-root"])(
  "rejects ordinary JSON response with %s before returning a result",
  async (scenario) => {
    expect((await openExtensionSession(options())).identity.id).toBe(
      "example.extension",
    );
    expect(openExtensionSession(options(scenario))).rejects.toThrow(
      "invalid extension response",
    );
  },
);

test("prepare transport accepts a maximum-length data key and refuses an overlong key", async () => {
  const preparation = (suffixLength: number) =>
    openExtensionSession(
      wireOptions({
        prepare: {
          artifacts: [],
          requestedInstrumentation: [],
          extensionData: { ["example." + "a".repeat(suffixLength)]: null },
        },
      }),
    );
  const host = { id: "example.host", capabilities: [] };
  const accepted = await (
    await preparation(120)
  ).prepare(wireCase, host, "passive");
  expectUnknown(accepted.extensionData).toEqual({
    ["example." + "a".repeat(120)]: null,
  });
  const overlong = await preparation(121);
  expect(overlong.prepare(wireCase, host, "passive")).rejects.toThrow(
    "invalid extension response",
  );
});

test("rejects a request envelope returned as an extension response", () => {
  expect(
    openExtensionSession({
      ...options(),
      command: [
        process.execPath,
        "-e",
        "process.stdout.write(await Bun.stdin.text())",
      ],
    }),
  ).rejects.toThrow("invalid extension response");
});

test("stops a timed out extension and excludes its private stderr", async () => {
  const timedOut = openExtensionSession(options("wait", { timeoutMs: 100 }));
  expect(timedOut).rejects.toThrow(/timed out/);
  const failed = openExtensionSession(options("nonzero"));
  expect(failed).rejects.toThrow("extension exited with code 7");
  expect(failed).rejects.not.toThrow(/private diagnostic/);
  await Promise.allSettled([timedOut, failed]);
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

test("cancels an in-flight extension request", async () => {
  const started = join(
    tmpdir(),
    `sevro-extension-started-${crypto.randomUUID()}`,
  );
  const controller = new AbortController();
  const pending = openExtensionSession({
    ...options(),
    command: [
      process.execPath,
      "-e",
      `await Bun.write(${JSON.stringify(started)}, "started"); await Bun.sleep(5000);`,
    ],
    signal: controller.signal,
  });
  await waitForFile(started);
  await Bun.file(started).delete();
  controller.abort();
  expect(pending).rejects.toThrow(/cancelled/);
  await pending.catch(() => undefined);
});

test("negotiates required capabilities and ignores unsupported optional ones", async () => {
  const session = await openExtensionSession(options());
  expect(session.identity.protocol).toBe("sevro.extension.v1");
  expectUnknown(session.identity.capabilities).toEqual(["sevro.host.exec"]);
  expect(
    openExtensionSession(options("echo", { engineCapabilities: [] })),
  ).rejects.toThrow(/required capability/);
});
