import type { HostResult } from "./evaluation-types";
import type { RuntimeRole } from "./runtime-state";
import {
  diagnosticSecrets,
  redactDiagnosticText,
} from "./host-diagnostic-redaction";

const MAX_TEXT_BYTES = 64 * 1024;
interface ProcessDiagnostic {
  code: number | null;
  out: string;
  stderr: Uint8Array;
  stderrTruncated: boolean;
  signal: string | null;
  durationMs: number;
  stdoutTruncated?: boolean;
  reason: "exit" | "timeout" | "cancelled" | "error" | "spawn";
}

export type ProcessFailureReason = ProcessDiagnostic["reason"];

export class HostDiagnosticPersistenceError extends Error {
  constructor(persistenceCause: unknown, hostCause: unknown) {
    super("host diagnostic persistence failed", {
      cause: new AggregateError(
        [hostCause, persistenceCause],
        "host and persistence failures",
      ),
    });
  }
}

export function rethrowDiagnosticPersistenceError(cause: unknown): void {
  if (cause instanceof HostDiagnosticPersistenceError) throw cause;
}

/** Drain observers capture only a prefix; completion records actual native termination. */
export class HostProcessDiagnostics {
  readonly stdout = new DiagnosticStream();
  readonly stderr = new DiagnosticStream();
  private started = performance.now();
  constructor(private diagnostics?: HostDiagnostics) {}
  recordUnstarted(): void {
    if (!this.diagnostics) return;
    this.diagnostics.process({
      code: null,
      signal: null,
      durationMs: performance.now() - this.started,
      out: "",
      stderr: new Uint8Array(),
      stderrTruncated: false,
      reason: "spawn",
    });
  }
  async record(
    process: { exited: Promise<number | null>; signalCode?: string | null },
    reason: ProcessFailureReason = "exit",
  ): Promise<void> {
    if (!this.diagnostics) return;
    this.diagnostics.process({
      code: await process.exited,
      signal: process.signalCode ?? null,
      durationMs: performance.now() - this.started,
      out: this.stdout.bytes().toString("utf8"),
      stdoutTruncated: this.stdout.truncated,
      stderr: this.stderr.bytes(),
      stderrTruncated: this.stderr.truncated,
      reason,
    });
  }
}

function boundedText(bytes: Uint8Array, secrets: string[]) {
  const redacted = Buffer.from(
    redactDiagnosticText(
      Buffer.from(bytes.subarray(0, MAX_TEXT_BYTES)).toString("utf8"),
      secrets,
    ),
  );
  return {
    text: new TextDecoder().decode(redacted.subarray(0, MAX_TEXT_BYTES), {
      stream: true,
    }),
    truncated:
      bytes.byteLength > MAX_TEXT_BYTES || redacted.byteLength > MAX_TEXT_BYTES,
  };
}

/** Keep a byte-bounded prefix while the owning transport continues draining. */
export class DiagnosticStream {
  private chunks: Uint8Array[] = [];
  private size = 0;
  truncated = false;
  add(bytes: Uint8Array): void {
    const retained = bytes.subarray(0, Math.max(0, MAX_TEXT_BYTES - this.size));
    if (retained.byteLength) this.chunks.push(Buffer.from(retained));
    this.size += retained.byteLength;
    this.truncated ||= retained.byteLength !== bytes.byteLength;
  }
  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function errorCode(cause: Error): { code?: string | number } {
  if (!("code" in cause)) return {};
  const code: unknown = cause.code;
  return typeof code === "string" || typeof code === "number" ? { code } : {};
}

function errorEvidence(
  cause: unknown,
  secrets: string[],
): Record<string, unknown> {
  return errorChain(cause, secrets, new Set());
}

function errorChain(
  cause: unknown,
  secrets: string[],
  seen: Set<Error>,
): Record<string, unknown> {
  if (!(cause instanceof Error))
    return {
      name: "NonError",
      message: redactDiagnosticText(String(cause).slice(0, 8192), secrets),
    };
  if (seen.has(cause) || seen.size === 8) return { truncated: true };
  seen.add(cause);
  return {
    ...errorDetails(cause, secrets),
    ...(cause.cause === undefined
      ? {}
      : { cause: errorChain(cause.cause, secrets, seen) }),
  };
}

function errorDetails(cause: Error, secrets: string[]) {
  return {
    name: redactDiagnosticText(cause.name.slice(0, 200), secrets),
    message: redactDiagnosticText(cause.message.slice(0, 8192), secrets),
    stack: redactDiagnosticText(cause.stack?.slice(0, 8192) ?? "", secrets),
    ...errorCode(cause),
  };
}

export function diagnosticStage(
  diagnostics: HostDiagnostics | undefined,
  stage: string,
): void {
  if (diagnostics) diagnostics.stage = stage;
}

/** A cleanup exception must not replace an already captured host/persistence failure. */
export async function cleanupNativeState(
  diagnostics: HostDiagnostics | undefined,
  cleanup: () => Promise<void>,
): Promise<void> {
  beginNativeCleanup(diagnostics);
  try {
    await cleanup();
  } catch (cause) {
    if (!diagnostics?.failureCaptured) throw cause;
    console.warn(
      "native state cleanup failed; original host failure preserved",
    );
  }
}

function beginNativeCleanup(diagnostics: HostDiagnostics | undefined): void {
  if (diagnostics && !diagnostics.failureCaptured)
    diagnosticStage(diagnostics, "cleanup");
}

export function diagnosticConfiguration(enabled: boolean | undefined) {
  return enabled ? { "sevro.host.retain-diagnostics": true } : {};
}

export function createHostDiagnostics(
  host: "codex" | "claude",
  enabled: boolean | undefined,
  request: {
    runtimeRole?: RuntimeRole;
    retainHostDiagnostics?: (bytes: Uint8Array) => Promise<void>;
  },
): HostDiagnostics | undefined {
  return enabled
    ? new HostDiagnostics(
        host,
        request.runtimeRole,
        request.retainHostDiagnostics,
      )
    : undefined;
}

export async function readDiagnosticCredentials(
  diagnostics: HostDiagnostics | undefined,
  path: string | undefined,
): Promise<void> {
  if (diagnostics && path) await diagnostics.readCredentials(path);
}

export function diagnosticCredentialEnvironment(
  diagnostics: HostDiagnostics | undefined,
  environment: Record<string, string>,
  names: readonly string[],
): void {
  if (diagnostics) diagnostics.registerCredentials(environment, names);
}

export async function retainReturnedHostFailure(
  diagnostics: HostDiagnostics | undefined,
  result: HostResult,
  message: string,
): Promise<void> {
  if (diagnostics && result.executionFailed)
    await diagnostics.retain(result, diagnostics.failure ?? new Error(message));
}

export async function diagnoseHostRequest(
  diagnostics: HostDiagnostics | undefined,
  execute: () => Promise<HostResult>,
): Promise<HostResult> {
  try {
    return await execute();
  } catch (cause) {
    if (cause instanceof HostDiagnosticPersistenceError) throw cause;
    if (!diagnostics) throw cause;
    const result: HostResult = {
      finalMessage: null,
      complete: false,
      executionFailed: true,
      actualCondition: "passive",
    };
    await diagnostics.retain(result, cause);
    return result;
  }
}

/** Private failure evidence, independent of native sessions and transcript access. */
export class HostDiagnostics {
  stage = "preparation";
  failure: unknown;
  failureCaptured = false;
  private processes: Record<string, unknown>[] = [];
  private processesDropped = 0;
  private secrets: string[] = [];
  constructor(
    private host: "codex" | "claude",
    private role: RuntimeRole = "candidate",
    private persist?: (bytes: Uint8Array) => Promise<void>,
  ) {}

  async readCredentials(path: string): Promise<void> {
    this.secrets.push(...(await diagnosticSecrets(path)));
  }

  registerCredentials(
    environment: Record<string, string>,
    names: readonly string[],
  ): void {
    for (const name of names) {
      const value = environment[name];
      if (value) this.secrets.push(value);
    }
  }

  process(result: ProcessDiagnostic): void {
    const stdout = boundedText(Buffer.from(result.out), this.secrets);
    const stderr = boundedText(result.stderr, this.secrets);
    this.addProcess({
      stage: this.stage,
      code: result.code,
      signal: result.signal,
      durationMs: result.durationMs,
      reason: result.reason,
      stdout: stdout.text,
      stdoutTruncated: stdout.truncated || result.stdoutTruncated === true,
      stderr: stderr.text,
      stderrTruncated: stderr.truncated || result.stderrTruncated,
    });
  }

  private addProcess(receipt: Record<string, unknown>): void {
    this.processes.push(receipt);
    while (
      this.processes.length > 32 ||
      Buffer.byteLength(JSON.stringify(this.processes)) > 2 * 1024 * 1024
    ) {
      this.processes.shift();
      this.processesDropped++;
    }
  }

  async retain(result: HostResult, cause: unknown): Promise<void> {
    this.failureCaptured = true;
    const bytes = Buffer.from(
      JSON.stringify({
        format: "sevro.host-diagnostics.v1",
        host: this.host,
        role: this.role,
        stage: this.stage,
        error: errorEvidence(cause, this.secrets),
        processes: this.processes,
        processesDropped: this.processesDropped,
      }),
    );
    if (this.persist) {
      try {
        await this.persist(bytes);
      } catch (persistenceCause) {
        throw new HostDiagnosticPersistenceError(persistenceCause, cause);
      }
      return;
    }
    result.artifacts ??= [];
    result.artifacts.push({ id: "sevro.host.diagnostics", bytes });
  }
}
