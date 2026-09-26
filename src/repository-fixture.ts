import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PreparationSources } from "./preparation";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024;

export interface RepositorySource {
  path: string;
  revision: string;
}

async function boundedText(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > MAX_GIT_OUTPUT_BYTES)
      throw new Error("repository fixture Git output is too large");
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  try {
    const [stdout, _stderr, code] = await Promise.all([
      boundedText(proc.stdout),
      boundedText(proc.stderr),
      proc.exited,
    ]);
    if (code !== 0) throw new Error("repository fixture Git operation failed");
    return stdout.trim();
  } catch (error) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw error;
  }
}

/** Resolve a declared local repository without accepting a dirty source tree. */
export async function resolveRepositorySource(
  sourceRef: string,
  sources?: PreparationSources,
): Promise<RepositorySource> {
  if (!sources || !isAbsolute(sources.root))
    throw new Error("repository source root is required and must be absolute");
  if (!Object.hasOwn(sources.refs, sourceRef))
    throw new Error("repository source reference is not declared");
  const url = sources.refs[sourceRef];
  if (typeof url !== "string" || !url.startsWith("file:///"))
    throw new Error("repository source reference must be a file URL");
  let root: string;
  let path: string;
  try {
    [root, path] = await Promise.all([
      realpath(sources.root),
      realpath(fileURLToPath(url)),
    ]);
    if (!(await stat(path)).isDirectory()) throw new Error();
  } catch {
    throw new Error("repository source is unreadable");
  }
  const child = relative(root, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error("repository source escapes its declared root");
  const top = await git(["rev-parse", "--show-toplevel"], path);
  if ((await realpath(top)) !== path)
    throw new Error("repository source must name the repository root");
  const revision = await git(["rev-parse", "--verify", "HEAD^{commit}"], path);
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error("repository source has no valid commit");
  if (await git(["status", "--porcelain=v1", "--untracked-files=all"], path))
    throw new Error("repository source has uncommitted changes");
  if (await git(["submodule", "status"], path))
    throw new Error("repository submodules are not supported");
  return { path, revision };
}

/** Clone a fixed commit without hardlinks or a remote back to the source. */
export async function cloneRepositorySource(
  sourceRef: string,
  sources: PreparationSources,
  expected: RepositorySource,
  workspace: string,
): Promise<void> {
  const current = await resolveRepositorySource(sourceRef, sources);
  if (current.path !== expected.path || current.revision !== expected.revision)
    throw new Error("repository source changed during run");
  await git(
    [
      "clone",
      "--local",
      "--no-hardlinks",
      "--no-checkout",
      "--quiet",
      current.path,
      workspace,
    ],
    workspace,
  );
  await git(["checkout", "--detach", "--quiet", expected.revision], workspace);
  if ((await git(["rev-parse", "HEAD"], workspace)) !== expected.revision)
    throw new Error("repository fixture revision changed during clone");
  for (const remote of (await git(["remote"], workspace))
    .split("\n")
    .filter(Boolean))
    await git(["remote", "remove", remote], workspace);
  const after = await resolveRepositorySource(sourceRef, sources);
  if (after.path !== expected.path || after.revision !== expected.revision)
    throw new Error("repository source changed during clone");
}
