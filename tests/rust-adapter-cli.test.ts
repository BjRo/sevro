import { beforeAll, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  runAdapterScenario,
  runStderrDescriptorScenario,
  runStderrDescendantScenario,
  runForgedMessageScenario,
  runRawMessageScenario,
  runNonfiniteConfigurationScenario,
  runDateConfigurationScenario,
  runMapConfigurationScenario,
  runClassConfigurationScenario,
  runUndefinedConfigurationScenario,
  runAccessorConfigurationScenario,
  runConfigurationSnapshotScenario,
  runNullPrototypeConfigurationScenario,
  runConfigurationSerializerGetterScenario,
  runSymbolConfigurationScenario,
  runPartialReceiptScenario,
  runNanCostScenario,
  runNullCostScenario,
  runRejectedNanCostScenario,
  runCancellationScenario,
  runBinaryArtifactScenario,
  runArtifactLimitsScenario,
  runMaximumArtifactsScenario,
  runInvalidMetadataScenario,
  runBridgeStartupFailureScenario,
  runUnavailableBunScenario,
  runAdapterExitCodeScenario,
  runAdapterExitHookScenario,
  runImportInterruptScenario,
  runMalformedAdapterScenario,
  runInvalidConditionScenario,
} from "./fixtures/rust-adapter-scenario";

const repository = resolve(import.meta.dir, "..");
const binary = join(repository, "target", "debug", "sevro");

beforeAll(async () => {
  const child = Bun.spawn(
    [
      "cargo",
      "build",
      "--locked",
      "--bin",
      "sevro",
      "--manifest-path",
      join(repository, "Cargo.toml"),
      "--target-dir",
      join(repository, "target"),
    ],
    { cwd: repository, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`Rust candidate build failed:\n${stdout}${stderr}`);
}, 180000);

test("Rust CLI executes an existing TypeScript adapter and retains its result", async () => {
  await runAdapterScenario(binary);
});

test("Rust CLI preserves adapter diagnostics and caller-owned stderr flags", async () => {
  await runStderrDescriptorScenario(binary);
});

test("Rust CLI finishes adapter diagnostics while a descendant retains stderr", async () => {
  await runStderrDescendantScenario(binary);
});

test("Rust CLI rejects a final message forged by JSON serialization", async () => {
  await runForgedMessageScenario(binary);
});

test("Rust CLI retains original UTF-8 bytes despite a result serializer", async () => {
  await runRawMessageScenario(binary);
});

test("Rust CLI rejects non-finite adapter configuration before execution", async () => {
  await runNonfiniteConfigurationScenario(binary);
});

test("Rust CLI rejects Date adapter configuration before admission", async () => {
  await runDateConfigurationScenario(binary);
});

test("Rust CLI rejects Map adapter configuration before admission", async () => {
  await runMapConfigurationScenario(binary);
});

test("Rust CLI rejects custom-class adapter configuration before admission", async () => {
  await runClassConfigurationScenario(binary);
});

test("Rust CLI rejects adapter configuration that JSON would omit", async () => {
  await runUndefinedConfigurationScenario(binary);
});

test("Rust CLI rejects accessor configuration before evaluating identity", async () => {
  await runAccessorConfigurationScenario(binary);
});

test("Rust CLI snapshots original configuration before host execution", async () => {
  await runConfigurationSnapshotScenario(binary);
});

test("Rust CLI preserves null-prototype configuration and its identity", async () => {
  await runNullPrototypeConfigurationScenario(binary);
});

test("Rust CLI ignores configuration serializer getters", async () => {
  await runConfigurationSerializerGetterScenario(binary);
});

test("Rust CLI rejects symbol-keyed adapter configuration", async () => {
  await runSymbolConfigurationScenario(binary);
});

test("Rust CLI retains failed adapter output and complete usage", async () => {
  await runPartialReceiptScenario(binary);
});

test("Rust CLI rejects NaN cost after retaining its successful trial", async () => {
  await runNanCostScenario(binary);
});

test("Rust CLI preserves null cost with independently complete usage", async () => {
  await runNullCostScenario(binary);
});

test("Rust CLI discards NaN cost when rejecting an oversized receipt", async () => {
  await runRejectedNanCostScenario(binary);
});

test("Rust CLI cancels its adapter with partial output and awaited child cleanup", async () => {
  await runCancellationScenario(binary);
}, 10000);

test("Rust CLI forwards SIGTERM to its adapter and retains partial output", async () => {
  await runCancellationScenario(binary, "SIGTERM");
}, 10000);

test("Rust CLI preserves binary adapter artifact subarray bytes", async () => {
  await runBinaryArtifactScenario(binary);
});

test("Rust CLI rejects invalid adapter artifact values and exceeded limits", async () => {
  await runArtifactLimitsScenario(binary);
}, 60000);

test("Rust CLI retains the full allowed artifact aggregate alongside a maximum message", async () => {
  await runMaximumArtifactsScenario(binary);
}, 60000);

test("Rust CLI rejects malformed adapter instrumentation before execution", async () => {
  await runInvalidMetadataScenario(binary, "instrumentation");
});

test("Rust CLI rejects malformed adapter capability IDs before execution", async () => {
  await runInvalidMetadataScenario(binary, "hostCapabilities");
});

test("Rust CLI reports a Bun bridge that exits before connecting and cleans it up", async () => {
  await runBridgeStartupFailureScenario(binary);
}, 10000);

test("Rust CLI reports an unavailable optional Bun adapter runtime", async () => {
  await runUnavailableBunScenario(binary);
});

test("Rust CLI owns the result exit code after an adapter changes process.exitCode", async () => {
  await runAdapterExitCodeScenario(binary);
});

test("Rust CLI preserves completed evidence when an adapter exit hook fails", async () => {
  await runAdapterExitHookScenario(binary);
});

test("Rust CLI interrupts pending adapter import without run evidence and reaps its bridge", async () => {
  await runImportInterruptScenario(binary);
}, 15000);

test("Rust CLI terminates pending adapter import on SIGTERM without run evidence", async () => {
  await runImportInterruptScenario(binary, "SIGTERM");
}, 15000);

test("Rust CLI refuses a noncallable adapter run before admission and storage", async () => {
  await runMalformedAdapterScenario(binary, "run", "not a callable");
});

test("Rust CLI refuses a numeric adapter id before admission and storage", async () => {
  await runMalformedAdapterScenario(binary, "id", 42);
});

test("Rust CLI refuses a null adapter model before admission and storage", async () => {
  await runMalformedAdapterScenario(binary, "model", null);
});

test("Rust CLI refuses a boolean adapter effort before admission and storage", async () => {
  await runMalformedAdapterScenario(binary, "effort", false);
});

test("Rust CLI classifies invalid adapter condition evidence and retains the failed fixture", async () => {
  await runInvalidConditionScenario(binary);
});
