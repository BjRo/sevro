import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const root = required("SEVRO_DIAGNOSTIC_SOURCE_ROOT");
const output = required("SEVRO_DIAGNOSTIC_PHASE_FILE");
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function record(value: unknown): void {
  appendFileSync(output, JSON.stringify(value) + "\n");
}
function diagnosticTimeout(original: number, sandbox: boolean): number {
  const selected = process.env.SEVRO_DIAGNOSTIC_TIMEOUT_MS;
  if (!sandbox || !selected) return original;
  const value = Number(selected);
  if (!validDiagnosticTimeout(value))
    throw new Error("diagnostic probe timeout must be 1..60000 milliseconds");
  return value;
}
function validDiagnosticTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 60_000;
}
const processPath = join(root, "src/hosts/codex-process.ts");
const processes = (await import(
  processPath
)) as typeof import("../src/hosts/codex-process");
const run = processes.runCodexProcess;
await mock.module(processPath, () => ({
  ...processes,
  async runCodexProcess(options: Parameters<typeof run>[0]) {
    const sandbox = options.argv[1] === "sandbox";
    const phase = sandbox ? "sandbox-probe" : "native-process";
    const started = performance.now();
    try {
      const result = await run({
        ...options,
        timeoutMs: diagnosticTimeout(options.timeoutMs, sandbox),
      });
      record({
        phase,
        durationMs: performance.now() - started,
        code: result.code,
      });
      return result;
    } catch (error) {
      record({
        phase,
        durationMs: performance.now() - started,
        error: error instanceof Error ? error.message : "unknown",
      });
      throw error;
    }
  },
}));
const appServerPath = join(root, "src/hosts/codex-app-server.ts");
const appServer = (await import(
  appServerPath
)) as typeof import("../src/hosts/codex-app-server");
await mock.module(appServerPath, () => ({
  ...appServer,
  runCodexAppServer() {
    record({ phase: "participant", status: "withheld-diagnostic-control" });
    return Promise.resolve({
      code: 1,
      out: "",
      err: "diagnostic-stop-before-participant",
      evidence: {},
    });
  },
}));
const transcriptPath = join(root, "src/native-transcripts.ts");
const transcripts = (await import(
  transcriptPath
)) as typeof import("../src/native-transcripts");
const failed = transcripts.failedNativeTranscripts;
await mock.module(transcriptPath, () => ({
  ...transcripts,
  failedNativeTranscripts(...args: Parameters<typeof failed>) {
    const cause = args[0];
    record({
      phase: "host-failure",
      error: cause instanceof Error ? cause.message : "unknown",
    });
    return failed(...args);
  },
}));
