import { cp, mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  requireRuntimeEnvironment,
  requireRuntimeSeedTargets,
  type RuntimePolicy,
} from "./runtime-config";
import { runtimeSeedDigest } from "./runtime-seeds";
import { hashJson } from "./identity";

export type RuntimeRole =
  "candidate" | "checks" | "hooks" | "semantic" | "advisory";

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
        seeds: (policy.seeds ?? []).map((seed) => ({
          target: seed.target,
          sha256: seed.sha256,
        })),
      },
    },
  ];
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

/** Each role gets private writable copies while the host inputs stay protected. */
export async function prepareRuntimeState(
  workspace: string,
  policy: RuntimePolicy,
  role: RuntimeRole,
  privateRoot?: string,
) {
  requireRuntimeEnvironment(policy.environment);
  requireRuntimeSeedTargets(policy.seeds ?? []);
  const root = await runtimeRoot(workspace, role, privateRoot);
  const home = join(root, "home"),
    temp = join(root, "tmp");
  await Promise.all(
    [home, temp].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  for (const seed of policy.seeds ?? [])
    await copyRuntimeSeed(seed.source, join(root, seed.target), seed.sha256);
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
  return { root, home, temp, environment: isolatedEnvironment };
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
  source: string,
  target: string,
  digest: string,
): Promise<void> {
  if (await seedTargetExists(target)) return;
  if ((await runtimeSeedDigest(source)) !== digest)
    throw new Error("runtime seed changed after configuration snapshot");
  await cp(source, target, {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: true,
  });
  if ((await runtimeSeedDigest(target)) !== digest)
    throw new Error("runtime seed changed during copying");
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
