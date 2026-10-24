import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { object } from "./coverage/records";
import { ESLint } from "eslint";
import { gitArguments, gitEnvironment } from "../src/git";
import { generatedValidators } from "./schema-catalog";

type SourceKind =
  | "production"
  | "generated"
  | "declarations"
  | "tooling"
  | "tests"
  | "examples";
type SourceInventory = Record<SourceKind, string[]>;
const rolePaths: [SourceKind, RegExp][] = [
  ["production", /^src\/.*(?<!\.d)\.ts$/],
  ["tooling", /^(?:scripts\/|eslint\.config\.mjs$)/],
  ["tests", /^tests\//],
  ["examples", /^examples\//],
];

function sourceDisposition(file: string): SourceKind {
  if (generatedValidators.includes(file)) return "generated";
  if (/\.d\.[cm]?ts$/.test(file)) return "declarations";
  return directoryDisposition(file);
}

function directoryDisposition(file: string): SourceKind {
  const matches = rolePaths.filter(([, pattern]) => pattern.test(file));
  const match = matches[0];
  if (!match || matches.length !== 1)
    throw new Error(`Unclassified or overlapping source disposition: ${file}`);
  return match[0];
}

function checkGeneratedScope(generated: string[] | undefined) {
  if (
    !generated ||
    generated.length !== generatedValidators.length ||
    !generatedValidators.every((file) => generated.includes(file))
  )
    throw new Error("Expected the five exact generated validators");
}

async function checkLintDisposition(
  root: string,
  inventory: Record<string, string[]>,
) {
  const linter = new ESLint({ cwd: root });
  for (const [kind, files] of Object.entries(inventory)) {
    await requireLintedFiles(linter, root, files, kind);
  }
}

async function requireLintedFiles(
  linter: ESLint,
  root: string,
  files: string[],
  kind: string,
) {
  for (const file of files) {
    const configuration: unknown = await linter.calculateConfigForFile(
      resolve(root, file),
    );
    if (!configuration) throw new Error(`Source is outside lint: ${file}`);
    if (kind !== "generated") requireUnsafeRules(configuration, file);
  }
}

function requireUnsafeRules(configuration: unknown, file: string) {
  const rules = object(object(configuration).rules);
  for (const name of [
    "no-unsafe-assignment",
    "no-unsafe-argument",
    "no-unsafe-call",
    "no-unsafe-member-access",
    "no-unsafe-return",
    "no-floating-promises",
    "no-misused-promises",
  ]) {
    const setting = rules[`@typescript-eslint/${name}`];
    if (!errorRule(setting))
      throw new Error(`Missing type-aware lint rule ${name}: ${file}`);
  }
}

function errorRule(setting: unknown) {
  return setting === 2 || (Array.isArray(setting) && setting[0] === 2);
}

function gitOutput(root: string, args: string[]): string {
  const child = Bun.spawnSync(gitArguments(args), {
    cwd: root,
    env: gitEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0)
    throw new Error(
      `Cannot read source inventory from Git: ${child.stderr.toString()}`,
    );
  return child.stdout.toString();
}

function readInventory(root: string) {
  if (
    gitOutput(root, ["rev-parse", "--show-toplevel"]).trim() !==
    realpathSync(root)
  )
    throw new Error("Source inventory root must be the Git repository root");
  const files = gitOutput(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .split("\0")
    .filter(sourceFile);
  const inventory: SourceInventory = {
    production: [],
    generated: [],
    declarations: [],
    tooling: [],
    tests: [],
    examples: [],
  };
  for (const file of [...new Set(files)].sort()) {
    inventory[sourceDisposition(file)].push(file);
  }
  return inventory;
}

function sourceFile(file: string) {
  return (
    !/^(?:node_modules|\.git|\.quality|\.worktrees)\//.test(file) &&
    /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(file)
  );
}

function compareInventory(found: string[], declared: string[]) {
  if (new Set(declared).size !== declared.length)
    throw new Error("Duplicate source inventory entry");
  for (const file of found) {
    if (!declared.includes(file))
      throw new Error(`Unregistered source: ${file}`);
  }
  requireFound(declared, found);
}

function requireFound(declared: string[], found: string[]) {
  for (const file of declared) {
    if (!found.includes(file))
      throw new Error(`Missing inventoried source: ${file}`);
  }
}

function checkTypedDisposition(
  root: string,
  inventory: Record<string, string[]>,
) {
  const configuration = ts.getParsedCommandLineOfConfigFile(
    join(root, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  if (!configuration) throw new Error("Cannot read TypeScript configuration");
  const files = new Set(configuration.fileNames.map((path) => resolve(path)));
  for (const [kind, declared] of Object.entries(inventory)) {
    if (kind === "generated") continue;
    requireTyped(root, declared, files);
  }
}

function requireTyped(root: string, declared: string[], files: Set<string>) {
  for (const file of declared) {
    if (!files.has(resolve(root, file)))
      throw new Error(`Source is outside typing: ${file}`);
  }
}

export function sourceInventory(root: string) {
  const inventory = readInventory(root);
  const declared = Object.values(inventory).flat();
  const found = [
    ...new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true, dot: true }),
  ].filter(sourceFile);
  compareInventory(found, declared);
  checkGeneratedScope(inventory.generated);
  return inventory;
}

export function productionSources(root: string) {
  return sourceInventory(root).production;
}

export async function checkInventory(root: string) {
  const inventory = sourceInventory(root);
  checkTypedDisposition(root, inventory);
  await checkLintDisposition(root, inventory);
  return inventory;
}
