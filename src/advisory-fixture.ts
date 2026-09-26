import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fixtureParts } from "./preparation";

const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 32 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 1024;
const HIDDEN_ROOTS = [".agents", ".claude", ".codex", ".git"];

function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function excluded(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

async function bounded(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > MAX_GIT_OUTPUT)
      throw new Error("advisory fixture Git output is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function git(
  cwd: string,
  args: string[],
  input?: Uint8Array,
): Promise<Buffer> {
  const proc = Bun.spawn(
    [
      "git",
      "-c",
      `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      ...args,
    ],
    {
      cwd,
      stdin: input ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Sevro Advisory",
        GIT_AUTHOR_EMAIL: "advisory@sevro.invalid",
        GIT_COMMITTER_NAME: "Sevro Advisory",
        GIT_COMMITTER_EMAIL: "advisory@sevro.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00",
      },
    },
  );
  try {
    const write = (async () => {
      if (!input) return;
      if (!proc.stdin || typeof proc.stdin === "number")
        throw new Error("advisory fixture Git input unavailable");
      await proc.stdin.write(input);
      await proc.stdin.end();
    })();
    const [out, , code] = await Promise.all([
      bounded(proc.stdout),
      bounded(proc.stderr),
      proc.exited,
      write,
    ]);
    if (code !== 0) throw new Error("advisory fixture Git operation failed");
    return out;
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // The process may already have exited.
    }
    await proc.exited;
    throw new Error("advisory fixture Git operation failed");
  }
}

async function checkSymlinks(root: string, directory = root): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory === root && entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await checkSymlinks(root, path);
    else if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      if (
        isAbsolute(target) ||
        !contained(root, resolve(dirname(path), target))
      )
        throw new Error("advisory fixture contains an escaping symlink");
      const resolved = await realpath(path).catch(() => {
        throw new Error("advisory fixture contains a broken symlink");
      });
      if (!contained(root, resolved))
        throw new Error("advisory fixture contains an escaping symlink");
    }
  }
}

async function safeParent(root: string, parts: string[]): Promise<void> {
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part);
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    if (!(await lstat(directory)).isDirectory())
      throw new Error("advisory fixture path has a non-directory parent");
  }
}

async function copyUntracked(
  source: string,
  destination: string,
  exclusions: string[],
): Promise<void> {
  const output = await git(source, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const paths = new TextDecoder("utf-8", { fatal: true })
    .decode(output)
    .split("\0")
    .filter(Boolean)
    .filter((path) => !excluded(path, exclusions));
  if (paths.length > MAX_UNTRACKED_FILES)
    throw new Error("advisory fixture has too many untracked files");
  let totalBytes = 0;
  for (const path of paths) {
    const parts = fixtureParts(path);
    const from = join(source, ...parts);
    const to = join(destination, ...parts);
    if (!contained(source, from) || !contained(destination, to))
      throw new Error("advisory fixture path escapes its root");
    const info = await lstat(from);
    totalBytes += info.size;
    if (totalBytes > MAX_UNTRACKED_BYTES)
      throw new Error("advisory fixture untracked files exceed the size limit");
    await safeParent(destination, parts);
    if (
      await lstat(to).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      )
    )
      throw new Error("advisory fixture untracked path already exists");
    if (info.isFile()) await copyFile(from, to);
    else if (info.isSymbolicLink()) {
      const target = await readlink(from);
      if (
        isAbsolute(target) ||
        !contained(destination, resolve(dirname(to), target))
      )
        throw new Error("advisory fixture contains an escaping symlink");
      await symlink(target, to);
    } else
      throw new Error("advisory fixture has an unsupported untracked entry");
  }
}

export interface BlindAdvisoryOptions {
  /** Fixture HEAD before candidate execution. */
  baseRevision: string;
  /** Additional root-relative evaluator paths to omit from the judge view. */
  excludedPaths?: string[];
}

/** Capture the candidate fixture's baseline before the host edits it. */
export async function advisoryBaseRevision(workspace: string): Promise<string> {
  const revision = (await git(workspace, ["rev-parse", "--verify", "HEAD"]))
    .toString("utf8")
    .trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error("advisory fixture has no valid Git baseline");
  return revision;
}

/** Rebuild a condition-blind Git view of the complete candidate change. */
export async function buildBlindAdvisoryFixture(
  candidateWorkspace: string,
  options: BlindAdvisoryOptions,
): Promise<string> {
  if (
    !isAbsolute(candidateWorkspace) ||
    !/^[a-f0-9]{40,64}$/.test(options.baseRevision)
  )
    throw new Error("invalid advisory fixture source");
  const source = await realpath(candidateWorkspace);
  const exclusions = [...HIDDEN_ROOTS, ...(options.excludedPaths ?? [])];
  for (const path of options.excludedPaths ?? []) {
    fixtureParts(path);
    if (path.toLowerCase() === ".git" || path.toLowerCase().startsWith(".git/"))
      throw new Error("invalid advisory exclusion");
  }
  const destination = await mkdtemp(join(tmpdir(), "sevro-advisory-"));
  try {
    await git(source, [
      "clone",
      "--local",
      "--no-hardlinks",
      "--no-checkout",
      "--quiet",
      source,
      destination,
    ]);
    await git(destination, [
      "checkout",
      "--detach",
      "--quiet",
      options.baseRevision,
    ]);
    for (const root of exclusions)
      await rm(join(destination, ...fixtureParts(root)), {
        recursive: true,
        force: true,
      });
    await rm(join(destination, ".git"), { recursive: true, force: true });
    await git(destination, ["init", "--quiet", "--initial-branch=main"]);
    await git(destination, ["add", "-A"]);
    await git(destination, [
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Advisory baseline",
    ]);
    const pathspec = exclusions.flatMap((path) => [
      `:(exclude)${path}`,
      `:(exclude)${path}/**`,
    ]);
    const patch = await git(source, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      options.baseRevision,
      "--",
      ".",
      ...pathspec,
    ]);
    if (patch.length) await git(destination, ["apply", "--binary", "-"], patch);
    await copyUntracked(source, destination, exclusions);
    await checkSymlinks(destination);
    return destination;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
