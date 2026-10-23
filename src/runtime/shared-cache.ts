import { access, lstat, realpath, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import type { RuntimePolicy, RuntimeRole } from "./config";
import { declaredRuntimeRoots, requireRuntimeReadRoots } from "./paths";

export interface SharedCacheDirectory {
  source: string;
  target: string;
  roles: RuntimeRole[];
}

export async function resolveSharedCaches(
  caches: SharedCacheDirectory[],
  environment: Record<string, string>,
  base: string,
  protectedRoots: string[],
): Promise<SharedCacheDirectory[]> {
  return Promise.all(
    caches.map(async (cache) => {
      const roots = await declaredRuntimeRoots(
        [cache.source],
        environment,
        base,
      );
      requireRuntimeReadRoots(roots, protectedRoots);
      const [declared] = roots;
      if (!declared) throw new Error("runtime shared cache source is missing");
      const source = await realpath(declared);
      await requireSharedCache(source);
      return { ...cache, source };
    }),
  );
}

export function selectedSharedCaches(
  policy: RuntimePolicy | undefined,
  role: RuntimeRole = "candidate",
): SharedCacheDirectory[] {
  return (policy?.sharedCacheDirectories ?? []).filter((cache) =>
    cache.roles.includes(role),
  );
}

export async function sharedCacheRoots(
  policy: RuntimePolicy | undefined,
  role: RuntimeRole = "candidate",
  protectedRoots: string[],
): Promise<string[]> {
  const roots = selectedSharedCaches(policy, role).map((cache) => cache.source);
  return requireWritableCacheRoots(roots, protectedRoots);
}

export function requireSharedCachePolicy(
  policy: RuntimePolicy | undefined,
): void {
  if (!policy) return;
  const caches = policy.sharedCacheDirectories ?? [];
  const protectedRoots = [
    ...policy.readOnlyRoots,
    ...(policy.seeds ?? []).map((seed) => seed.source),
  ];
  for (const cache of caches) {
    requireRuntimeReadRoots(
      [cache.source],
      [
        ...protectedRoots,
        ...caches
          .filter((other) => other !== cache)
          .map((other) => other.source),
      ],
    );
  }
}

export function sharedCacheDenyRoots(
  policy: RuntimePolicy | undefined,
  role: RuntimeRole = "candidate",
): string[] {
  return (policy?.sharedCacheDirectories ?? [])
    .filter((cache) => !cache.roles.includes(role))
    .map((cache) => cache.source);
}

export async function requireWritableCacheRoots(
  roots: string[],
  protectedRoots: string[],
): Promise<string[]> {
  requireRuntimeReadRoots(roots, protectedRoots);
  for (const root of roots) await requireSharedCache(root);
  return roots;
}

async function requireSharedCache(source: string): Promise<void> {
  if (!isAbsolute(source) || (await realpath(source)) !== source)
    throw new Error("runtime shared cache must be a canonical directory");
  const info = await lstat(source);
  if (!info.isDirectory() || info.uid !== userInfo().uid)
    throw new Error("runtime shared cache must be an owned directory");
  await access(source, constants.R_OK | constants.W_OK | constants.X_OK);
}

/** A slot aliases the operator-selected cache; its contents are never copied. */
export async function linkSharedCaches(
  policy: RuntimePolicy,
  role: RuntimeRole,
  root: string,
): Promise<void> {
  for (const cache of selectedSharedCaches(policy, role)) {
    const target = join(root, cache.target);
    try {
      await symlink(cache.source, target, "dir");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      await requireCacheSlot(target, cache.source, cause);
    }
  }
}

async function requireCacheSlot(
  target: string,
  source: string,
  cause: unknown,
): Promise<void> {
  if (!(await lstat(target)).isSymbolicLink())
    throw new Error("runtime shared cache slot was replaced", { cause });
  if ((await realpath(target)) !== source)
    throw new Error("runtime shared cache slot changed its source", { cause });
}
