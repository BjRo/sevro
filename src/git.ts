import { spawn } from "./runtime-process";
import {
  captureBoundedBytes,
  terminateOwnedProcessGroup,
} from "./process-lifecycle";

type GitIdentity = "fixture" | "advisory";

function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

/** Do not inherit repository selectors, credentials, injection flags or config. */
export function gitEnvironment(identity?: GitIdentity): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice(),
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...gitIdentity(identity),
  };
}

function gitIdentity(
  identity: GitIdentity | undefined,
): Record<string, string> {
  if (!identity) return {};
  const name = identity === "fixture" ? "Sevro Fixture" : "Sevro Advisory";
  const email = `${identity}@sevro.invalid`;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00",
  };
}

/** Shared by fixture execution and the independently deadline-bound HEAD grader. */
export function gitArguments(args: string[]): string[] {
  return ["git", "-c", `core.hooksPath=${nullDevice()}`, ...args];
}

interface GitOptions {
  cwd: string;
  args: string[];
  identity: GitIdentity;
  label: string;
  maxOutputBytes: number;
  input?: Uint8Array;
  validateUtf8?: boolean;
}

async function gitOutput(
  stream: ReadableStream<Uint8Array>,
  options: GitOptions,
): Promise<Buffer> {
  const { bytes } = await captureBoundedBytes(stream, {
    limit: options.maxOutputBytes,
    overflow: "reject",
    exceeded: () => new Error(`${options.label} Git output is too large`),
  });
  if (options.validateUtf8)
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return Buffer.from(bytes);
}

/** Capture both bounded streams; binary patches remain bytes through stdin. */
export async function runGit(options: GitOptions): Promise<Buffer> {
  const proc = spawn(gitArguments(options.args), {
    cwd: options.cwd,
    stdin: options.input ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
    env: gitEnvironment(options.identity),
  });
  try {
    const [stdout, , code] = await Promise.all([
      gitOutput(proc.stdout, options),
      gitOutput(proc.stderr, options),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`${options.label} Git operation failed`);
    return stdout;
  } catch (error) {
    terminateOwnedProcessGroup(proc);
    await proc.exited;
    throw error;
  }
}
