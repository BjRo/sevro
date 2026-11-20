import {
  spawn,
  type Subprocess,
  captureBoundedText,
  ProcessDeadline,
  terminateOwnedProcessGroup,
} from "../platform/index";
import {
  candidateTranscriptReadRoots,
  prepareRoleEnvironment,
  type RoleRuntime,
  type RuntimePolicy,
  type CandidateArtifactRoots,
} from "../runtime/index";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { prepareIsolatedCommand } from "../isolation/index";
import { hashJson } from "../kernel/index";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface ShellCheckDeclaration {
  id: string;
  grader: "sevro.shell";
  configuration: Record<string, unknown>;
}

export interface PreparedShellCheck {
  id: string;
  run: string;
  expectedExitCode: number;
  timeoutMs: number;
  expectExact?: string;
  expectRegex?: RegExp;
  notRegex?: RegExp;
  captureStdout: boolean;
}

function requireShellDeclaration(
  id: string,
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!id || !value || typeof value !== "object")
    throw new Error("invalid shell check declaration");
}
function requireShellKeys(config: Record<string, unknown>): void {
  const allowed = [
    "run",
    "expectedExitCode",
    "timeoutMs",
    "expectExact",
    "expectRegex",
    "notRegex",
    "flags",
  ];
  if (Object.keys(config).some((key) => !allowed.includes(key)))
    throw new Error("unsupported shell check configuration");
}
function requireShellCommand(run: unknown): asserts run is string {
  if (typeof run !== "string" || !run.trim() || run.length > 4096)
    throw new Error("shell check requires a bounded command");
}
function requireExpectedExit(code: unknown): asserts code is number {
  if (
    typeof code !== "number" ||
    !Number.isSafeInteger(code) ||
    code < 0 ||
    code > 255
  )
    throw new Error("invalid expected shell exit code");
}
function requireShellTimeout(timeout: unknown): asserts timeout is number {
  if (
    typeof timeout !== "number" ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > MAX_TIMEOUT_MS
  )
    throw new Error("invalid shell check timeout");
}
function requireExactShellOutput(
  output: unknown,
): asserts output is string | undefined {
  if (
    output !== undefined &&
    (typeof output !== "string" ||
      Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES)
  )
    throw new Error("invalid exact shell output expectation");
}
function requireShellFlags(flags: unknown): asserts flags is string {
  if (
    flags !== "" &&
    (typeof flags !== "string" ||
      !/^[isu]*$/.test(flags) ||
      new Set(flags).size !== flags.length)
  )
    throw new Error("invalid shell regex flags");
}
function requireFlagPattern(
  flags: string,
  expected: unknown,
  forbidden: unknown,
): void {
  if (flags && expected === undefined && forbidden === undefined)
    throw new Error("shell regex flags require a pattern");
}
function shellOptions(config: Record<string, unknown>) {
  const {
    run,
    expectedExitCode = 0,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    expectExact,
    expectRegex,
    notRegex,
    flags = "",
  } = config;
  requireShellCommand(run);
  requireExpectedExit(expectedExitCode);
  requireShellTimeout(timeoutMs);
  requireExactShellOutput(expectExact);
  requireShellFlags(flags);
  requireFlagPattern(flags, expectRegex, notRegex);
  return {
    run,
    expectedExitCode,
    timeoutMs,
    expectExact,
    expectRegex,
    notRegex,
    flags,
  };
}
function compileShellPattern(
  value: unknown,
  flags: string,
): RegExp | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("invalid shell regex pattern");
  try {
    return new RegExp(value, `m${flags}`);
  } catch (cause) {
    throw new Error("invalid shell regex pattern or flags", { cause });
  }
}
function prepareShellCheck({
  id,
  configuration,
}: ShellCheckDeclaration): PreparedShellCheck {
  requireShellDeclaration(id, configuration);
  requireShellKeys(configuration);
  const config = shellOptions(configuration);
  const expectRegex = compileShellPattern(config.expectRegex, config.flags),
    notRegex = compileShellPattern(config.notRegex, config.flags);
  return {
    id,
    run: config.run,
    expectedExitCode: config.expectedExitCode,
    timeoutMs: config.timeoutMs,
    expectExact: config.expectExact,
    expectRegex,
    notRegex,
    captureStdout:
      config.expectExact !== undefined ||
      expectRegex !== undefined ||
      notRegex !== undefined,
  };
}
export function prepareShellChecks(
  declarations: ShellCheckDeclaration[],
): PreparedShellCheck[] {
  return declarations.map(prepareShellCheck);
}

export interface ShellCheckResult {
  exitCode: number;
  stdout: string | null;
}

/** Grade bounded shell output without exposing it in retained evidence. */
export function assessShellCheck(
  check: PreparedShellCheck,
  result: ShellCheckResult,
): { passed: boolean; detail: string } {
  if (result.exitCode !== check.expectedExitCode)
    return {
      passed: false,
      detail: `exit code ${result.exitCode} (expected ${check.expectedExitCode})`,
    };
  if (check.captureStdout && result.stdout === null)
    throw new Error("shell stdout observation is missing");
  const detail = shellOutputFailure(check, result.stdout);
  return assessedShellOutput(detail, result.exitCode);
}

function shellOutputFailure(
  check: PreparedShellCheck,
  out: string | null,
): string | undefined {
  return (
    exactOutputFailure(check, out) ??
    expectedPatternFailure(check, out) ??
    forbiddenPatternFailure(check, out)
  );
}

function assessedShellOutput(
  detail: string | undefined,
  exitCode: number,
): { passed: boolean; detail: string } {
  return detail === undefined
    ? { passed: true, detail: `exit code ${exitCode}` }
    : { passed: false, detail };
}
function exactOutputFailure(
  check: PreparedShellCheck,
  out: string | null,
): string | undefined {
  if (check.expectExact === undefined) return undefined;
  if (out === null) throw new Error("shell stdout observation is missing");
  const actual = out.endsWith("\n") ? out.slice(0, -1) : out;
  return actual === check.expectExact
    ? undefined
    : "exact shell output did not match";
}
function expectedPatternFailure(
  check: PreparedShellCheck,
  out: string | null,
): string | undefined {
  return check.expectRegex && !check.expectRegex.test(String(out))
    ? "expected shell output pattern did not match"
    : undefined;
}
function forbiddenPatternFailure(
  check: PreparedShellCheck,
  out: string | null,
): string | undefined {
  return check.notRegex && check.notRegex.test(String(out))
    ? "forbidden shell output pattern matched"
    : undefined;
}

async function boundedOutput(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  return captureBoundedText(stream, {
    limit: MAX_OUTPUT_BYTES,
    overflow: "reject",
    exceeded: () => new Error("shell stdout exceeds 1 MiB"),
    cancelOnError: true,
  });
}

interface ShellRunOptions {
  candidateTranscriptRoot?: string;
  candidateArtifactRoots?: CandidateArtifactRoots;
  runtimePolicy?: RuntimePolicy;
  workspace: string;
  fixtureBinDir?: string;
  toolchainBinDir?: string;
  uvRuntimeCache?: boolean;
  protectedRoots: string[];
  privateStateRoot: string;
  signal?: AbortSignal;
}
/** The checks role environment, plus Git configuration isolation. */
async function shellEnvironment(options: ShellRunOptions) {
  const { runtime, environment } = await prepareRoleEnvironment({
    workspace: options.workspace,
    policy: options.runtimePolicy,
    role: "checks",
    root: join(
      options.privateStateRoot,
      "runtime",
      hashJson(options.workspace),
    ),
    fixtureBinDir: options.fixtureBinDir,
    toolchainBinDir: options.toolchainBinDir,
    uvRuntimeCache: options.uvRuntimeCache,
    candidate: {
      artifactRoots: options.candidateArtifactRoots,
      transcriptRoot: options.candidateTranscriptRoot,
    },
  });
  return {
    runtime,
    environment: {
      ...environment,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  };
}
type ShellRuntime = RoleRuntime;
type Isolation = Awaited<ReturnType<typeof prepareIsolatedCommand>>;
async function requireShellRuntimeCache(
  options: ShellRunOptions,
  runtime: ShellRuntime,
): Promise<void> {
  if (options.uvRuntimeCache && !(await stat(runtime.uvCache)).isDirectory())
    throw new Error("isolated UV cache is missing");
}
function shellStdout(
  check: PreparedShellCheck,
  output: Subprocess["stdout"],
): ReadableStream<Uint8Array> | null {
  if (!check.captureStdout) return null;
  if (!(output instanceof ReadableStream))
    throw new Error("shell stdout pipe is unavailable");
  return output;
}
class ShellExecution {
  private proc?: Subprocess;
  private readonly deadline: ProcessDeadline;
  constructor(
    private check: PreparedShellCheck,
    private options: ShellRunOptions,
    private isolation: Isolation,
    private environment: Record<string, string>,
  ) {
    this.deadline = new ProcessDeadline({
      timeoutMs: check.timeoutMs,
      signal: options.signal,
      interruption: (reason) =>
        new Error(
          reason === "timeout"
            ? "shell check timed out"
            : "shell check cancelled",
        ),
    });
  }
  async run(): Promise<ShellCheckResult> {
    try {
      const running = this.spawn();
      const stream = shellStdout(this.check, running.stdout);
      return await this.deadline.wait(() =>
        Promise.all([
          running.exited,
          stream ? boundedOutput(stream) : Promise.resolve(null),
        ]).then(([exitCode, stdout]) => ({ exitCode, stdout })),
      );
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      this.deadline.dispose();
      await this.isolation.release();
    }
  }
  private spawn() {
    this.proc = spawn(this.isolation.argv, {
      cwd: this.options.workspace,
      env: this.environment,
      detached: true,
      stdin: "ignore",
      stdout: this.check.captureStdout ? "pipe" : "ignore",
      stderr: "ignore",
    });
    return this.proc;
  }
  private async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    terminateOwnedProcessGroup(proc);
    await proc.exited;
  }
}

/** Run a check without inherited credentials or retaining raw process output. */
export async function runShellCheck(
  check: PreparedShellCheck,
  options: ShellRunOptions,
): Promise<ShellCheckResult> {
  if (options.signal?.aborted) throw new Error("shell check cancelled");
  const { runtime, environment } = await shellEnvironment(options);
  const isolated = await prepareIsolatedCommand({
    argv: ["/bin/sh", "-e", "-c", check.run],
    workspace: options.workspace,
    protectedRoots: options.protectedRoots,
    runtimePolicy: options.runtimePolicy,
    runtimeRole: "checks",
    privateStateRoot: options.privateStateRoot,
    network: "deny",
    candidateArtifactRoots: options.candidateArtifactRoots,
    transcriptReadRoots: candidateTranscriptReadRoots(
      options.candidateTranscriptRoot,
    ),
    writableRuntimeRoot: runtime.root,
  });
  await requireShellRuntimeCache(options, runtime);
  return new ShellExecution(check, options, isolated, environment).run();
}
