import {
  prepareFixtureTools,
  installFixtureTools,
  isMissingFile,
} from "./fixture-tools";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Validate executable fixture tools without allowing path traversal. */
export function prepareFixtureBin(
  value: unknown,
): Record<string, string> | null {
  return prepareFixtureTools(
    value,
    /^[A-Za-z][A-Za-z0-9._-]*$/,
    64,
    "invalid fixture binaries",
  );
}

/** Install declared tools inside the fixture's Git metadata, after commits. */
export async function installFixtureBin(
  bin: Record<string, string> | undefined,
  workspace: string,
): Promise<void> {
  if (!bin || Object.keys(bin).length === 0) return;
  const directory = join(workspace, ".git", "fixture-bin");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await installFixtureTools(bin, directory, {
    directory: "fixture binary directory is invalid",
    target: "fixture binary target is invalid",
  });
}

/** Setup may also install trusted tools, such as a repository ticket stub. */
export async function fixtureBinDirectory(
  workspace: string,
): Promise<string | null> {
  const path = join(workspace, ".git", "fixture-bin");
  try {
    await validateBinDirectory(path);
    const canonicalWorkspace = await realpath(workspace);
    const canonicalBin = await realpath(path);
    if (canonicalBin !== join(canonicalWorkspace, ".git", "fixture-bin"))
      throw new Error("fixture binary directory escapes the workspace");
    return path;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function validateBinDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error("fixture binary directory is invalid");
}
