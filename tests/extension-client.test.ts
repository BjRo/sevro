import { expectUnknown } from "./fixtures/assertions";
import { test, expect } from "bun:test";
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
test("rejects malformed, oversized, and mismatched responses", () => {
  for (const scenario of ["malformed", "oversized", "wrong-id", "nonzero"])
    expect(
      exchangeExtension(command(scenario), request),
    ).rejects.toBeInstanceOf(ExtensionProtocolError);
});

test.each(["wrong-protocol", "id-array", "result-array", "null-root"])(
  "rejects ordinary JSON response with %s before returning a result",
  async (scenario) => {
    expect(await exchangeExtension(command(), request)).toHaveProperty(
      "result",
    );
    expect(exchangeExtension(command(scenario), request)).rejects.toThrow(
      "invalid extension response",
    );
  },
);

test("prepare transport accepts a maximum-length data key and refuses an overlong key", async () => {
  const preparationRequest: ExtensionRequest = {
    protocol: "sevro.extension.v1",
    id: "request-1",
    method: "prepare",
    params: {
      case: {
        id: "case-1",
        prompt: "Return ready",
        fixture: { kind: "inline", files: {} },
        checks: [],
        requiredEvidence: [],
        extensionData: {},
      },
      host: { id: "example.host", capabilities: [] },
      condition: "passive",
      configuration: {},
    },
  };
  const response = await exchangeExtension(
    command("prepare-key128"),
    preparationRequest,
  );
  expectUnknown(response.result.extensionData).toEqual({
    ["example." + "a".repeat(120)]: null,
  });
  expect(
    exchangeExtension(command("prepare-key129"), preparationRequest),
  ).rejects.toThrow("invalid extension response");
});
test("rejects a request envelope returned as an extension response", () => {
  const response = exchangeExtension(
    [process.execPath, "-e", "process.stdout.write(await Bun.stdin.text())"],
    request,
  );
  expect(response).rejects.toBeInstanceOf(ExtensionProtocolError);
  expect(response).rejects.toThrow("invalid extension response");
});
test("stops a timed out extension and excludes its private stderr", () => {
  expect(
    exchangeExtension(command("wait"), request, { timeoutMs: 100 }),
  ).rejects.toThrow(/timed out/);
  expect(exchangeExtension(command("nonzero"), request)).rejects.not.toThrow(
    /private diagnostic/,
  );
});
test("cancels an in-flight extension request", () => {
  const controller = new AbortController();
  const pending = exchangeExtension(command("wait"), request, {
    signal: controller.signal,
  });
  controller.abort();
  expect(pending).rejects.toThrow(/cancelled/);
});
test("negotiates required capabilities and ignores unsupported optional ones", async () => {
  const selected = await negotiateExtension(command(), {
    engineCapabilities: ["sevro.host.exec"],
    hostCapabilities: [],
  });
  expect(selected.protocol).toBe("sevro.extension.v1");
  expectUnknown(selected.capabilities).toEqual(["sevro.host.exec"]);
  expect(
    negotiateExtension(command(), {
      engineCapabilities: [],
      hostCapabilities: [],
    }),
  ).rejects.toThrow(/required capability/);
});
