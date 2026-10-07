import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "./identity";
import { prepareFixtureBin } from "./fixture-bin";
import { prepareGitHooks } from "./git-hooks";
import { fixtureParts } from "./preparation";

const MAX_COMMITS = 128;
const MAX_FILES = 1024;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_GIT_OUTPUT = 64 * 1024;

export interface GeneratedFixture {
  kind: "generated";
  commits: { message: string; files: Record<string, string> }[];
  files?: Record<string, string>;
  staged?: string[];
  commitFiles?: boolean;
  hooks?: Record<string, string>;
  bin?: Record<string, string>;
}

function validFiles(value: unknown): value is Record<string, string> {
  return (
    Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
    Object.values(value as object).every((item) => typeof item === "string")
  );
}

function validPath(path: string): void {
  const parts = fixtureParts(path);
  if (parts.some((part) => part.toLowerCase() === ".git"))
    throw new Error("generated fixture cannot write repository metadata");
}

interface FixtureContents {
  bytes: number;
  files: number;
  paths: string[];
}

function fixtureRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid generated fixture");
  return value as Record<string, unknown>;
}

function fixtureKeys(fixture: Record<string, unknown>): void {
  const keys = [
    "kind",
    "commits",
    "files",
    "staged",
    "commitFiles",
    "hooks",
    "bin",
  ];
  if (
    fixture.kind !== "generated" ||
    Object.keys(fixture).some((key) => !keys.includes(key))
  )
    throw new Error("invalid generated fixture");
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  );
}

function fixtureOptionalFields(fixture: Record<string, unknown>): void {
  if (fixture.files !== undefined && !validFiles(fixture.files))
    throw new Error("invalid generated fixture");
  validateStagedField(fixture.staged);
  if (
    fixture.commitFiles !== undefined &&
    typeof fixture.commitFiles !== "boolean"
  )
    throw new Error("invalid generated fixture");
}

function validateStagedField(value: unknown): void {
  if (value !== undefined && !stringArray(value))
    throw new Error("invalid generated fixture");
}

function fixtureCommits(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_COMMITS)
    throw new Error("invalid generated fixture");
  return value;
}

function commitMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    Buffer.byteLength(value, "utf8") <= 4096
  );
}

function commitRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid generated fixture commit");
  return value as Record<string, unknown>;
}

function prepareCommit(value: unknown): GeneratedFixture["commits"][number] {
  const commit = commitRecord(value);
  if (
    Object.keys(commit).some((key) => key !== "message" && key !== "files") ||
    !commitMessage(commit.message)
  )
    throw new Error("invalid generated fixture commit");
  if (!validFiles(commit.files) || Object.keys(commit.files).length === 0)
    throw new Error("invalid generated fixture commit");
  return { message: commit.message, files: commit.files };
}

function countFiles(
  contents: FixtureContents,
  files: Record<string, string>,
): void {
  for (const [path, content] of Object.entries(files)) {
    validPath(path);
    contents.paths.push(path);
    contents.files++;
    contents.bytes +=
      Buffer.byteLength(path, "utf8") + Buffer.byteLength(content, "utf8");
  }
}

function validateContents(contents: FixtureContents): void {
  if (contents.files > MAX_FILES || contents.bytes > MAX_BYTES)
    throw new Error("generated fixture exceeds the size limit");
  const normalized = [...new Set(contents.paths)].map((path) =>
    path.toLowerCase(),
  );
  for (const [index, path] of normalized.entries()) {
    if (normalized.slice(0, index).some((other) => pathsCollide(path, other)))
      throw new Error("generated fixture paths collide");
  }
}

function pathsCollide(path: string, other: string): boolean {
  return (
    path === other ||
    path.startsWith(`${other}/`) ||
    other.startsWith(`${path}/`)
  );
}

function validateStaging(
  staged: string[],
  overlay: Record<string, string>,
  commitFiles: unknown,
): void {
  if (
    new Set(staged.map((path) => path.toLowerCase())).size !== staged.length ||
    staged.some((path) => !Object.hasOwn(overlay, path)) ||
    emptyOverlayCommit(commitFiles, overlay)
  )
    throw new Error("invalid generated fixture staging");
}

function emptyOverlayCommit(
  commitFiles: unknown,
  overlay: Record<string, string>,
): boolean {
  return commitFiles === true && Object.keys(overlay).length === 0;
}

/** Freeze a bounded declarative history before any host or fixture work. */
export function prepareGeneratedFixture(value: unknown): GeneratedFixture {
  const fixture = fixtureRecord(value);
  fixtureKeys(fixture);
  const commits = fixtureCommits(fixture.commits);
  fixtureOptionalFields(fixture);
  prepareGitHooks(fixture.hooks);
  prepareFixtureBin(fixture.bin);
  const contents: FixtureContents = { bytes: 0, files: 0, paths: [] };
  for (const value of commits) {
    const commit = prepareCommit(value);
    contents.bytes += Buffer.byteLength(commit.message, "utf8");
    countFiles(contents, commit.files);
  }
  // The optional fields were checked above; preserve absent fields in the frozen declaration.
  const overlay = validFiles(fixture.files) ? fixture.files : {};
  const staged = stringArray(fixture.staged) ? fixture.staged : [];
  countFiles(contents, overlay);
  contents.bytes += staged.reduce(
    (size, path) => size + Buffer.byteLength(path, "utf8"),
    0,
  );
  validateContents(contents);
  validateStaging(staged, overlay, fixture.commitFiles);
  return JSON.parse(canonicalJson(fixture)) as GeneratedFixture;
}

function gitEnvironment() {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Sevro Fixture",
    GIT_AUTHOR_EMAIL: "fixture@sevro.invalid",
    GIT_COMMITTER_NAME: "Sevro Fixture",
    GIT_COMMITTER_EMAIL: "fixture@sevro.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00",
  };
}

async function git(workspace: string, args: string[]): Promise<void> {
  async function bounded(stream: ReadableStream<Uint8Array>): Promise<void> {
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > MAX_GIT_OUTPUT)
        throw new Error("generated fixture Git output is too large");
    }
  }
  const proc = Bun.spawn(
    [
      "git",
      "-c",
      `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      ...args,
    ],
    {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
      env: gitEnvironment(),
    },
  );
  try {
    const [, , code] = await Promise.all([
      bounded(proc.stdout),
      bounded(proc.stderr),
      proc.exited,
    ]);
    if (code !== 0) throw new Error();
  } catch (cause) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // The process may have exited before the failure was observed.
    }
    await proc.exited;
    throw new Error("generated fixture Git operation failed", { cause });
  }
}

async function writeFiles(
  workspace: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(workspace, ...fixtureParts(path));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { flag: "w", mode: 0o600 });
  }
}

/** Build a deterministic local Git history, then apply working-tree state. */
export async function materializeGeneratedFixture(
  fixture: GeneratedFixture,
  workspace: string,
): Promise<void> {
  await git(workspace, ["init", "--quiet", "--initial-branch=main"]);
  for (const commit of fixture.commits) {
    await writeFiles(workspace, commit.files);
    await git(workspace, ["add", "--", ...Object.keys(commit.files)]);
    await git(workspace, ["commit", "--quiet", "-m", commit.message]);
  }
  await applyGeneratedOverlay(fixture, workspace);
}

async function applyGeneratedOverlay(
  fixture: GeneratedFixture,
  workspace: string,
): Promise<void> {
  const overlay = fixture.files ?? {};
  await writeFiles(workspace, overlay);
  if (fixture.commitFiles) {
    await git(workspace, ["add", "--", ...Object.keys(overlay)]);
    await git(workspace, [
      "commit",
      "--quiet",
      "-m",
      "Add evaluation scaffolding",
    ]);
  }
  if (fixture.staged?.length)
    await git(workspace, ["add", "--", ...fixture.staged]);
}
