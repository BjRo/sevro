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

/** Freeze a bounded declarative history before any host or fixture work. */
export function prepareGeneratedFixture(value: unknown): GeneratedFixture {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid generated fixture");
  const fixture = value as Record<string, unknown>;
  if (
    fixture.kind !== "generated" ||
    Object.keys(fixture).some(
      (key) =>
        ![
          "kind",
          "commits",
          "files",
          "staged",
          "commitFiles",
          "hooks",
          "bin",
        ].includes(key),
    ) ||
    !Array.isArray(fixture.commits) ||
    fixture.commits.length > MAX_COMMITS ||
    (fixture.files !== undefined && !validFiles(fixture.files)) ||
    (fixture.staged !== undefined &&
      (!Array.isArray(fixture.staged) ||
        !fixture.staged.every((item: unknown) => typeof item === "string"))) ||
    (fixture.commitFiles !== undefined &&
      typeof fixture.commitFiles !== "boolean")
  )
    throw new Error("invalid generated fixture");
  prepareGitHooks(fixture.hooks);
  prepareFixtureBin(fixture.bin);
  let bytes = 0;
  let files = 0;
  const paths: string[] = [];
  for (const commit of fixture.commits) {
    if (
      !commit ||
      typeof commit !== "object" ||
      Array.isArray(commit) ||
      Object.keys(commit).some((key) => key !== "message" && key !== "files") ||
      typeof commit.message !== "string" ||
      !commit.message.trim() ||
      Buffer.byteLength(commit.message, "utf8") > 4096 ||
      !validFiles(commit.files) ||
      Object.keys(commit.files).length === 0
    )
      throw new Error("invalid generated fixture commit");
    bytes += Buffer.byteLength(commit.message, "utf8");
    for (const [path, content] of Object.entries(
      commit.files as Record<string, string>,
    )) {
      validPath(path);
      paths.push(path);
      files++;
      bytes +=
        Buffer.byteLength(path, "utf8") + Buffer.byteLength(content, "utf8");
    }
  }
  const overlay = (fixture.files ?? {}) as Record<string, string>;
  for (const [path, content] of Object.entries(overlay)) {
    validPath(path);
    paths.push(path);
    files++;
    bytes +=
      Buffer.byteLength(path, "utf8") + Buffer.byteLength(content, "utf8");
  }
  bytes += ((fixture.staged ?? []) as string[]).reduce(
    (size, path) => size + Buffer.byteLength(path, "utf8"),
    0,
  );
  if (files > MAX_FILES || bytes > MAX_BYTES)
    throw new Error("generated fixture exceeds the size limit");
  const unique = [...new Set(paths)];
  const normalized = unique.map((path) => path.toLowerCase());
  for (let index = 0; index < normalized.length; index++) {
    for (let other = 0; other < index; other++) {
      if (
        normalized[index] === normalized[other] ||
        normalized[index]!.startsWith(`${normalized[other]}/`) ||
        normalized[other]!.startsWith(`${normalized[index]}/`)
      )
        throw new Error("generated fixture paths collide");
    }
  }
  const staged = (fixture.staged ?? []) as string[];
  if (
    new Set(staged.map((path) => path.toLowerCase())).size !== staged.length ||
    staged.some((path) => !Object.hasOwn(overlay, path)) ||
    (fixture.commitFiles === true && Object.keys(overlay).length === 0)
  )
    throw new Error("invalid generated fixture staging");
  return JSON.parse(canonicalJson(fixture)) as GeneratedFixture;
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
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
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
    },
  );
  try {
    const [, , code] = await Promise.all([
      bounded(proc.stdout),
      bounded(proc.stderr),
      proc.exited,
    ]);
    if (code !== 0) throw new Error();
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // The process may have exited before the failure was observed.
    }
    await proc.exited;
    throw new Error("generated fixture Git operation failed");
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
