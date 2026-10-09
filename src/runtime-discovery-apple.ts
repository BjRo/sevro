import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { RuntimeMetadataQueryError } from "./runtime-query";
import { optionalRuntimeRoots, requireRuntimeReadRoots } from "./runtime-paths";
import {
  providerExecutable,
  query,
  requireProvider,
  type RuntimeDiscoverySource,
} from "./runtime-discovery-providers";

export async function discoverApple(
  path: string,
  environment: Record<string, string>,
  sources: RuntimeDiscoverySource[],
  protectedRoots: string[],
) {
  const executable = await providerExecutable("xcode-select", path);
  if (!executable) return;
  if (!(await selectedAppleShim(executable, path))) return;
  await requireProvider(executable, protectedRoots);
  const directory = await selectedAppleDirectory(executable, environment);
  if (directory === undefined) return;
  const support = await selectedDeveloperRoots(directory, protectedRoots);
  requireRuntimeReadRoots(support.roots, []);
  sources.push({
    provider: "apple-developer",
    executable,
    readOnlyRoots: support.roots,
  });
}

async function selectedDeveloperRoots(
  directory: string,
  protectedRoots: string[],
) {
  const support = await optionalRuntimeRoots(
    [directory],
    {},
    "/",
    protectedRoots,
  );
  if (support.skipped.length)
    throw new Error("selected Apple developer directory is missing");
  return support;
}

async function selectedAppleShim(
  provider: string,
  path: string,
): Promise<boolean> {
  const providerDirectory = dirname(await realpath(provider));
  for (const name of [
    "git",
    "python3",
    "clang",
    "clang++",
    "cc",
    "c++",
    "xcrun",
    "xcodebuild",
    "swift",
    "make",
    "ar",
    "ranlib",
  ]) {
    const executable = await providerExecutable(name, path);
    if (executable && dirname(await realpath(executable)) === providerDirectory)
      return true;
  }
  return false;
}

async function selectedAppleDirectory(
  executable: string,
  environment: Record<string, string>,
) {
  try {
    return await query(executable, "--print-path", environment);
  } catch (cause) {
    const failure = (cause as Error).cause;
    if (
      environment.DEVELOPER_DIR === undefined &&
      failure instanceof RuntimeMetadataQueryError &&
      failure.noActiveDeveloper
    )
      return undefined;
    throw cause;
  }
}
