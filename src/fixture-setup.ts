import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { isRecord } from "./value-guards";

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

function setupRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid fixture setup");
  return value;
}

function validArgument(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function argumentList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 16 &&
    value.every(validArgument)
  );
}

function setupCommand(value: unknown): string[] {
  if (!argumentList(value)) throw new Error("invalid fixture setup command");
  const executable = value[0];
  if (
    !absoluteExecutable(executable) ||
    Buffer.byteLength(value.join("\0"), "utf8") > MAX_COMMAND_BYTES
  )
    throw new Error("invalid fixture setup command");
  return value;
}

function absoluteExecutable(value: string | undefined): boolean {
  return value !== undefined && isAbsolute(value);
}

function validEnvironmentEntry([name, value]: [string, unknown]): boolean {
  return (
    /^[A-Z][A-Z0-9_]*$/.test(name) &&
    !RESERVED_ENV.has(name) &&
    validEnvironmentValue(value)
  );
}

function validEnvironmentValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    !/\{\{(?!sevro\.(?:project|workspace)\}\})/.test(value)
  );
}

function environmentRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid fixture setup environment");
  return value;
}

function setupEnvironment(value: unknown): Record<string, string> {
  const environment = environmentRecord(value);
  const entries = Object.entries(environment);
  if (
    entries.length > 32 ||
    entries.some((entry) => !validEnvironmentEntry(entry)) ||
    Buffer.byteLength(JSON.stringify(environment), "utf8") > MAX_ENV_BYTES
  )
    throw new Error("invalid fixture setup environment");
  return environment as Record<string, string>;
}

/** Validate a trusted extension's bounded fixture setup command. */
export function prepareFixtureSetup(value: unknown): FixtureSetup | null {
  if (value === undefined) return null;
  const input = setupRecord(value);
  if (
    Object.keys(input).some((key) => key !== "command" && key !== "environment")
  )
    throw new Error("unsupported fixture setup field");
  const command = setupCommand(input.command);
  const environment = setupEnvironment(input.environment ?? {});
  return { command, environment };
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

interface FixtureSetupOptions {
  workspace: string;
  projectRoot: string;
  fixtureBinDir?: string;
  signal?: AbortSignal;
}

function setupPath(directory: string | undefined): string {
  const inherited = process.env.PATH ?? "/usr/bin:/bin";
  return directory ? `${directory}${delimiter}${inherited}` : inherited;
}

function executionEnvironment(
  setup: FixtureSetup,
  options: FixtureSetupOptions,
  home: string,
) {
  const environment = Object.fromEntries(
    Object.entries(setup.environment).map(([name, value]) => [
      name,
      value
        .replaceAll("{{sevro.project}}", options.projectRoot)
        .replaceAll("{{sevro.workspace}}", options.workspace),
    ]),
  );
  return {
    PATH: setupPath(options.fixtureBinDir),
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
  };
}

class FixtureSetupExecution {
  private proc: Bun.Subprocess | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cancel: (() => void) | undefined;
  constructor(
    private readonly setup: FixtureSetup,
    private readonly options: FixtureSetupOptions,
    private readonly home: string,
  ) {}

  async run(): Promise<void> {
    this.proc = Bun.spawn(this.setup.command, {
      cwd: this.options.workspace,
      env: executionEnvironment(this.setup, this.options, this.home),
      detached: process.platform !== "win32",
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await Promise.race([
      this.proc.exited,
      this.timeout(),
      this.aborted(),
    ]);
    if (code !== 0) throw new Error(`fixture setup failed (${code})`);
  }

  private timeout(): Promise<never> {
    return new Promise((_resolve, reject) => {
      this.timer = setTimeout(() => {
        reject(new Error("fixture setup timed out"));
      }, TIMEOUT_MS);
    });
  }

  private aborted(): Promise<never> {
    return new Promise((_resolve, reject) => {
      const signal = this.options.signal;
      if (!signal) return;
      this.cancel = () => {
        reject(new Error("fixture setup cancelled"));
      };
      if (signal.aborted) this.cancel();
      else signal.addEventListener("abort", this.cancel, { once: true });
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    stopProcess(this.proc);
    await this.proc.exited;
  }

  async dispose(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.cancel)
      this.options.signal?.removeEventListener("abort", this.cancel);
    await rm(this.home, { recursive: true, force: true });
  }
}

/** Run setup after fixture history and before evaluator artifacts are mounted. */
export async function runFixtureSetup(
  setup: FixtureSetup,
  options: FixtureSetupOptions,
): Promise<void> {
  if (options.signal?.aborted) throw new Error("fixture setup cancelled");
  const home = await mkdtemp(join(tmpdir(), "sevro-setup-"));
  const execution = new FixtureSetupExecution(setup, options, home);
  try {
    await execution.run();
  } catch (error) {
    await execution.stop();
    throw error;
  } finally {
    await execution.dispose();
  }
}
