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

export function prepareShellChecks(
  declarations: ShellCheckDeclaration[],
): PreparedShellCheck[] {
  return declarations.map(({ id, configuration }) => {
    if (!id || !configuration || typeof configuration !== "object")
      throw new Error("invalid shell check declaration");
    if (
      Object.keys(configuration).some(
        (key) =>
          ![
            "run",
            "expectedExitCode",
            "timeoutMs",
            "expectExact",
            "expectRegex",
            "notRegex",
            "flags",
          ].includes(key),
      )
    )
      throw new Error("unsupported shell check configuration");
    const {
      run,
      expectedExitCode = 0,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      expectExact,
      expectRegex,
      notRegex,
      flags = "",
    } = configuration;
    if (typeof run !== "string" || !run.trim() || run.length > 4096)
      throw new Error("shell check requires a bounded command");
    if (
      !Number.isSafeInteger(expectedExitCode) ||
      (expectedExitCode as number) < 0 ||
      (expectedExitCode as number) > 255
    )
      throw new Error("invalid expected shell exit code");
    if (
      !Number.isSafeInteger(timeoutMs) ||
      (timeoutMs as number) < 1 ||
      (timeoutMs as number) > MAX_TIMEOUT_MS
    )
      throw new Error("invalid shell check timeout");
    if (
      expectExact !== undefined &&
      (typeof expectExact !== "string" ||
        Buffer.byteLength(expectExact, "utf8") > MAX_OUTPUT_BYTES)
    )
      throw new Error("invalid exact shell output expectation");
    if (
      flags !== "" &&
      (typeof flags !== "string" ||
        !/^[isu]*$/.test(flags) ||
        new Set(flags).size !== flags.length)
    )
      throw new Error("invalid shell regex flags");
    if (flags && expectRegex === undefined && notRegex === undefined)
      throw new Error("shell regex flags require a pattern");
    const pattern = (value: unknown): RegExp | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== "string" || value.length > 4096)
        throw new Error("invalid shell regex pattern");
      try {
        return new RegExp(value, `m${flags}`);
      } catch {
        throw new Error("invalid shell regex pattern or flags");
      }
    };
    const expectedPattern = pattern(expectRegex);
    const forbiddenPattern = pattern(notRegex);
    return {
      id,
      run,
      expectedExitCode: expectedExitCode as number,
      timeoutMs: timeoutMs as number,
      expectExact: expectExact as string | undefined,
      expectRegex: expectedPattern,
      notRegex: forbiddenPattern,
      captureStdout:
        expectExact !== undefined ||
        expectedPattern !== undefined ||
        forbiddenPattern !== undefined,
    };
  });
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
  const out = result.stdout;
  if (check.captureStdout && out === null)
    throw new Error("shell stdout observation is missing");
  if (
    check.expectExact !== undefined &&
    (out!.endsWith("\n") ? out!.slice(0, -1) : out) !== check.expectExact
  )
    return { passed: false, detail: "exact shell output did not match" };
  if (check.expectRegex && !check.expectRegex.test(out!))
    return {
      passed: false,
      detail: "expected shell output pattern did not match",
    };
  if (check.notRegex && check.notRegex.test(out!))
    return { passed: false, detail: "forbidden shell output pattern matched" };
  return { passed: true, detail: `exit code ${result.exitCode}` };
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

/** Run a check without inherited credentials or retaining raw process output. */
export async function runShellCheck(
  check: PreparedShellCheck,
  options: {
    workspace: string;
    fixtureBinDir?: string;
    toolchainBinDir?: string;
    uvRuntimeCache?: boolean;
    protectedRoots: string[];
    protectedRootsCanonical?: boolean;
    privateStateRoot: string;
    signal?: AbortSignal;
  },
): Promise<ShellCheckResult> {
  if (options.signal?.aborted) throw new Error("shell check cancelled");
  const runtimeRoot = join(options.workspace, ".git", "sevro-runtime");
  const home = join(runtimeRoot, "check-home");
  const temp = join(runtimeRoot, "check-tmp");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(temp, { recursive: true, mode: 0o700 }),
  ]);
  const isolated = await prepareMacSandboxCommand({
    argv: ["/bin/sh", "-e", "-c", check.run],
    workspace: options.workspace,
    protectedRoots: options.protectedRoots,
    protectedRootsCanonical: options.protectedRootsCanonical,
    privateStateRoot: options.privateStateRoot,
    denyNetwork: true,
  });
  const uvCache = join(runtimeRoot, "uv-cache");
  if (options.uvRuntimeCache && !(await stat(uvCache)).isDirectory())
    throw new Error("isolated UV cache is missing");
  let proc: Bun.Subprocess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    proc = Bun.spawn(isolated.argv, {
      cwd: options.workspace,
      env: {
        PATH: [
          options.fixtureBinDir,
          options.toolchainBinDir,
          "/usr/bin:/bin:/usr/sbin:/sbin",
        ]
          .filter(Boolean)
          .join(delimiter),
        HOME: home,
        TMPDIR: temp,
        LANG: process.env.LANG ?? "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        ...(options.uvRuntimeCache
          ? {
              UV_CACHE_DIR: uvCache,
              UV_PROJECT_ENVIRONMENT: join(runtimeRoot, "project-environment"),
              UV_OFFLINE: "1",
              PYTHONDONTWRITEBYTECODE: "1",
            }
          : {}),
      },
      detached: true,
      stdin: "ignore",
      stdout: check.captureStdout ? "pipe" : "ignore",
      stderr: "ignore",
    });
    const running = proc;
    const outputStream = running.stdout;
    if (check.captureStdout && !(outputStream instanceof ReadableStream))
      throw new Error("shell stdout pipe is unavailable");
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("shell check timed out")),
        check.timeoutMs,
      );
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!options.signal) return;
      cancel = () => reject(new Error("shell check cancelled"));
      if (options.signal.aborted) cancel();
      else options.signal.addEventListener("abort", cancel, { once: true });
    });
    const completed = Promise.all([
      running.exited,
      check.captureStdout
        ? boundedOutput(outputStream as ReadableStream<Uint8Array>)
        : Promise.resolve(null),
    ]).then(([exitCode, stdout]) => ({ exitCode, stdout }));
    return await Promise.race([completed, timeout, aborted]);
  } catch (error) {
    if (proc) {
      stopProcess(proc);
      await proc.exited;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener("abort", cancel);
    await isolated.release();
  }
}
