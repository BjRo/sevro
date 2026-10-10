import { isMissingFile } from "./fixture-tools";
import { sha256 } from "./identity";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface PreparationArtifact {
  id: string;
  relativePath: string;
  sha256: string;
  contentBase64?: string;
  sourceRef?: string;
  gitExclude?: boolean;
  executable?: boolean;
}

export interface InlineArtifact {
  id: string;
  relativePath: string;
  sha256: string;
  bytes: Uint8Array;
  gitExclude?: boolean;
  executable?: boolean;
}

export interface PreparationSources {
  root: string;
  refs: Record<string, string>;
}

export function fixtureParts(relativePath: string): string[] {
  if (!validFixturePath(relativePath))
    throw new Error(`invalid fixture path: ${relativePath}`);
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error(`invalid fixture path: ${relativePath}`);
  return parts;
}

function validFixturePath(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.includes("\\") && !/:/.test(path);
}

/** Refuse fixture or setup-created links before mounting trusted artifact bytes. */
export async function safePreparationTarget(
  workspace: string,
  relativePath: string,
): Promise<string> {
  const parts = fixtureParts(relativePath);
  let parent = workspace;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    await preparationParent(parent);
  }
  const target = join(workspace, ...parts);
  await requireUnusedPreparationTarget(target);
  return target;
}

async function preparationParent(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("preparation artifact traverses a non-directory");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    await mkdir(path, { mode: 0o700 });
  }
}
async function requireUnusedPreparationTarget(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error("preparation artifact path already exists");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}
function collidingPaths(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function validatePaths(paths: string[]): void {
  const normalized = paths.map((path) =>
    fixtureParts(path).join("/").toLowerCase(),
  );
  for (const [index, path] of normalized.entries())
    for (const other of normalized.slice(0, index))
      if (collidingPaths(path, other)) throw new Error("fixture paths collide");
}

/** Decode declared inline artifacts before creating a candidate workspace. */
export function prepareInlineArtifacts(
  declarations: PreparationArtifact[],
  fixturePaths: string[],
): InlineArtifact[] {
  validatePaths([
    ...fixturePaths,
    ...declarations.map((item) => item.relativePath),
  ]);
  const state = { ids: new Set<string>(), bytes: 0 };
  return declarations.map((item) => inlineArtifact(item, state));
}

function requireArtifactFlags(item: PreparationArtifact): void {
  if (item.gitExclude !== undefined && typeof item.gitExclude !== "boolean")
    throw new Error("preparation artifact gitExclude must be boolean");
  if (item.executable !== undefined && typeof item.executable !== "boolean")
    throw new Error("preparation artifact executable must be boolean");
}
function containsControlCharacter(path: string): boolean {
  return Array.from(path).some(
    (character) =>
      character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
  );
}
function requireInlineSource(
  item: PreparationArtifact,
): asserts item is PreparationArtifact & { contentBase64: string } {
  if (item.gitExclude && containsControlCharacter(item.relativePath))
    throw new Error("Git-excluded artifact path contains control characters");
  if (item.sourceRef !== undefined || typeof item.contentBase64 !== "string")
    throw new Error("preparation source references are not supported");
}
function canonicalBase64Bytes(encoded: string): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  )
    throw new Error("preparation artifact content is not canonical base64");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded)
    throw new Error("preparation artifact content is not canonical base64");
  return bytes;
}
function requireArtifactSize(bytes: number, total: number): void {
  if (bytes > MAX_ARTIFACT_BYTES || total > MAX_TOTAL_BYTES)
    throw new Error("preparation artifacts exceed the size limit");
}
function artifactFlags(item: PreparationArtifact) {
  return {
    ...(item.gitExclude === undefined ? {} : { gitExclude: item.gitExclude }),
    ...(item.executable === undefined ? {} : { executable: item.executable }),
  };
}
function inlineArtifact(
  item: PreparationArtifact,
  state: { ids: Set<string>; bytes: number },
): InlineArtifact {
  if (!item.id || state.ids.has(item.id))
    throw new Error("preparation artifact IDs must be unique and nonempty");
  state.ids.add(item.id);
  requireArtifactFlags(item);
  requireInlineSource(item);
  const bytes = canonicalBase64Bytes(item.contentBase64);
  state.bytes += bytes.byteLength;
  requireArtifactSize(bytes.byteLength, state.bytes);
  if (sha256(bytes) !== item.sha256)
    throw new Error("preparation artifact digest does not match content");
  return {
    id: item.id,
    relativePath: item.relativePath,
    sha256: item.sha256,
    bytes,
    ...artifactFlags(item),
  };
}

/** Resolve opaque source IDs only through an explicitly declared case source map. */
export async function prepareArtifacts(
  declarations: PreparationArtifact[],
  fixturePaths: string[],
  sources?: PreparationSources,
): Promise<InlineArtifact[]> {
  if (!declarations.some((item) => item.sourceRef !== undefined))
    return prepareInlineArtifacts(declarations, fixturePaths);
  const context = await preparationSourceContext(sources);
  const resolved: PreparationArtifact[] = [];
  const state = { bytes: 0 };
  for (const item of declarations)
    resolved.push(await resolveSourceArtifact(item, context, state));
  return prepareInlineArtifacts(resolved, fixturePaths);
}

async function preparationSourceContext(
  sources: PreparationSources | undefined,
) {
  if (!sources || !isAbsolute(sources.root))
    throw new Error("preparation source root is required and must be absolute");
  const root = await realpath(sources.root).catch((cause: unknown) => {
    throw new Error("preparation source root is unreadable", { cause });
  });
  return { root, refs: sources.refs };
}
function sourceArtifactUrl(
  item: PreparationArtifact & { sourceRef: string },
  refs: Record<string, string>,
): string {
  if (item.contentBase64 !== undefined)
    throw new Error("preparation artifact has two content sources");
  if (!Object.hasOwn(refs, item.sourceRef))
    throw new Error("preparation source reference is not declared");
  const url = refs[item.sourceRef];
  if (typeof url !== "string" || !url.startsWith("file:///"))
    throw new Error("preparation source reference must be a file URL");
  return url;
}
async function preparationSourcePath(url: string): Promise<string> {
  try {
    return await realpath(fileURLToPath(url));
  } catch (cause) {
    throw new Error("preparation source is unreadable", { cause });
  }
}
function requireContainedSource(root: string, path: string): void {
  const child = relative(root, path);
  if (
    !child ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  )
    throw new Error("preparation source escapes its declared root");
}
async function preparationSourceSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (cause) {
    throw new Error("preparation source is unreadable", { cause });
  }
}
async function preparationSourceBytes(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (cause) {
    throw new Error("preparation source is unreadable", { cause });
  }
}
async function resolveSourceArtifact(
  item: PreparationArtifact,
  context: Awaited<ReturnType<typeof preparationSourceContext>>,
  state: { bytes: number },
): Promise<PreparationArtifact> {
  if (item.sourceRef === undefined) return item;
  const url = sourceArtifactUrl(
    { ...item, sourceRef: item.sourceRef },
    context.refs,
  );
  const path = await preparationSourcePath(url);
  requireContainedSource(context.root, path);
  const size = await preparationSourceSize(path);
  requireArtifactSize(size, state.bytes + size);
  const bytes = await preparationSourceBytes(path);
  state.bytes += bytes.byteLength;
  requireArtifactSize(bytes.byteLength, state.bytes);
  return {
    id: item.id,
    relativePath: item.relativePath,
    sha256: item.sha256,
    contentBase64: bytes.toString("base64"),
    ...artifactFlags(item),
  };
}
