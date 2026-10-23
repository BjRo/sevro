import { mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  requireRuntimePolicy,
  runtimeRoleSeeds,
  type RuntimeRole,
  type RuntimePolicy,
} from "./config";
import { materializeRuntimeSeed } from "./seeds";
import { requireRuntimeReadRoots } from "./paths";
import { hashJson } from "../identity";
import {
  linkSharedCaches,
  sharedCacheRoots,
  selectedSharedCaches,
} from "./shared-cache";

export type { RuntimeRole } from "./config";

export function runtimeObservations(
  policy: RuntimePolicy | undefined,
  role: RuntimeRole = "candidate",
) {
  if (!policy) return [];
  return [
    {
      id: "sevro.host.runtime",
      completeness: "complete" as const,
      data: {
        method: "runner_configuration",
        role,
        policyDigest: runtimeDigest(policy),
        environmentNames: Object.keys(policy.environment).sort(),
        readOnlyRoots: policy.readOnlyRoots,
        ...discoveryObservations(policy),
        ...(policy.sharedCacheDirectories?.length
          ? { sharedCacheDirectories: selectedSharedCaches(policy, role) }
          : {}),
        seeds: runtimeRoleSeeds(policy, role).map((seed) => ({
          target: seed.target,
          sha256: seed.sha256,
        })),
      },
    },
  ];
}

function discoveryObservations(policy: RuntimePolicy) {
  return {
    discovery: policy.discovery ?? [],
    skippedOptionalReadOnlyRoots: policy.skippedOptionalReadOnlyRoots ?? [],
  };
}

function runtimeDigest(policy: RuntimePolicy): string {
  const hooks = policy.hooks ?? {};
  return hashJson({
    ...policy,
    seeds: policy.seeds ?? [],
    hooks: {
      nativeGoal: hooks.nativeGoal ?? false,
      plugins: hooks.plugins ?? [],
    },
  });
}

/** Private role state contains copied seeds and aliases to explicitly shared caches. */
export async function prepareRuntimeState(
  workspace: string,
  policy: RuntimePolicy,
  role: RuntimeRole,
  privateRoot?: string,
) {
  requireRuntimePolicy(policy);
  const root = await runtimeRoot(workspace, role, privateRoot);
  const writableCacheRoots = await sharedCacheRoots(policy, role, [
    workspace,
    root,
  ]);
  const home = join(root, "home"),
    temp = join(root, "tmp");
  await Promise.all(
    [home, temp].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  for (const seed of runtimeRoleSeeds(policy, role))
    await copyRuntimeSeed(seed, join(root, seed.target));
  await linkSharedCaches(policy, role, root);
  const environment = Object.fromEntries(
    Object.entries(policy.environment).map(([name, value]) => [
      name,
      value.replaceAll("{{sevro.runtime}}", root),
    ]),
  );
  const isolatedEnvironment: Record<string, string> = {
    ...environment,
    HOME: home,
    TMPDIR: temp,
    UV_OFFLINE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  return {
    root,
    home,
    temp,
    environment: isolatedEnvironment,
    writableCacheRoots,
  };
}

async function runtimeRoot(
  workspace: string,
  role: RuntimeRole,
  privateRoot: string | undefined,
): Promise<string> {
  const root = privateRoot ?? join(workspace, ".git", "sevro-runtime", role);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return realpath(root);
}

async function copyRuntimeSeed(
  seed: NonNullable<RuntimePolicy["seeds"]>[number],
  target: string,
): Promise<void> {
  const canonical = await realpath(seed.source);
  requireRuntimeReadRoots([seed.source, canonical], []);
  if (await seedTargetExists(target)) return;
  await materializeRuntimeSeed(seed, target);
}

async function seedTargetExists(target: string): Promise<boolean> {
  try {
    if ((await stat(target)).isDirectory()) return true;
    throw new Error("runtime seed target is not a directory");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    return false;
  }
}
