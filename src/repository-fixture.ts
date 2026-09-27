import { lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./identity";
import type { PreparationSources } from "./preparation";
import { fixtureParts } from "./preparation";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_OVERLAY_FILES = 1024;
const MAX_OVERLAY_BYTES = 32 * 1024 * 1024;

export interface RepositoryFixture {
  kind: "repository";
  sourceRef: string;
  files?: Record<string, string>;
  staged?: string[];
  commitFiles?: boolean;
}

/** Validate repository source identity and bounded working-tree changes. */
export function prepareRepositoryFixture(value: unknown): RepositoryFixture {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid repository fixture");
  const fixture = value as Record<string, unknown>;
  if (
    fixture.kind !== "repository" ||
    Object.keys(fixture).some(
      (key) =>
        !["kind", "sourceRef", "files", "staged", "commitFiles"].includes(key),
    ) ||
    typeof fixture.sourceRef !== "string" ||
    !fixture.sourceRef ||
    (fixture.files !== undefined &&
      (!fixture.files ||
        typeof fixture.files !== "object" ||
        Array.isArray(fixture.files) ||
        Object.values(fixture.files).some(
          (item) => typeof item !== "string",
        ))) ||
    (fixture.staged !== undefined &&
      (!Array.isArray(fixture.staged) ||
        fixture.staged.some((item) => typeof item !== "string"))) ||
    (fixture.commitFiles !== undefined &&
      typeof fixture.commitFiles !== "boolean")
  )
    throw new Error("invalid repository fixture");
  const files = (fixture.files ?? {}) as Record<string, string>;
  const staged = (fixture.staged ?? []) as string[];
  const paths = Object.keys(files);
  if (paths.length > MAX_OVERLAY_FILES)
    throw new Error("repository fixture exceeds the file limit");
  let bytes = 0;
  for (const [path, content] of Object.entries(files)) {
    const parts = fixtureParts(path);
    if (parts.some((part) => part.toLowerCase() === ".git"))
      throw new Error("repository fixture cannot write repository metadata");
    bytes +=
      Buffer.byteLength(path, "utf8") + Buffer.byteLength(content, "utf8");
  }
  bytes += staged.reduce(
    (size, path) => size + Buffer.byteLength(path, "utf8"),
    0,
  );
  if (bytes > MAX_OVERLAY_BYTES)
    throw new Error("repository fixture exceeds the size limit");
  const normalized = paths.map((path) => path.toLowerCase());
  for (let index = 0; index < normalized.length; index++) {
    for (let other = 0; other < index; other++) {
      if (
        normalized[index] === normalized[other] ||
        normalized[index]!.startsWith(`${normalized[other]}/`) ||
        normalized[other]!.startsWith(`${normalized[index]}/`)
      )
        throw new Error("repository fixture overlay paths collide");
    }
  }
  if (
    new Set(staged.map((path) => path.toLowerCase())).size !== staged.length ||
    staged.some((path) => !Object.hasOwn(files, path)) ||
    (fixture.commitFiles === true && paths.length === 0)
  )
    throw new Error("invalid repository fixture staging");
  return JSON.parse(canonicalJson(fixture)) as RepositoryFixture;
}

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
      GIT_AUTHOR_NAME: "Sevro Fixture",
      GIT_AUTHOR_EMAIL: "fixture@sevro.invalid",
      GIT_COMMITTER_NAME: "Sevro Fixture",
      GIT_COMMITTER_EMAIL: "fixture@sevro.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00",
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

async function safeOverlayTarget(
  workspace: string,
  path: string,
): Promise<string> {
  const parts = fixtureParts(path);
  let parent = workspace;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    try {
      const entry = await lstat(parent);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("repository fixture overlay traverses a non-directory");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
      await mkdir(parent, { mode: 0o700 });
    }
  }
  const target = join(workspace, ...parts);
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error("repository fixture overlay targets a non-file");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  return target;
}

/** Apply declared files after cloning, optionally committing or staging them. */
export async function applyRepositoryOverlay(
  fixture: RepositoryFixture,
  workspace: string,
): Promise<void> {
  const files = fixture.files ?? {};
  for (const [path, content] of Object.entries(files))
    await writeFile(await safeOverlayTarget(workspace, path), content, {
      flag: "w",
      mode: 0o600,
    });
  const paths = Object.keys(files);
  const noHooks = [
    "-c",
    `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  ];
  if (fixture.commitFiles) {
    await git([...noHooks, "add", "--", ...paths], workspace);
    await git(
      [...noHooks, "commit", "--quiet", "-m", "Add evaluation scaffolding"],
      workspace,
    );
  }
  if (fixture.staged?.length)
    await git([...noHooks, "add", "--", ...fixture.staged], workspace);
}
