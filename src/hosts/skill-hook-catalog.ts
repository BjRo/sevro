import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Dirent } from "node:fs";
import type { HookSkill } from "./skill-hook-handler";
import { isRecord } from "../value-guards";

const MAX_SKILLS = 128;
const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
interface Catalog {
  skills: HookSkill[];
  complete: boolean;
  bytes: number;
}
export interface SkillCatalogRoot {
  directory: string;
  boundary: string;
  namespace?: string;
}

export async function codexSkillCatalogRoots(
  workspace: string,
  pluginRoots: string[],
  nativeSkillRoots: SkillCatalogRoot[],
): Promise<SkillCatalogRoot[]> {
  const roots: SkillCatalogRoot[] = [
    { directory: join(workspace, ".agents/skills"), boundary: workspace },
    ...nativeSkillRoots,
  ];
  for (const root of pluginRoots) {
    const manifest: unknown = JSON.parse(
      await readFile(join(root, ".claude-plugin/plugin.json"), "utf8"),
    );
    if (!isRecord(manifest) || typeof manifest.name !== "string")
      throw new Error("invalid skill catalog plugin manifest");
    roots.push({
      directory: join(root, "skills"),
      boundary: root,
      namespace: manifest.name,
    });
  }
  return roots;
}

/** Snapshot only known skill mounts; shell syntax does not enter discovery. */
export async function skillHookCatalog(roots: SkillCatalogRoot[]) {
  const catalog: Catalog = { skills: [], complete: true, bytes: 0 };
  for (const root of roots) await readRoot(root, catalog);
  return { skills: catalog.skills, catalogComplete: catalog.complete };
}

async function readRoot(root: SkillCatalogRoot, catalog: Catalog) {
  try {
    await requireCatalogRoot(root);
    const entries = await readdir(root.directory, { withFileTypes: true });
    const directories = catalogDirectories(entries, catalog);
    for (const entry of directories.sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      await readSkill(root, entry.name, catalog);
    }
  } catch (cause) {
    if (!missing(cause)) catalog.complete = false;
  }
}

function catalogDirectories(entries: Dirent[], catalog: Catalog): Dirent[] {
  const directories: Dirent[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) catalog.complete = false;
    if (entry.isDirectory() && /^[A-Za-z0-9._-]+$/.test(entry.name))
      directories.push(entry);
  }
  return directories;
}

async function requireCatalogRoot(root: SkillCatalogRoot) {
  const expected = resolve(
    await realpath(root.boundary),
    relative(root.boundary, root.directory),
  );
  if ((await realpath(root.directory)) !== expected)
    throw new Error("redirected skill catalog root");
}

function missing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

async function readSkill(
  root: SkillCatalogRoot,
  name: string,
  catalog: Catalog,
) {
  try {
    const path = join(root.directory, name, "SKILL.md");
    const file = await lstat(path);
    if (!readableSkill(file)) {
      catalog.complete = false;
      return;
    }
    const bytes = await readFile(path);
    if (bytes.length > MAX_SKILL_BYTES)
      throw new Error("skill changed during catalog read");
    addSkill(bytes, [root.namespace, name].filter(Boolean).join(":"), catalog);
  } catch (cause) {
    if (!missing(cause)) catalog.complete = false;
  }
}

function readableSkill(file: Awaited<ReturnType<typeof lstat>>): boolean {
  return file.isFile() && file.size <= MAX_SKILL_BYTES;
}

function addSkill(bytes: Buffer, invocation: string, catalog: Catalog) {
  if (!bytes.length) return;
  catalog.bytes += bytes.length;
  if (
    catalog.skills.length >= MAX_SKILLS ||
    catalog.bytes > MAX_CATALOG_BYTES
  ) {
    catalog.complete = false;
    return;
  }
  catalog.skills.push({
    invocation,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    body: bytes.toString("utf8"),
  });
}
