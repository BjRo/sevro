import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  ExtensionProtocolError,
  exchangeExtension,
  negotiateExtension,
  type ExtensionRequest,
} from "../src/extension-client";

const fixture = join(import.meta.dir, "fixtures", "extension.ts");
const request: ExtensionRequest = {
  protocol: "sevro.discovery.v1",
  id: "request-1",
  method: "describe",
  params: {
    protocols: ["sevro.extension.v1"],
    engineCapabilities: ["sevro.host.exec"],
    hostCapabilities: [],
  },
};
const command = (scenario = "echo") => [process.execPath, fixture, scenario];

test("exchanges one validated message with a fresh extension process", async () => {
  const response = await exchangeExtension(command(), request);
  expect(response.result).toMatchObject({
    extension: { id: "example.extension" },
  });
  expect(response.id).toBe(request.id);
});

test("rejects malformed, oversized, and mismatched responses", async () => {
  for (const scenario of ["malformed", "oversized", "wrong-id", "nonzero"])
    await expect(
      exchangeExtension(command(scenario), request),
    ).rejects.toBeInstanceOf(ExtensionProtocolError);
});

test("stops a timed out extension and excludes its private stderr", async () => {
  await expect(
    exchangeExtension(command("wait"), request, { timeoutMs: 100 }),
  ).rejects.toThrow(/timed out/);
  await expect(
    exchangeExtension(command("nonzero"), request),
  ).rejects.not.toThrow(/private diagnostic/);
});

test("cancels an in-flight extension request", async () => {
  const controller = new AbortController();
  const pending = exchangeExtension(command("wait"), request, {
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toThrow(/cancelled/);
});

test("negotiates required capabilities and ignores unsupported optional ones", async () => {
  const selected = await negotiateExtension(command(), {
    engineCapabilities: ["sevro.host.exec"],
    hostCapabilities: [],
  });
  expect(selected.protocol).toBe("sevro.extension.v1");
  expect(selected.capabilities).toEqual(["sevro.host.exec"]);
  await expect(
    negotiateExtension(command(), {
      engineCapabilities: [],
      hostCapabilities: [],
    }),
  ).rejects.toThrow(/required capability/);
});
