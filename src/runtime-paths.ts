import {
  access,
  lstat,
  readdir,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import { constants, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { nativeStateProtectedRoots } from "./native-transcript-state";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export function insideRuntimeRoot(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
  );
}

export function isRuntimeHomeRoot(root: string): boolean {
  return [homedir(), userInfo().homedir]
    .map((home) => resolve(home))
    .includes(root);
}

export function requireRuntimeReadRoots(
  readRoots: string[],
  protectedRoots: string[],
): void {
  const hardRoots = [
    ...protectedRoots.filter((root) => !isRuntimeHomeRoot(root)),
    ...credentialRoots().flatMap((root) => [
      root,
      canonicalCredentialRoot(root),
    ]),
    ...nativeStateProtectedRoots(),
  ];
  for (const root of readRoots) {
    if (root === "/" || isRuntimeHomeRoot(root))
      throw new Error("runtime read root is too broad");
    if (
      hardRoots.some(
        (denied) =>
          insideRuntimeRoot(denied, root) || insideRuntimeRoot(root, denied),
      )
    )
      throw new Error("runtime read root overlaps protected data");
  }
}

function canonicalCredentialRoot(path: string): string {
  try {
    return realpathSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    const target = missingCredentialLink(path);
    if (target) return canonicalCredentialRoot(target);
    return join(canonicalCredentialRoot(dirname(path)), basename(path));
  }
}

function missingCredentialLink(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink()
      ? resolve(dirname(path), readlinkSync(path))
      : null;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

export function runtimeExecutableProtection(
  readRoots: string[],
  protectedRoots: string[],
  allowHomeRuntime: boolean,
): string[] {
  if (!allowHomeRuntime) return protectedRoots;
  requireRuntimeReadRoots(readRoots, []);
  return protectedRoots.filter((root) => !isRuntimeHomeRoot(root));
}

function credentialRoots(): string[] {
  return [homedir(), userInfo().homedir].flatMap((home) =>
    [
      ".ssh",
      ".aws",
      ".codex",
      ".claude",
      ".config/gcloud",
      ".local/share/keyrings",
    ].map((path) => join(home, path)),
  );
}

export async function canonicalRuntimeRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    const target = await missingRuntimeLink(path);
    if (target) return canonicalRuntimeRoot(target);
    return join(await canonicalRuntimeRoot(dirname(path)), basename(path));
  }
}

async function missingRuntimeLink(path: string): Promise<string | null> {
  try {
    return (await lstat(path)).isSymbolicLink()
      ? resolve(dirname(path), await readlink(path))
      : null;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

function installationRoot(directory: string): string | null {
  if (basename(directory) !== "bin") return null;
  const root = dirname(directory);
  const broad = [
    "/",
    "/usr",
    "/usr/local",
    "/opt/homebrew",
    ...[homedir(), userInfo().homedir].flatMap((home) => [
      home,
      join(home, ".local"),
    ]),
  ];
  return broad.includes(root) ? null : root;
}

async function linkedToolRoots(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 4096)
    throw new Error("runtime PATH directory exceeds entry limit");
  const roots: string[] = [];
  for (const entry of entries.filter((entry) => entry.isSymbolicLink())) {
    const target = await linkedTarget(join(directory, entry.name));
    if (!target) continue;
    const bin = dirname(target);
    roots.push(bin);
    const installation = installationRoot(bin);
    if (installation) roots.push(installation);
  }
  return roots;
}

async function linkedTarget(path: string): Promise<string | null> {
  try {
    const target = await realpath(path);
    return (await stat(target)).isFile() ? target : null;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

/** Missing PATH entries are inert; relative entries cannot grant host access. */
export async function runtimePathDirectories(
  path: string | undefined,
): Promise<string[]> {
  if (path === undefined) return [];
  const roots: string[] = [];
  for (const entry of path.split(delimiter)) {
    roots.push(...(await pathEntryRoots(entry)));
  }
  return [...new Set(roots)].sort();
}

function containsControl(value: string): boolean {
  return Array.from(value).some(
    (character) =>
      character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
  );
}

async function pathEntryRoots(entry: string): Promise<string[]> {
  if (!isAbsolute(entry) || containsControl(entry))
    throw new Error("runtime PATH entries must be absolute and nonempty");
  const directory = await existingDirectory(entry);
  if (!directory) return [];
  const installation = installationRoot(directory);
  return [
    resolve(entry),
    directory,
    ...(installation ? [installation] : []),
    ...(await linkedToolRoots(directory)),
  ];
}

async function existingDirectory(path: string): Promise<string | null> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory())
      throw new Error("runtime PATH entry is not a directory");
    await access(canonical, constants.R_OK | constants.X_OK);
    return canonical;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

export function runtimeDeclaredPath(
  path: string,
  environment: Record<string, string>,
  base: string,
): string {
  const expanded = path.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match: string, name: string) => {
      const value = environment[name];
      if (value === undefined)
        throw new Error(`runtime path variable is undeclared: ${name}`);
      return value;
    },
  );
  if (containsControl(expanded) || expanded.includes("${"))
    throw new Error("runtime path contains invalid characters");
  return expanded.startsWith("~/")
    ? join(homedir(), expanded.slice(2))
    : resolve(base, expanded);
}

export async function declaredRuntimeRoots(
  paths: string[],
  environment: Record<string, string>,
  base: string,
): Promise<string[]> {
  const roots = await Promise.all(
    paths.map(async (path) => {
      const directory = await existingDirectory(
        runtimeDeclaredPath(path, environment, base),
      );
      if (!directory) throw new Error("declared runtime read root is missing");
      return [directory, runtimeDeclaredPath(path, environment, base)];
    }),
  );
  return [...new Set(roots.flat())];
}

export async function optionalRuntimeRoots(
  paths: string[],
  environment: Record<string, string>,
  base: string,
  protectedRoots: string[] = [],
): Promise<{ roots: string[]; skipped: string[] }> {
  const roots: string[] = [],
    skipped: string[] = [];
  for (const path of paths) {
    const declared = runtimeDeclaredPath(path, environment, base);
    requireRuntimeReadRoots(
      [declared, await canonicalRuntimeRoot(declared)],
      protectedRoots,
    );
    const directory = await existingDirectory(declared);
    if (directory) roots.push(directory, declared);
    else skipped.push(declared);
  }
  return {
    roots: [...new Set(roots)].sort(),
    skipped: [...new Set(skipped)].sort(),
  };
}
