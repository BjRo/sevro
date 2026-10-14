import { isRecord } from "../value-guards";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  captureBoundedText,
  ProcessDeadline,
  terminateOwnedProcessGroup,
} from "../process-lifecycle";

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
    if (!id || !validGitHeadConfiguration(configuration))
      throw new Error("invalid Git HEAD check declaration");
    return { id, kind: configuration.kind };
  });
}

function validGitHeadKind(
  value: unknown,
): value is PreparedGitHeadCheck["kind"] {
  return (
    value === "changed" || value === "unchanged" || value === "base-ancestor"
  );
}

function validGitHeadConfiguration(
  value: unknown,
): value is { kind: PreparedGitHeadCheck["kind"] } {
  return (
    isRecord(value) &&
    !Object.keys(value).some((key) => key !== "kind") &&
    validGitHeadKind(value.kind)
  );
}

function gitEnvironment() {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function validateGitMetadata(workspace: string): Promise<void> {
  const directory = await lstat(join(workspace, ".git"));
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Git fixture metadata is not a directory");
}

class GitHeadExecution {
  private readonly deadline: ProcessDeadline;
  constructor(
    private readonly proc: Bun.Subprocess<"ignore", "pipe", "ignore">,
    signal: AbortSignal | undefined,
  ) {
    this.deadline = new ProcessDeadline({
      timeoutMs: TIMEOUT_MS,
      signal,
      interruption: (reason) =>
        new Error(
          reason === "timeout"
            ? "Git HEAD check timed out"
            : "Git HEAD check cancelled",
        ),
    });
  }

  private complete() {
    return Promise.all([
      captureBoundedText(this.proc.stdout, {
        limit: MAX_OUTPUT_BYTES,
        overflow: "reject",
        exceeded: () => new Error("Git HEAD output is oversized"),
      }),
      this.proc.exited,
    ]).then(([output, code]) => ({ output: output.trim(), code }));
  }

  async run(): Promise<{ output: string; code: number }> {
    try {
      return await this.deadline.wait(this.complete());
    } catch (error) {
      terminateOwnedProcessGroup(this.proc);
      await this.proc.exited;
      throw error;
    } finally {
      this.deadline.dispose();
    }
  }
}

async function git(
  workspace: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; output: string }> {
  if (signal?.aborted) throw new Error("Git HEAD check cancelled");
  await validateGitMetadata(workspace);
  const proc = Bun.spawn(["git", ...args], {
    cwd: workspace,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: process.platform !== "win32",
    env: gitEnvironment(),
  });
  return new GitHeadExecution(proc, signal).run();
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
