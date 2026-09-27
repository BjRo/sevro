import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_ENV_BYTES = 16 * 1024;
const TIMEOUT_MS = 120_000;
const RESERVED_ENV = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
]);

export interface FixtureSetupDeclaration {
  command: string[];
  environment?: Record<string, string>;
}

export interface FixtureSetup extends FixtureSetupDeclaration {
  environment: Record<string, string>;
}

/** Validate a trusted extension's bounded fixture setup command. */
export function prepareFixtureSetup(value: unknown): FixtureSetup | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid fixture setup");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => key !== "command" && key !== "environment")
  )
    throw new Error("unsupported fixture setup field");
  const command = input.command;
  if (
    !Array.isArray(command) ||
    !command.length ||
    command.length > 16 ||
    command.some(
      (arg) => typeof arg !== "string" || !arg.length || arg.includes("\0"),
    ) ||
    !isAbsolute(command[0]) ||
    Buffer.byteLength(command.join("\0"), "utf8") > MAX_COMMAND_BYTES
  )
    throw new Error("invalid fixture setup command");
  const environment = input.environment ?? {};
  if (
    !environment ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  )
    throw new Error("invalid fixture setup environment");
  const entries = Object.entries(environment);
  if (
    entries.length > 32 ||
    entries.some(
      ([name, value]) =>
        !/^[A-Z][A-Z0-9_]*$/.test(name) ||
        RESERVED_ENV.has(name) ||
        typeof value !== "string" ||
        value.includes("\0") ||
        /\{\{(?!sevro\.(?:project|workspace)\}\})/.test(value),
    ) ||
    Buffer.byteLength(JSON.stringify(environment), "utf8") > MAX_ENV_BYTES
  )
    throw new Error("invalid fixture setup environment");
  return { command, environment: environment as Record<string, string> };
}

function stopProcess(proc: Bun.Subprocess): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // The process group may already be gone.
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // The process already exited.
  }
}

/** Run setup after fixture history and before evaluator artifacts are mounted. */
export async function runFixtureSetup(
  setup: FixtureSetup,
  options: {
    workspace: string;
    projectRoot: string;
    fixtureBinDir?: string;
    signal?: AbortSignal;
  },
): Promise<void> {
  if (options.signal?.aborted) throw new Error("fixture setup cancelled");
  const home = await mkdtemp(join(tmpdir(), "sevro-setup-"));
  let proc: Bun.Subprocess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const environment = Object.fromEntries(
      Object.entries(setup.environment).map(([name, value]) => [
        name,
        value
          .replaceAll("{{sevro.project}}", options.projectRoot)
          .replaceAll("{{sevro.workspace}}", options.workspace),
      ]),
    );
    proc = Bun.spawn(setup.command, {
      cwd: options.workspace,
      env: {
        PATH: options.fixtureBinDir
          ? `${options.fixtureBinDir}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`
          : (process.env.PATH ?? "/usr/bin:/bin"),
        HOME: home,
        TMPDIR: home,
        LANG: process.env.LANG ?? "C",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Sevro Fixture",
        GIT_AUTHOR_EMAIL: "fixture@sevro.invalid",
        GIT_COMMITTER_NAME: "Sevro Fixture",
        GIT_COMMITTER_EMAIL: "fixture@sevro.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00",
        ...environment,
      },
      detached: process.platform !== "win32",
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const running = proc;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("fixture setup timed out")),
        TIMEOUT_MS,
      );
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!options.signal) return;
      cancel = () => reject(new Error("fixture setup cancelled"));
      if (options.signal.aborted) cancel();
      else options.signal.addEventListener("abort", cancel, { once: true });
    });
    const code = await Promise.race([running.exited, timeout, aborted]);
    if (code !== 0) throw new Error(`fixture setup failed (${code})`);
  } catch (error) {
    if (proc) {
      stopProcess(proc);
      await proc.exited;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener("abort", cancel);
    await rm(home, { recursive: true, force: true });
  }
}
