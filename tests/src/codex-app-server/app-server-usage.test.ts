import { afterEach, expect, test } from "bun:test";
import { runCodexAppServer } from "../../../src/codex-app-server/index";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import {
  createServerOptions,
  createWorkspace,
} from "../../fixtures/native-host-fixtures";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const serverOptions = createServerOptions(createWorkspace(roots));

test("app-server reports the root thread's cumulative usage without child threads", async () => {
  const result = await runCodexAppServer(await serverOptions("success"));
  expect(result.code, result.evidence.failure).toBe(0);
  expect(result.usage).toEqual({
    inputTokens: 11,
    outputTokens: 7,
    usageComplete: true,
  });
});

test("app-server counts a feedback turn once through the last cumulative total", async () => {
  const options = await serverOptions("success");
  options.request.control = {
    followUpPrompt: "User feedback",
    appServerTimeoutMs: 2000,
  };
  const result = await runCodexAppServer(options);
  expect(result.code, result.evidence.failure).toBe(0);
  expect(result.evidence.clientTurns).toBe(2);
  expect(result.usage).toEqual({
    inputTokens: 22,
    outputTokens: 14,
    usageComplete: true,
  });
});

test("app-server retains a usage total that arrives during settlement", async () => {
  const result = await runCodexAppServer(await serverOptions("late-usage"));
  expect(result.code, result.evidence.failure).toBe(0);
  expect(result.usage).toEqual({
    inputTokens: 50,
    outputTokens: 70,
    usageComplete: true,
  });
});

test("app-server leaves malformed usage unmeasured without failing the run", async () => {
  const result = await runCodexAppServer(
    await serverOptions("malformed-usage"),
  );
  expect(result.code, result.evidence.failure).toBe(0);
  expect(result.finalMessage).toBe("ready\n\ndone");
  expect(result.usage).toEqual({
    inputTokens: null,
    outputTokens: null,
    usageComplete: false,
  });
});

test.each([
  ["failed-turn", 11, 7],
  ["fatal-error", null, null],
] as const)(
  "app-server keeps usage incomplete for an unsuccessful run: %s",
  async (mode, inputTokens, outputTokens) => {
    const result = await runCodexAppServer(await serverOptions(mode));
    expect(result.code).toBe(1);
    expect(result.usage).toEqual({
      inputTokens,
      outputTokens,
      usageComplete: false,
    });
  },
);
