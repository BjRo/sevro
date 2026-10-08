import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PreparationResult } from "../../src/extension-session";

export const guideRoot = resolve(import.meta.dir, "../..");
export const guidePath = ".agents/skills/sevro-guide/SKILL.md";
export const mirrorPath = ".claude/skills/sevro-guide/SKILL.md";
export const casesPath = ".agents/skills/sevro-guide/evals/cases.json";
const fixtureRoots = [
  "README.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "docs",
  "examples",
  "schemas",
  guidePath,
  mirrorPath,
];

async function collectFiles(relativePath: string): Promise<string[]> {
  const info = await lstat(join(guideRoot, relativePath));
  if (info.isFile()) return [relativePath];
  if (!info.isDirectory()) throw new Error("Guide fixtures refuse symlinks");
  const children = await readdir(join(guideRoot, relativePath));
  const nested = await Promise.all(
    children.sort().map((name) => collectFiles(relativePath + "/" + name)),
  );
  return nested.flat();
}

export async function fixtureSources(): Promise<string[]> {
  return (await Promise.all(fixtureRoots.map(collectFiles))).flat();
}

export function fixtureArtifact(relativePath: string, bytes: Buffer) {
  return {
    id:
      "sevro.guide.fixture." +
      createHash("sha256").update(relativePath).digest("hex"),
    relativePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"),
    gitExclude: true,
  };
}

function fixtureVariant(files: Record<string, string>, kind?: string): void {
  if (kind === "missing") delete files["docs/getting-started.md"];
  if (kind === "conflict")
    files["README.md"] = (files["README.md"] ?? "").replaceAll(
      "@bjoernrochel/sevro",
      "@example/sevro-cloud",
    );
  if (kind === "stale")
    files["docs/legacy-validation.md"] =
      "# Historical validation\n\nA past prototype was fully verified on Linux. This is an old observation, not a current support contract.\n";
}

export async function guideFixture(kind?: string) {
  const files: Record<string, string> = {};
  const artifacts: PreparationResult["artifacts"] = [];
  for (const path of await fixtureSources()) {
    const bytes = await readFile(join(guideRoot, path));
    const text = bytes.toString("utf8");
    if (
      path === guidePath ||
      path === mirrorPath ||
      !Buffer.from(text).equals(bytes)
    )
      artifacts.push(fixtureArtifact(path, bytes));
    else files[path] = text;
  }
  fixtureVariant(files, kind);
  files[".claude/settings.json"] = JSON.stringify({
    disableAllHooks: true,
    permissions: {
      deny: ["Edit", "Write", "Bash", "Agent", "Task", "WebFetch", "WebSearch"],
    },
  });
  return { files, artifacts };
}
