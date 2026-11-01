import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  chmod,
  realpath,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "dist");

async function declarationSourceRoot(): Promise<string> {
  const source = process.env.SEVRO_COVERAGE_SOURCE_ROOT;
  if (!source) return root;
  // Only the paired instrumented candidate may use this pristine source snapshot.
  const project = await realpath(join(source, "../project"));
  return project === (await realpath(root)) ? await realpath(source) : root;
}

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
  const visit = (
    node: ts.Node,
    parent: ts.Node,
    ancestor: ts.Node,
  ): ts.VisitResult<ts.Node> => {
    if (ts.isStringLiteral(node) && moduleLiteral(parent, ancestor))
      return context.factory.createStringLiteral(modulePath(node.text));
    return ts.visitEachChild(
      node,
      (child) => visit(child, node, parent),
      context,
    );
  };
  return (source) =>
    ts.visitEachChild(source, (child) => visit(child, source, source), context);
};

function moduleLiteral(parent: ts.Node, ancestor: ts.Node): boolean {
  return (
    isModuleSpecifier(parent) ||
    (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(ancestor))
  );
}

function isModuleSpecifier(parent: ts.Node): boolean {
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

const configuration = ts.readConfigFile(join(root, "tsconfig.json"), (path) =>
  ts.sys.readFile(path),
);
const parsed = ts.parseJsonConfigFileContent(
  configuration.config,
  ts.sys,
  root,
);
const declarationOptions: ts.CompilerOptions = {
  ...parsed.options,
  noEmit: false,
  declaration: true,
  emitDeclarationOnly: true,
  rootDir: root,
  outDir: output,
};
const originalSource = await declarationSourceRoot();
const declarationHost = ts.createCompilerHost(declarationOptions);
declarationHost.readFile = (path) => {
  const local = relative(root, path);
  const source = local.startsWith(`src${sep}`)
    ? join(originalSource, local)
    : path;
  return ts.sys.readFile(source);
};
const declarations = ts.createProgram(
  [join(root, "src/api-types.ts")],
  declarationOptions,
  declarationHost,
);
const emitted = declarations.emit(undefined, undefined, undefined, true, {
  afterDeclarations: [
    rewriteModules as ts.TransformerFactory<ts.SourceFile | ts.Bundle>,
  ],
});
if (emitted.emitSkipped)
  throw new Error(
    ts.formatDiagnostics(emitted.diagnostics, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
const entrypoint = ts.transpileDeclaration(
  await readFile(join(originalSource, "src/index.ts"), "utf8"),
  {
    fileName: "src/index.ts",
    compilerOptions: parsed.options,
    transformers: {
      afterDeclarations: [
        rewriteModules as ts.TransformerFactory<ts.SourceFile | ts.Bundle>,
      ],
    },
  },
);
await writeFile(join(output, "src/index.d.ts"), entrypoint.outputText);
