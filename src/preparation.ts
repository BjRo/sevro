import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface PreparationArtifact {
  id: string;
  relativePath: string;
  sha256: string;
  contentBase64?: string;
  sourceRef?: string;
}

export interface InlineArtifact {
  id: string;
  relativePath: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface PreparationSources {
  root: string;
  refs: Record<string, string>;
}

export function fixtureParts(relativePath: string): string[] {
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    /:/.test(relativePath)
  )
    throw new Error(`invalid fixture path: ${relativePath}`);
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error(`invalid fixture path: ${relativePath}`);
  return parts;
}

function validatePaths(paths: string[]): void {
  const normalized = paths.map((path) =>
    fixtureParts(path).join("/").toLowerCase(),
  );
  for (let index = 0; index < normalized.length; index++) {
    for (let other = 0; other < index; other++) {
      if (
        normalized[index] === normalized[other] ||
        normalized[index]!.startsWith(`${normalized[other]}/`) ||
        normalized[other]!.startsWith(`${normalized[index]}/`)
      )
        throw new Error("fixture paths collide");
    }
  }
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
  const ids = new Set<string>();
  let totalBytes = 0;
  return declarations.map((item) => {
    if (!item.id || ids.has(item.id))
      throw new Error("preparation artifact IDs must be unique and nonempty");
    ids.add(item.id);
    if (item.sourceRef !== undefined || typeof item.contentBase64 !== "string")
      throw new Error("preparation source references are not supported");
    const encoded = item.contentBase64;
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      throw new Error("preparation artifact content is not canonical base64");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded)
      throw new Error("preparation artifact content is not canonical base64");
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > MAX_ARTIFACT_BYTES || totalBytes > MAX_TOTAL_BYTES)
      throw new Error("preparation artifacts exceed the size limit");
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== item.sha256)
      throw new Error("preparation artifact digest does not match content");
    return {
      id: item.id,
      relativePath: item.relativePath,
      sha256: item.sha256,
      bytes,
    };
  });
}

/** Resolve opaque source IDs only through an explicitly declared case source map. */
export async function prepareArtifacts(
  declarations: PreparationArtifact[],
  fixturePaths: string[],
  sources?: PreparationSources,
): Promise<InlineArtifact[]> {
  if (!declarations.some((item) => item.sourceRef !== undefined))
    return prepareInlineArtifacts(declarations, fixturePaths);
  if (!sources || !isAbsolute(sources.root))
    throw new Error("preparation source root is required and must be absolute");
  const root = await realpath(sources.root).catch(() => {
    throw new Error("preparation source root is unreadable");
  });
  const resolved: PreparationArtifact[] = [];
  let sourceBytes = 0;
  for (const item of declarations) {
    if (item.sourceRef === undefined) {
      resolved.push(item);
      continue;
    }
    if (item.contentBase64 !== undefined)
      throw new Error("preparation artifact has two content sources");
    if (!Object.hasOwn(sources.refs, item.sourceRef))
      throw new Error("preparation source reference is not declared");
    const url = sources.refs[item.sourceRef];
    if (typeof url !== "string" || !url.startsWith("file:///"))
      throw new Error("preparation source reference must be a file URL");
    let path: string;
    try {
      path = await realpath(fileURLToPath(url));
    } catch {
      throw new Error("preparation source is unreadable");
    }
    const child = relative(root, path);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
      throw new Error("preparation source escapes its declared root");
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new Error("preparation source is unreadable");
    }
    if (size > MAX_ARTIFACT_BYTES || sourceBytes + size > MAX_TOTAL_BYTES)
      throw new Error("preparation artifacts exceed the size limit");
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      throw new Error("preparation source is unreadable");
    }
    sourceBytes += bytes.byteLength;
    if (bytes.byteLength > MAX_ARTIFACT_BYTES || sourceBytes > MAX_TOTAL_BYTES)
      throw new Error("preparation artifacts exceed the size limit");
    resolved.push({
      id: item.id,
      relativePath: item.relativePath,
      sha256: item.sha256,
      contentBase64: bytes.toString("base64"),
    });
  }
  return prepareInlineArtifacts(resolved, fixturePaths);
}
