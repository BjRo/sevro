import { isRecord, isStringArray } from "./value-guards";
import { isMissingFile } from "./fixture-tools";
import { lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./identity";
import { prepareFixtureBin } from "./fixture-bin";
import { prepareGitHooks } from "./git-hooks";
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
  hooks?: Record<string, string>;
  bin?: Record<string, string>;
}

function repositoryRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid repository fixture");
  return value;
}
function requireRepositoryIdentity(
  fixture: Record<string, unknown>,
): asserts fixture is Record<string, unknown> & {
  kind: "repository";
  sourceRef: string;
} {
  const allowed = [
    "kind",
    "sourceRef",
    "files",
    "staged",
    "commitFiles",
    "hooks",
    "bin",
  ];
  if (
    fixture.kind !== "repository" ||
    Object.keys(fixture).some((key) => !allowed.includes(key)) ||
    typeof fixture.sourceRef !== "string" ||
    !fixture.sourceRef
  )
    throw new Error("invalid repository fixture");
}
function optionalRepositoryFiles(
  value: unknown,
): value is Record<string, string> | undefined {
  return (
    value === undefined ||
    (isRecord(value) &&
      Object.values(value).every((item) => typeof item === "string"))
  );
}
function optionalRepositoryStaging(
  value: unknown,
): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}
function optionalRepositoryCommit(
  value: unknown,
): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}
function requireRepositoryOptions(
  fixture: Record<string, unknown>,
): asserts fixture is Record<string, unknown> & {
  files?: Record<string, string>;
  staged?: string[];
  commitFiles?: boolean;
} {
  if (
    !optionalRepositoryFiles(fixture.files) ||
    !optionalRepositoryStaging(fixture.staged) ||
    !optionalRepositoryCommit(fixture.commitFiles)
  )
    throw new Error("invalid repository fixture");
}
function requireRepositoryTools(
  fixture: Record<string, unknown>,
): asserts fixture is Record<string, unknown> & {
  hooks?: Record<string, string>;
  bin?: Record<string, string>;
} {
  prepareGitHooks(fixture.hooks);
  prepareFixtureBin(fixture.bin);
}
function repositoryFixtureData(value: unknown): RepositoryFixture {
  const fixture = repositoryRecord(value);
  requireRepositoryIdentity(fixture);
  requireRepositoryOptions(fixture);
  requireRepositoryTools(fixture);
  return fixture;
}
function requireOverlayPath(path: string): void {
  if (fixtureParts(path).some((part) => part.toLowerCase() === ".git"))
    throw new Error("repository fixture cannot write repository metadata");
}
function overlayPathsCollide(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}
function requireDistinctOverlayPaths(paths: string[]): void {
  const normalized = paths.map((path) => path.toLowerCase());
  for (const [index, path] of normalized.entries())
    for (const other of normalized.slice(0, index))
      if (overlayPathsCollide(path, other))
        throw new Error("repository fixture overlay paths collide");
}
function requireBoundedOverlay(
  files: Record<string, string>,
  staged: string[],
): void {
  const paths = Object.keys(files);
  if (paths.length > MAX_OVERLAY_FILES)
    throw new Error("repository fixture exceeds the file limit");
  let bytes = 0;
  for (const [path, content] of Object.entries(files)) {
    requireOverlayPath(path);
    bytes +=
      Buffer.byteLength(path, "utf8") + Buffer.byteLength(content, "utf8");
  }
  bytes += staged.reduce(
    (size, path) => size + Buffer.byteLength(path, "utf8"),
    0,
  );
  if (bytes > MAX_OVERLAY_BYTES)
    throw new Error("repository fixture exceeds the size limit");
  requireDistinctOverlayPaths(paths);
}
function requireRepositoryStaging(
  fixture: RepositoryFixture,
  files: Record<string, string>,
  staged: string[],
): void {
  if (
    new Set(staged.map((path) => path.toLowerCase())).size !== staged.length ||
    staged.some((path) => !Object.hasOwn(files, path)) ||
    (fixture.commitFiles === true && Object.keys(files).length === 0)
  )
    throw new Error("invalid repository fixture staging");
}

/** Validate repository source identity and bounded working-tree changes. */
export function prepareRepositoryFixture(value: unknown): RepositoryFixture {
  const fixture = repositoryFixtureData(value);
  const files = fixture.files ?? {},
    staged = fixture.staged ?? [];
  requireBoundedOverlay(files, staged);
  requireRepositoryStaging(fixture, files, staged);
  const clone: unknown = JSON.parse(canonicalJson(fixture));
  return repositoryFixtureData(clone);
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
    const [stdout, , code] = await Promise.all([
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
  const selected = repositorySourceSelection(sourceRef, sources);
  const { root, path } = await canonicalRepositorySource(selected);
  requireContainedRepository(root, path);
  return { path, revision: await repositoryCommit(path) };
}

function requireRepositorySources(
  sources: PreparationSources | undefined,
): asserts sources is PreparationSources {
  if (!sources || !isAbsolute(sources.root))
    throw new Error("repository source root is required and must be absolute");
}
function repositorySourceSelection(
  sourceRef: string,
  sources: PreparationSources | undefined,
) {
  requireRepositorySources(sources);
  if (!Object.hasOwn(sources.refs, sourceRef))
    throw new Error("repository source reference is not declared");
  const url = sources.refs[sourceRef];
  if (typeof url !== "string" || !url.startsWith("file:///"))
    throw new Error("repository source reference must be a file URL");
  return { root: sources.root, url };
}
async function canonicalRepositorySource(selected: {
  root: string;
  url: string;
}) {
  try {
    const [root, path] = await Promise.all([
      realpath(selected.root),
      realpath(fileURLToPath(selected.url)),
    ]);
    if (!(await stat(path)).isDirectory()) throw new Error();
    return { root, path };
  } catch (cause) {
    throw new Error("repository source is unreadable", { cause });
  }
}
function requireContainedRepository(root: string, path: string): void {
  const child = relative(root, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error("repository source escapes its declared root");
}
async function repositoryCommit(path: string): Promise<string> {
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
  return revision;
}
function requireRepositorySnapshot(
  current: RepositorySource,
  expected: RepositorySource,
  message: string,
): void {
  if (current.path !== expected.path || current.revision !== expected.revision)
    throw new Error(message);
}

/** Clone a fixed commit without hardlinks or a remote back to the source. */
export async function cloneRepositorySource(
  sourceRef: string,
  sources: PreparationSources,
  expected: RepositorySource,
  workspace: string,
): Promise<void> {
  const current = await resolveRepositorySource(sourceRef, sources);
  requireRepositorySnapshot(
    current,
    expected,
    "repository source changed during run",
  );
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
  requireRepositorySnapshot(
    after,
    expected,
    "repository source changed during clone",
  );
}

async function safeOverlayTarget(
  workspace: string,
  path: string,
): Promise<string> {
  const parts = fixtureParts(path);
  let parent = workspace;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    await overlayParent(parent);
  }
  const target = join(workspace, ...parts);
  await requireOverlayTarget(target);
  return target;
}

async function overlayParent(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("repository fixture overlay traverses a non-directory");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    await mkdir(path, { mode: 0o700 });
  }
}
async function requireOverlayTarget(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error("repository fixture overlay targets a non-file");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
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
  await stageRepositoryOverlay(fixture, workspace, Object.keys(files));
}
function disabledHooksArgs(): string[] {
  return [
    "-c",
    `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  ];
}
async function stageRepositoryOverlay(
  fixture: RepositoryFixture,
  workspace: string,
  paths: string[],
): Promise<void> {
  const noHooks = disabledHooksArgs();
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
