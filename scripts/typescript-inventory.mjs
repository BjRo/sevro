import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { object } from "./coverage/records";
import { ESLint } from "eslint";

/** @type {Record<string, RegExp>} */
const rolePaths = {
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

/** @param {Record<string, string[]>} inventory */
function checkRoles(inventory) {
  for (const [kind, files] of Object.entries(inventory)) {
    const pattern = rolePaths[kind];
    if (!pattern) throw new Error(`Unknown source disposition: ${kind}`);
    for (const file of files)
      if (!pattern.test(file))
        throw new Error(`Invalid ${kind} source disposition: ${file}`);
  }
  checkGeneratedScope(inventory.generated);
}

/** @param {string[] | undefined} generated */
function checkGeneratedScope(generated) {
  if (
    !generated ||
    generated.length !== generatedFiles.length ||
    !generatedFiles.every((file) => generated.includes(file))
  )
    throw new Error("Expected the four exact generated validators");
}

/** @param {string} root @param {Record<string, string[]>} inventory */
async function checkLintDisposition(root, inventory) {
  const linter = new ESLint({ cwd: root });
  for (const [kind, files] of Object.entries(inventory)) {
    await requireLintedFiles(linter, root, files, kind);
  }
}

/** @param {ESLint} linter @param {string} root @param {string[]} files @param {string} kind */
async function requireLintedFiles(linter, root, files, kind) {
  for (const file of files) {
    const configuration = /** @type {unknown} */ (
      await linter.calculateConfigForFile(resolve(root, file))
    );
    if (!configuration) throw new Error(`Source is outside lint: ${file}`);
    if (kind !== "generated") requireUnsafeRules(configuration, file);
  }
}

/** @param {unknown} configuration @param {string} file */
function requireUnsafeRules(configuration, file) {
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

/** @param {unknown} setting */
function errorRule(setting) {
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

/** @param {unknown} value @returns {value is string[]} */
function fileList(value) {
  return (
    Array.isArray(value) && value.every((file) => typeof file === "string")
  );
}

/** @param {string} root */
function readInventory(root) {
  const input = object(
    /** @type {unknown} */ (
      JSON.parse(readFileSync(join(root, "typescript-sources.json"), "utf8"))
    ),
  );
  /** @type {Record<string, string[]>} */
  const inventory = {};
  for (const [kind, files] of Object.entries(input)) {
    if (!kinds.includes(kind))
      throw new Error(`Unknown source disposition: ${kind}`);
    if (!fileList(files)) throw new Error(`Invalid source inventory: ${kind}`);
    inventory[kind] = files;
  }
  requireDispositions(inventory);
  return inventory;
}

/** @param {Record<string, string[]>} inventory */
function requireDispositions(inventory) {
  for (const kind of kinds)
    if (!inventory[kind])
      throw new Error(`Missing source disposition: ${kind}`);
}

/** @param {string} file */
function sourceFile(file) {
  return (
    !/^(?:node_modules|\.git|\.quality|\.worktrees)\//.test(file) &&
    /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(file)
  );
}

/** @param {string[]} found @param {string[]} declared */
function compareInventory(found, declared) {
  if (new Set(declared).size !== declared.length)
    throw new Error("Duplicate source inventory entry");
  for (const file of found) {
    if (!declared.includes(file))
      throw new Error(`Unregistered source: ${file}`);
  }
  requireFound(declared, found);
}

/** @param {string[]} declared @param {string[]} found */
function requireFound(declared, found) {
  for (const file of declared) {
    if (!found.includes(file))
      throw new Error(`Missing inventoried source: ${file}`);
  }
}

/** @param {string} root @param {Record<string, string[]>} inventory */
function checkTypedDisposition(root, inventory) {
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

/** @param {string} root @param {string[]} declared @param {Set<string>} files */
function requireTyped(root, declared, files) {
  for (const file of declared) {
    if (!files.has(resolve(root, file)))
      throw new Error(`Source is outside typing: ${file}`);
  }
}

/** @param {string} root */
export function sourceInventory(root) {
  const inventory = readInventory(root);
  const declared = Object.values(inventory).flat();
  const found = [
    ...new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true, dot: true }),
  ].filter(sourceFile);
  compareInventory(found, declared);
  checkRoles(inventory);
  return inventory;
}

/** @param {string} root */
export function productionSources(root) {
  const files = sourceInventory(root).production;
  if (!files) throw new Error("Missing production source inventory");
  return files;
}

/** @param {string} root */
export async function checkInventory(root) {
  const inventory = sourceInventory(root);
  checkTypedDisposition(root, inventory);
  await checkLintDisposition(root, inventory);
  return inventory;
}
