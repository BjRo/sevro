import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { record } from "./extension-methods";
import { requireTool, type RecipeOptions } from "./run-options";

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

async function caseFile(
  options: RecipeOptions,
  state: string,
): Promise<string[]> {
  const value = record(
    JSON.parse(
      await readFile(
        join(import.meta.dir, "cases", `${options.recipe}.json`),
        "utf8",
      ),
    ) as unknown,
  );
  if (options.recipe === "coding-change") {
    const test = await readFile(
      join(import.meta.dir, "coding-change/check.ts"),
      "utf8",
    );
    const checks: unknown[] = Array.isArray(value.checks) ? value.checks : [];
    const check = record(checks[0]);
    const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(test);
    const protectedTest = shellQuote(
      join(import.meta.dir, "coding-change/check.ts"),
    );
    record(check.configuration).run =
      `test ! -r ${protectedTest}\nnode --input-type=module -e ${shellQuote(javascript)}`;
  }
  if (options.fail) negativeFixture(value, options.recipe);
  const path = join(state, "case.json");
  await writeFile(path, JSON.stringify(value));
  return ["--case-file", path];
}

function negativeFixture(value: Record<string, unknown>, recipe: string): void {
  if (["coding-change", "semantic"].includes(recipe)) {
    value.prompt =
      "Deliberate negative control: leave math.cjs unchanged if present and respond only: npm start on port 9000.";
    return;
  }
  const files = record(record(value.fixture).files);
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== "string")
      throw new Error("Expected inline fixture text");
    files[path] = content.replaceAll("3000", "9000");
  }
}

async function extensionFiles(
  options: RecipeOptions,
  state: string,
): Promise<string[]> {
  const command = join(state, "extension-command.json");
  await writeFile(
    command,
    JSON.stringify([
      process.execPath,
      join(import.meta.dir, "extension.ts"),
      options.recipe,
      options.route,
      options.fail ? "fail" : "pass",
    ]),
  );
  const sources = [
    "extension.ts",
    "extension-methods.ts",
    "extension-artifacts.ts",
    "repository-skill/.agents/skills/startup-guide/SKILL.md",
    "repository-skill/.claude/skills/startup-guide/SKILL.md",
  ];
  return [
    "--extension-command-file",
    command,
    "--case-id",
    "recipe-extension",
    ...sources.flatMap((path) => [
      "--extension-source-file",
      join(import.meta.dir, path),
    ]),
  ];
}

export async function recipeInputs(
  options: RecipeOptions,
  state: string,
): Promise<string[]> {
  if (["lifecycle", "repository-skill", "plugins"].includes(options.recipe))
    return extensionFiles(options, state);
  return caseFile(options, state);
}

async function codexAuthentication(
  options: RecipeOptions,
  state: string,
): Promise<string> {
  if (!options.dry) {
    const path = process.env.SEVRO_RECIPE_CODEX_AUTH;
    if (!path)
      throw new Error(
        "Set SEVRO_RECIPE_CODEX_AUTH to your private Codex auth.json path",
      );
    return path;
  }
  const path = join(state, "dry-auth.json");
  await writeFile(path, "{}\n");
  return path;
}

export async function hostArguments(
  options: RecipeOptions,
  state: string,
): Promise<string[]> {
  if (options.route === "deterministic")
    return ["--adapter-module", join(import.meta.dir, "candidate.ts")];
  const model = selectedModel(options.dry, "SEVRO_RECIPE_MODEL");
  if (!model)
    throw new Error(
      "Set SEVRO_RECIPE_MODEL to an available model for the selected native host",
    );
  const args = [
    "--host",
    options.route,
    "--model",
    model,
    "--effort",
    "medium",
  ];
  if (options.route === "codex")
    return [
      ...args,
      "--codex-bin",
      requireTool("codex"),
      "--codex-auth-file",
      await codexAuthentication(options, state),
    ];
  return [
    ...args,
    "--claude-bin",
    requireTool("claude"),
    ...(options.recipe === "repository-skill"
      ? ["--claude-project-settings"]
      : []),
  ];
}

export async function semanticArguments(
  options: RecipeOptions,
  state: string,
): Promise<string[]> {
  if (options.recipe !== "semantic") return [];
  if (options.route === "deterministic")
    return [
      "--semantic-adapter-module",
      join(import.meta.dir, "semantic-judge.ts"),
    ];
  const model = selectedModel(options.dry, "SEVRO_RECIPE_JUDGE_MODEL");
  if (!model)
    throw new Error(
      "Set SEVRO_RECIPE_JUDGE_MODEL for the separate Codex judge route",
    );
  const args = [
    "--semantic-host",
    "codex",
    "--semantic-model",
    model,
    "--semantic-effort",
    "medium",
  ];
  if (options.route === "codex") return args;
  return [
    ...args,
    "--codex-bin",
    requireTool("codex"),
    "--codex-auth-file",
    await codexAuthentication(options, state),
  ];
}

function selectedModel(dry: boolean, variable: string): string | undefined {
  return dry ? "dry-model" : process.env[variable];
}
