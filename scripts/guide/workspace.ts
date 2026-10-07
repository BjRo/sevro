import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stageClaudeAuthentication } from "../../src/hosts/claude-credential";
import type { Host } from "./types";

export const guideRoot = resolve(import.meta.dir, "../..");
export const guidePath = ".agents/skills/sevro-guide/SKILL.md";

async function fixtureVariant(
  directory: string,
  kind: string | undefined,
): Promise<void> {
  if (kind === "missing") await rm(join(directory, "docs/getting-started.md"));
  if (kind === "conflict") {
    const readme = await readFile(join(directory, "README.md"), "utf8");
    await writeFile(
      join(directory, "README.md"),
      readme.replaceAll("@bjoernrochel/sevro", "@example/sevro-cloud"),
    );
  }
  if (kind === "stale")
    await writeFile(
      join(directory, "docs/legacy-validation.md"),
      "# Historical validation\n\nA past prototype was fully verified on Linux. This is an old observation, not a current support contract.\n",
    );
}

export async function guideFixture(
  directory: string,
  kind?: string,
): Promise<void> {
  await mkdir(directory);
  if (
    Bun.spawnSync(["git", "init", "--quiet"], { cwd: directory }).exitCode !== 0
  )
    throw new Error("Cannot initialize isolated guide fixture");
  for (const path of [
    "README.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "AGENTS.md",
    "CLAUDE.md",
    "package.json",
    "docs",
    "examples",
    "schemas",
    "src",
    ".agents",
    ".claude",
  ])
    await cp(join(guideRoot, path), join(directory, path), { recursive: true });
  await rm(join(directory, ".agents/skills/sevro-guide/evals"), {
    recursive: true,
  });
  await fixtureVariant(directory, kind);
}

export async function fingerprint(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const child = join(path, entry.name);
      hash.update(child.slice(directory.length));
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) hash.update(await readFile(child));
      else throw new Error(`Unexpected fixture entry: ${child}`);
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

export async function guideEnvironment(
  host: Host,
  home: string,
): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  if (host === "codex") {
    await cp(
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      join(home, "auth.json"),
    );
    env.CODEX_HOME = home;
  } else {
    const auth = await stageClaudeAuthentication(home);
    env.CLAUDE_CONFIG_DIR = home;
    Object.assign(env, auth.environment);
  }
  return env;
}
