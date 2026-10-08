import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { object } from "./coverage/records";
import { ESLint } from "eslint";

const rolePaths: Record<string, RegExp> = {
  production: /^src\/.*(?<!\.d)\.ts$/,
  generated:
    /^src\/generated\/(?:cli-result|run-evidence|report|extension)\.cjs$/,
  declarations: /\.d\.[cm]?ts$/,
  tooling: /^(?:scripts\/|eslint\.config\.mjs$)/,
  tests: /^tests\//,
  examples: /^examples\//,
};
const generatedFiles = [
  "cli-result",
  "extension",
  "report",
  "run-evidence",
].map((name) => `src/generated/${name}.cjs`);

function checkRoles(inventory: Record<string, string[]>) {
  for (const [kind, files] of Object.entries(inventory)) {
    const pattern = rolePaths[kind];
    if (!pattern) throw new Error(`Unknown source disposition: ${kind}`);
    for (const file of files)
      if (!pattern.test(file))
        throw new Error(`Invalid ${kind} source disposition: ${file}`);
  }
  checkGeneratedScope(inventory.generated);
}

function checkGeneratedScope(generated: string[] | undefined) {
  if (
    !generated ||
    generated.length !== generatedFiles.length ||
    !generatedFiles.every((file) => generated.includes(file))
  )
    throw new Error("Expected the four exact generated validators");
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

const kinds = [
  "production",
  "generated",
  "declarations",
  "tooling",
  "tests",
  "examples",
];

function fileList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((file) => typeof file === "string")
  );
}

function readInventory(root: string) {
  const value: unknown = JSON.parse(
    readFileSync(join(root, "typescript-sources.json"), "utf8"),
  );
  const input = object(value);
  const inventory: Record<string, string[]> = {};
  for (const [kind, files] of Object.entries(input)) {
    if (!kinds.includes(kind))
      throw new Error(`Unknown source disposition: ${kind}`);
    if (!fileList(files)) throw new Error(`Invalid source inventory: ${kind}`);
    inventory[kind] = files;
  }
  requireDispositions(inventory);
  return inventory;
}

function requireDispositions(inventory: Record<string, string[]>) {
  for (const kind of kinds)
    if (!inventory[kind])
      throw new Error(`Missing source disposition: ${kind}`);
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
  checkRoles(inventory);
  return inventory;
}

export function productionSources(root: string) {
  const files = sourceInventory(root).production;
  if (!files) throw new Error("Missing production source inventory");
  return files;
}

export async function checkInventory(root: string) {
  const inventory = sourceInventory(root);
  checkTypedDisposition(root, inventory);
  await checkLintDisposition(root, inventory);
  return inventory;
}
