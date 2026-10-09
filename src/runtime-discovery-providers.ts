import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { runtimeMetadataQuery } from "./runtime-query";
import { requireRuntimeReadRoots } from "./runtime-paths";

export interface RuntimeDiscoverySource {
  provider: "homebrew" | "apple-developer";
  executable: string;
  readOnlyRoots: string[];
}

export async function providerExecutable(name: string, path: string) {
  for (const entry of path.split(delimiter)) {
    const executable = join(entry, name);
    try {
      await access(executable, constants.X_OK);
      return executable;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EACCES") throw cause;
    }
  }
  return undefined;
}

export async function query(
  executable: string,
  argument: string,
  environment: Record<string, string>,
) {
  try {
    const value = (
      await runtimeMetadataQuery(executable, argument, environment)
    ).trim();
    if (!isAbsolute(value) || containsControl(value))
      throw new Error("expected one absolute metadata path");
    return value;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "query unavailable";
    throw new Error(
      `runtime discovery query failed: ${executable} ${argument}: ${reason} (3 second / 8 KiB bound)`,
      { cause },
    );
  }
}

function containsControl(value: string): boolean {
  return Array.from(value).some(
    (character) =>
      character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
  );
}

export async function requireProvider(
  executable: string,
  protectedRoots: string[],
) {
  requireRuntimeReadRoots(
    [executable, await realpath(executable)],
    protectedRoots,
  );
}
