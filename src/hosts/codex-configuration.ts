import type { Stats } from "node:fs";
import { isRecord } from "../value-guards";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parse } from "smol-toml";

export async function configurationRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new Error("configuration root must be absolute");
  try {
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory())
      throw new Error("not a directory");
    return canonical;
  } catch (cause) {
    throw new Error(`configuration root is unreadable: ${root}`, { cause });
  }
}

async function hasConfigurationDirectory(directory: string): Promise<boolean> {
  let declared = false;
  try {
    await lstat(directory);
    declared = true;
    if (!(await stat(directory)).isDirectory())
      throw new Error("not a directory");
    return true;
  } catch (error) {
    if (!declared && (error as NodeJS.ErrnoException).code === "ENOENT")
      return false;
    throw new Error("configuration directory is unreadable", { cause: error });
  }
}

/** Import one explicit setting; never inherit ambient Codex configuration. */
export async function codexAgentConcurrency(
  root: string,
): Promise<number | null> {
  const configPath = join(root, ".codex", "config.toml");
  const source = await readConfiguration(root, configPath);
  if (source === null) return null;
  return parseAgentConcurrency(source, configPath);
}

async function readConfiguration(
  root: string,
  configPath: string,
): Promise<string | null> {
  let source: string;
  let declared = false;
  try {
    if (!(await hasConfigurationDirectory(dirname(configPath)))) return null;
    const info = await lstat(configPath);
    declared = true;
    const canonical = await realpath(configPath);
    validateConfigurationFile(info, relative(root, canonical));
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (!declared && (error as NodeJS.ErrnoException).code === "ENOENT")
      return null;
    throw new Error(`Cannot read Codex configuration: ${configPath}`, {
      cause: error,
    });
  }
  return source;
}

function parseAgentConcurrency(
  source: string,
  configPath: string,
): number | null {
  let config: Record<string, unknown>;
  try {
    config = parse(source, { integersAsBigInt: true });
  } catch (cause) {
    throw new Error(`Invalid Codex configuration: ${configPath}`, { cause });
  }
  const agents = config.agents;
  if (agents === undefined) return null;
  if (!isRecord(agents))
    throw new Error(`Expected an agents table in ${configPath}`);
  return concurrencyLimit(
    agents.max_concurrent_threads_per_session,
    configPath,
  );
}

function concurrencyLimit(limit: unknown, configPath: string): number | null {
  if (limit === undefined) return null;
  if (
    typeof limit !== "bigint" ||
    limit < 1n ||
    limit > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error(
      `Expected a positive integer for agents.max_concurrent_threads_per_session in ${configPath}`,
    );
  return Number(limit);
}

function validateConfigurationFile(info: Stats, location: string): void {
  if (!info.isFile() || info.size > 64 * 1024 || escapedRoot(location))
    throw new Error(
      "configuration must be a contained regular file up to 64 KiB",
    );
}

function escapedRoot(location: string): boolean {
  return (
    location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)
  );
}
