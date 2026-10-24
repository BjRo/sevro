import { spawnSync } from "node:child_process";
import { which } from "./executable";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

export const recipeNames = [
  "coding-change",
  "host-tools",
  "node",
  "python-uv",
  "mise",
  "semantic",
  "lifecycle",
  "repository-skill",
  "plugins",
];

function validateSelection(
  recipe: string,
  route: string,
  flags: string[],
): void {
  if (!recipeNames.includes(recipe))
    throw new Error(`Choose a recipe: ${recipeNames.join(", ")}`);
  if (!["deterministic", "codex", "claude"].includes(route))
    throw new Error("Choose deterministic, codex, or claude");
  if (flags.some((flag) => !["--dry", "--fail", "--goals-only"].includes(flag)))
    throw new Error("Supported flags: --dry --fail --goals-only");
}

function validateNativeRecipe(recipe: string, route: string): void {
  if (
    ["repository-skill", "plugins"].includes(recipe) &&
    route === "deterministic"
  )
    throw new Error(
      "Skill and plugin recipes require codex or claude (add --dry to prepare without model calls)",
    );
}

export function selectedOptions() {
  const [recipe = "", route = "deterministic", ...flags] =
    process.argv.slice(2);
  validateSelection(recipe, route, flags);
  validateNativeRecipe(recipe, route);
  validateGoalsStep(flags);
  return {
    recipe,
    route,
    dry: flags.includes("--dry"),
    fail: flags.includes("--fail"),
    goalsOnly: flags.includes("--goals-only"),
  };
}
export type RecipeOptions = ReturnType<typeof selectedOptions>;

function validateGoalsStep(flags: string[]): void {
  if (flags.includes("--goals-only") && !flags.includes("--dry"))
    throw new Error(
      "--goals-only is a dry preparation step; omit it for the complete hook recipe",
    );
}

export function requireTool(name: string): string {
  const path = which(name);
  if (!path)
    throw new Error(
      `Recipe prerequisite missing: install ${name} and put it on PATH`,
    );
  return path;
}

export function runtimeFile(options: RecipeOptions): string {
  const files: Record<string, string> = {
    "coding-change": "path",
    "host-tools": "path",
    node: "path",
    "python-uv": "python-uv",
    mise: "mise",
    plugins: options.goalsOnly ? "goals" : "plugins",
  };
  return join(
    import.meta.dirname,
    "runtime",
    `${files[options.recipe] ?? "empty"}.json`,
  );
}

function languagePrerequisites(recipe: string): void {
  if (recipe === "python-uv")
    process.env.RECIPE_PYTHON ??= requireTool("python3");
  if (recipe === "mise") selectMiseNode();
  if (recipe === "host-tools") requireStandaloneRipgrep();
}

function requireStandaloneRipgrep(): void {
  const roots = [
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  ];
  const paths = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => !roots.some((root) => entry.startsWith(root)));
  if (!which("rg", paths.join(delimiter)))
    throw new Error(
      "Install standalone ripgrep outside Codex/Claude credential directories, then put it on PATH (for example brew install ripgrep or apt-get install ripgrep)",
    );
}

function selectMiseNode(): void {
  const result = spawnSync(requireTool("mise"), ["where", "node@24.13.0"], {
    encoding: "utf8",
  });
  const installation = result.stdout.trim();
  if (result.status !== 0 || !isAbsolute(installation))
    throw new Error(
      "Install the recipe's Node with mise install node@24.13.0 before running it",
    );
  process.env.PATH = `${join(installation, "bin")}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`;
}

export function runtimePrerequisites(recipe: string): void {
  const tools: Record<string, string[]> = {
    "coding-change": ["node"],
    "host-tools": ["rg"],
    node: ["node"],
    "python-uv": ["uv", "python3"],
    mise: ["mise"],
  };
  for (const tool of tools[recipe] ?? []) requireTool(tool);
  languagePrerequisites(recipe);
}
