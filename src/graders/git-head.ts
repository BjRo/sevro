import { lstat } from "node:fs/promises";
import { join } from "node:path";

const MAX_OUTPUT_BYTES = 128;
const TIMEOUT_MS = 10_000;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface GitHeadCheckDeclaration {
  id: string;
  grader: "sevro.git-head";
  configuration: Record<string, unknown>;
}

export interface PreparedGitHeadCheck {
  id: string;
  kind: "changed" | "unchanged" | "base-ancestor";
}

export function prepareGitHeadChecks(
  declarations: GitHeadCheckDeclaration[],
): PreparedGitHeadCheck[] {
  return declarations.map(({ id, configuration }) => {
    if (
      !id ||
      !configuration ||
      typeof configuration !== "object" ||
      Object.keys(configuration).some((key) => key !== "kind") ||
      (configuration.kind !== "changed" &&
        configuration.kind !== "unchanged" &&
        configuration.kind !== "base-ancestor")
    )
      throw new Error("invalid Git HEAD check declaration");
    return { id, kind: configuration.kind };
  });
}

async function boundedOutput(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_OUTPUT_BYTES)
      throw new Error("Git HEAD output is oversized");
    chunks.push(value);
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
      // The process group may already have exited.
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // The process already exited.
  }
}

async function git(
  workspace: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; output: string }> {
  if (signal?.aborted) throw new Error("Git HEAD check cancelled");
  const gitDirectory = await lstat(join(workspace, ".git"));
  if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink())
    throw new Error("Git fixture metadata is not a directory");
  const proc = Bun.spawn(["git", ...args], {
    cwd: workspace,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: process.platform !== "win32",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const complete = Promise.all([
      boundedOutput(proc.stdout),
      proc.exited,
    ]).then(([output, code]) => ({ output: output.trim(), code }));
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Git HEAD check timed out")),
        TIMEOUT_MS,
      );
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      cancel = () => reject(new Error("Git HEAD check cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
    return await Promise.race([complete, timeout, aborted]);
  } catch (error) {
    stopProcess(proc);
    await proc.exited;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
}

export async function gitHeadRevision(
  workspace: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await git(
    workspace,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    signal,
  );
  if (result.code !== 0 || !REVISION.test(result.output))
    throw new Error("Git HEAD revision is unavailable");
  return result.output;
}

export async function gitHeadState(
  workspace: string,
  baseRevision: string,
  signal?: AbortSignal,
): Promise<{ currentRevision: string; baseAncestor: boolean }> {
  if (!REVISION.test(baseRevision)) throw new Error("invalid base revision");
  const currentRevision = await gitHeadRevision(workspace, signal);
  const ancestry = await git(
    workspace,
    ["merge-base", "--is-ancestor", baseRevision, currentRevision],
    signal,
  );
  if (ancestry.code !== 0 && ancestry.code !== 1)
    throw new Error("Git HEAD ancestry is unavailable");
  return { currentRevision, baseAncestor: ancestry.code === 0 };
}

export function assessGitHeadCheck(
  check: PreparedGitHeadCheck,
  baseRevision: string,
  state: { currentRevision: string; baseAncestor: boolean },
): { passed: boolean; detail: string } {
  if (check.kind === "unchanged")
    return {
      passed: state.currentRevision === baseRevision,
      detail: "candidate created or switched to a different commit",
    };
  if (check.kind === "changed")
    return {
      passed: state.currentRevision !== baseRevision,
      detail: "candidate did not create the expected commit",
    };
  return {
    passed: state.baseAncestor,
    detail: "candidate replaced or diverged from the fixture history",
  };
}
