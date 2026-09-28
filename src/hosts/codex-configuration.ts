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
  } catch {
    throw new Error(`configuration root is unreadable: ${root}`);
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
  let source: string;
  let declared = false;
  try {
    if (!(await hasConfigurationDirectory(dirname(configPath)))) return null;
    const info = await lstat(configPath);
    declared = true;
    const canonical = await realpath(configPath);
    const location = relative(root, canonical);
    if (
      !info.isFile() ||
      info.size > 64 * 1024 ||
      location === ".." ||
      location.startsWith(`..${sep}`) ||
      isAbsolute(location)
    )
      throw new Error(
        "configuration must be a contained regular file up to 64 KiB",
      );
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (!declared && (error as NodeJS.ErrnoException).code === "ENOENT")
      return null;
    throw new Error(`Cannot read Codex configuration: ${configPath}`, {
      cause: error,
    });
  }
  let config: Record<string, unknown>;
  try {
    config = parse(source, { integersAsBigInt: true });
  } catch {
    throw new Error(`Invalid Codex configuration: ${configPath}`);
  }
  const agents = config.agents;
  if (agents === undefined) return null;
  if (!agents || typeof agents !== "object" || Array.isArray(agents))
    throw new Error(`Expected an agents table in ${configPath}`);
  const limit = (agents as Record<string, unknown>)
    .max_concurrent_threads_per_session;
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
