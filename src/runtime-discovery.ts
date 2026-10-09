import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  insideRuntimeRoot,
  optionalRuntimeRoots,
  requireRuntimeReadRoots,
} from "./runtime-paths";
import {
  providerExecutable,
  query,
  requireProvider,
  type RuntimeDiscoverySource,
} from "./runtime-discovery-providers";
export type { RuntimeDiscoverySource } from "./runtime-discovery-providers";

async function homebrew(
  executable: string,
  environment: Record<string, string>,
  protectedRoots: string[],
) {
  const prefix = await query(executable, "--prefix", environment);
  const canonicalPrefix = await realpath(prefix);
  requireRuntimeReadRoots([prefix, canonicalPrefix], []);
  const cellar = await query(executable, "--cellar", environment);
  const support = await optionalRuntimeRoots(
    [cellar, join(prefix, "opt"), join(prefix, "etc")],
    {},
    "/",
    protectedRoots,
  );
  requireRuntimeReadRoots(support.roots, []);
  if (
    support.roots.some((root) =>
      [prefix, canonicalPrefix].some((installation) =>
        insideRuntimeRoot(root, installation),
      ),
    )
  )
    throw new Error(
      "runtime Homebrew metadata grants whole installation prefix",
    );
  return { prefix, roots: support.roots };
}

/** Query only providers selected by the operator's declared PATH. */
export async function discoverRuntimeSupport(
  environment: Record<string, string>,
  protectedRoots: string[],
) {
  const path = environment.PATH;
  const sources: RuntimeDiscoverySource[] = [];
  const excludedPrefixes: string[] = [];
  if (path === undefined) return { sources, excludedPrefixes };
  const brew = await providerExecutable("brew", path);
  if (brew) {
    await requireProvider(brew, protectedRoots);
    const support = await homebrew(brew, environment, protectedRoots);
    excludedPrefixes.push(support.prefix, await realpath(support.prefix));
    sources.push({
      provider: "homebrew",
      executable: brew,
      readOnlyRoots: support.roots,
    });
  }
  if (process.platform === "darwin") {
    const { discoverApple } = await import("./runtime-discovery-apple");
    await discoverApple(path, environment, sources, protectedRoots);
  }
  return { sources, excludedPrefixes };
}
