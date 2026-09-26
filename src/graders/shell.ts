import { mkdir, readdir, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { prepareMacSandboxCommand } from "../hosts/mac-sandbox";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

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
}

/** Include source, results, credentials, and every active peer fixture. */
export async function shellProtectedRoots(options: {
  workspace: string;
  projectRoot: string;
  resultsRoot: string;
  additionalRoots: string[];
}): Promise<string[]> {
  if (options.additionalRoots.some((root) => !isAbsolute(root)))
    throw new Error("shell protected roots must be absolute");
  const workspace = await realpath(options.workspace);
  const source = resolve(import.meta.dir, "../..");
  const candidates = [
    source,
    options.projectRoot,
    options.resultsRoot,
    homedir(),
    ...options.additionalRoots,
    ...[process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR].filter(
      (value): value is string => Boolean(value),
    ),
  ];
  if (candidates.some((root) => !isAbsolute(root)))
    throw new Error("shell protected roots must be absolute");
  const optionalConfigRoots = [
    process.env.CODEX_HOME,
    process.env.CLAUDE_CONFIG_DIR,
  ].filter((value): value is string => Boolean(value));
  const peers = (await readdir(tmpdir(), { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("sevro-case-"),
    )
    .map((entry) => join(tmpdir(), entry.name));
  const roots: string[] = [];
  for (const candidate of [...candidates, ...peers]) {
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      if (
        (peers.includes(candidate) ||
          optionalConfigRoots.includes(candidate)) &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        continue;
      throw new Error("shell protected root is unreadable");
    }
    if (canonical !== workspace) roots.push(canonical);
  }
  return [...new Set(roots)];
}

export function prepareShellChecks(
  declarations: ShellCheckDeclaration[],
): PreparedShellCheck[] {
  return declarations.map(({ id, configuration }) => {
    if (!id || !configuration || typeof configuration !== "object")
      throw new Error("invalid shell check declaration");
    if (
      Object.keys(configuration).some(
        (key) => !["run", "expectedExitCode", "timeoutMs"].includes(key),
      )
    )
      throw new Error("unsupported shell check configuration");
    const {
      run,
      expectedExitCode = 0,
      timeoutMs = DEFAULT_TIMEOUT_MS,
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
    return {
      id,
      run,
      expectedExitCode: expectedExitCode as number,
      timeoutMs: timeoutMs as number,
    };
  });
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

/** Run a check without inherited credentials or retained process output. */
export async function runShellCheck(
  check: PreparedShellCheck,
  options: {
    workspace: string;
    protectedRoots: string[];
    privateStateRoot: string;
    signal?: AbortSignal;
  },
): Promise<number> {
  if (options.signal?.aborted) throw new Error("shell check cancelled");
  const home = join(options.workspace, ".sevro-check-home");
  const temp = join(options.workspace, ".sevro-check-tmp");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(temp, { recursive: true, mode: 0o700 }),
  ]);
  const isolated = await prepareMacSandboxCommand({
    argv: ["/bin/sh", "-c", check.run],
    workspace: options.workspace,
    protectedRoots: options.protectedRoots,
    privateStateRoot: options.privateStateRoot,
    denyNetwork: true,
  });
  let proc: Bun.Subprocess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    proc = Bun.spawn(isolated.argv, {
      cwd: options.workspace,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: home,
        TMPDIR: temp,
        LANG: process.env.LANG ?? "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const running = proc;
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
    return await Promise.race([running.exited, timeout, aborted]);
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
