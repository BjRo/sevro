import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "dist");

function typescriptPath(path: string): boolean {
  return path.length > 3 && path.endsWith(".ts");
}

function modulePath(path: string): string {
  if (path.endsWith("/package.json")) return "../" + path;
  if (typescriptPath(path)) return path.slice(0, -3) + ".js";
  if (!path.startsWith(".")) return path;
  return /\.[a-z]+$/.test(path) ? path : path + ".js";
}

const rewriteModules: ts.TransformerFactory<ts.SourceFile> = (context) => {
  const visit: ts.Visitor = (node) => {
    if (ts.isStringLiteral(node) && isModuleSpecifier(node))
      return context.factory.createStringLiteral(modulePath(node.text));
    return ts.visitEachChild(node, visit, context);
  };
  return (source) => ts.visitEachChild(source, visit, context);
};

function isModuleSpecifier(node: ts.StringLiteral): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent))
    return true;
  return (
    ts.isCallExpression(parent) &&
    parent.expression.kind === ts.SyntaxKind.ImportKeyword
  );
}

async function compile(path: string) {
  const source = await readFile(join(root, path), "utf8");
  const result = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      sourceMap: true,
      inlineSources: true,
    },
    transformers: { before: [rewriteModules] },
  });
  const destination = join(output, path.replace(/\.ts$/, ".js"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, result.outputText);
  if (!result.sourceMapText)
    throw new Error("compiler did not produce a source map");
  await writeFile(destination + ".map", result.sourceMapText);
}

async function compileDirectory(path: string): Promise<void> {
  for (const entry of await readdir(join(root, path), {
    withFileTypes: true,
  })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await compileDirectory(child);
    else if (entry.name.endsWith(".ts")) await compile(child);
  }
}

await rm(output, { recursive: true, force: true });
for (const directory of ["src", "examples"]) {
  await cp(join(root, directory), join(output, directory), {
    recursive: true,
    filter: (path) => !/\.(?:ts|cts|mts)$/.test(path),
  });
  await compileDirectory(directory);
}
await chmod(join(output, "src/cli.js"), 0o755);
