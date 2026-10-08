import { mkdir, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { prepareMacSandboxCommand } from "../hosts/mac-sandbox";

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
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > MAX_OUTPUT_BYTES) throw new Error("shell stdout exceeds 1 MiB");
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}

function stopProcess(proc: Bun.Subprocess): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // The group may already be gone.
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // The process already exited.
  }
}

interface ShellRunOptions {
  workspace: string;
  fixtureBinDir?: string;
  toolchainBinDir?: string;
  uvRuntimeCache?: boolean;
  protectedRoots: string[];
  protectedRootsCanonical?: boolean;
  privateStateRoot: string;
  signal?: AbortSignal;
}
async function shellRuntime(options: ShellRunOptions) {
  const root = join(options.workspace, ".git", "sevro-runtime"),
    home = join(root, "check-home"),
    temp = join(root, "check-tmp");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(temp, { recursive: true, mode: 0o700 }),
  ]);
  return { root, home, temp, uvCache: join(root, "uv-cache") };
}
type ShellRuntime = Awaited<ReturnType<typeof shellRuntime>>;
type Isolation = Awaited<ReturnType<typeof prepareMacSandboxCommand>>;
function shellRuntimeEnvironment(
  runtime: ShellRuntime,
  enabled: boolean | undefined,
): Record<string, string> {
  return enabled
    ? {
        UV_CACHE_DIR: runtime.uvCache,
        UV_PROJECT_ENVIRONMENT: join(runtime.root, "project-environment"),
        UV_OFFLINE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      }
    : {};
}
function shellEnvironment(
  options: ShellRunOptions,
  runtime: ShellRuntime,
): Record<string, string> {
  return {
    PATH: [
      options.fixtureBinDir,
      options.toolchainBinDir,
      "/usr/bin:/bin:/usr/sbin:/sbin",
    ]
      .filter(Boolean)
      .join(delimiter),
    HOME: runtime.home,
    TMPDIR: runtime.temp,
    LANG: process.env.LANG ?? "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...shellRuntimeEnvironment(runtime, options.uvRuntimeCache),
  };
}
async function requireShellRuntimeCache(
  options: ShellRunOptions,
  runtime: ShellRuntime,
): Promise<void> {
  if (options.uvRuntimeCache && !(await stat(runtime.uvCache)).isDirectory())
    throw new Error("isolated UV cache is missing");
}
function shellStdout(
  check: PreparedShellCheck,
  output: Bun.Subprocess["stdout"],
): ReadableStream<Uint8Array> | null {
  if (!check.captureStdout) return null;
  if (!(output instanceof ReadableStream))
    throw new Error("shell stdout pipe is unavailable");
  return output;
}
class ShellExecution {
  private proc?: Bun.Subprocess;
  private timer?: ReturnType<typeof setTimeout>;
  private cancel?: () => void;
  constructor(
    private check: PreparedShellCheck,
    private options: ShellRunOptions,
    private isolation: Isolation,
    private runtime: ShellRuntime,
  ) {}
  async run(): Promise<ShellCheckResult> {
    try {
      const running = this.spawn();
      const stream = shellStdout(this.check, running.stdout);
      const timeout = this.deadline();
      const aborted = this.cancellation();
      const completed = Promise.all([
        running.exited,
        stream ? boundedOutput(stream) : Promise.resolve(null),
      ]).then(([exitCode, stdout]) => ({ exitCode, stdout }));
      return await Promise.race([completed, timeout, aborted]);
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      this.releaseListeners();
      await this.isolation.release();
    }
  }
  private spawn() {
    this.proc = Bun.spawn(this.isolation.argv, {
      cwd: this.options.workspace,
      env: shellEnvironment(this.options, this.runtime),
      detached: true,
      stdin: "ignore",
      stdout: this.check.captureStdout ? "pipe" : "ignore",
      stderr: "ignore",
    });
    return this.proc;
  }
  private deadline(): Promise<never> {
    return new Promise((_resolve, reject) => {
      this.timer = setTimeout(() => {
        reject(new Error("shell check timed out"));
      }, this.check.timeoutMs);
    });
  }
  private cancellation(): Promise<never> {
    return new Promise((_resolve, reject) => {
      const signal = this.options.signal;
      if (!signal) return;
      this.cancel = () => {
        reject(new Error("shell check cancelled"));
      };
      if (signal.aborted) this.cancel();
      else signal.addEventListener("abort", this.cancel, { once: true });
    });
  }
  private async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    stopProcess(proc);
    await proc.exited;
  }
  private releaseListeners(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.cancel)
      this.options.signal?.removeEventListener("abort", this.cancel);
  }
}

/** Run a check without inherited credentials or retaining raw process output. */
export async function runShellCheck(
  check: PreparedShellCheck,
  options: ShellRunOptions,
): Promise<ShellCheckResult> {
  if (options.signal?.aborted) throw new Error("shell check cancelled");
  const runtime = await shellRuntime(options);
  const isolated = await prepareMacSandboxCommand({
    argv: ["/bin/sh", "-e", "-c", check.run],
    workspace: options.workspace,
    protectedRoots: options.protectedRoots,
    protectedRootsCanonical: options.protectedRootsCanonical,
    privateStateRoot: options.privateStateRoot,
    denyNetwork: true,
  });
  await requireShellRuntimeCache(options, runtime);
  return new ShellExecution(check, options, isolated, runtime).run();
}
