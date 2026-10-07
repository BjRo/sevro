import type ts from "typescript";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let parser: typeof ts | undefined;

function typescript(): typeof ts {
  return (parser ??= require("typescript") as typeof ts);
}

export interface LiteralExecutorCommand {
  command: string;
  cwd?: string;
  shell?: string;
}

function primitive(node: ts.Expression): string | number | boolean | undefined {
  const ts = typescript();
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function literalOptions(
  node: ts.Expression,
): Map<string, string | number | boolean> | undefined {
  const ts = typescript();
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  const values = new Map<string, string | number | boolean>();
  const allowed = new Set([
    "cmd",
    "workdir",
    "shell",
    "yield_time_ms",
    "max_output_tokens",
    "login",
    "tty",
  ]);
  for (const property of node.properties) {
    const option = literalOption(property);
    if (!option || !validOptionName(option.name, allowed, values))
      return undefined;
    values.set(option.name, option.value);
  }
  return values;
}

function literalOption(
  property: ts.ObjectLiteralElementLike,
): { name: string; value: string | number | boolean } | undefined {
  const ts = typescript();
  if (!ts.isPropertyAssignment(property)) return undefined;
  const name = propertyName(property.name);
  const value = primitive(property.initializer);
  if (!name || value === undefined) return undefined;
  return { name, value };
}

function validOptionName(
  name: string,
  allowed: Set<string>,
  values: Map<string, unknown>,
): boolean {
  return allowed.has(name) && !values.has(name);
}

function propertyName(name: ts.PropertyName): string | undefined {
  const ts = typescript();
  return ts.isIdentifier(name) || ts.isStringLiteral(name)
    ? name.text
    : undefined;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function commandOptions(
  node: ts.Expression,
): LiteralExecutorCommand | undefined {
  const values = literalOptions(node);
  if (!values) return undefined;
  return resolvedCommandOptions(
    values.get("cmd"),
    values.get("workdir"),
    values.get("shell"),
  );
}

function nonemptyCommand(command: unknown): command is string {
  return typeof command === "string" && command.length > 0;
}

function resolvedCommandOptions(
  command: unknown,
  cwd: unknown,
  shell: unknown,
): LiteralExecutorCommand | undefined {
  if (
    !nonemptyCommand(command) ||
    !optionalString(cwd) ||
    !optionalString(shell)
  )
    return undefined;
  return { command, ...optionalCommandLocations(cwd, shell) };
}

function optionalCommandLocations(
  cwd: string | undefined,
  shell: string | undefined,
) {
  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(shell === undefined ? {} : { shell }),
  };
}

function commandDeclaration(statement: ts.Statement):
  | {
      name: string;
      command: LiteralExecutorCommand;
    }
  | undefined {
  const declaration = singleConstDeclaration(statement);
  if (!declaration) return undefined;
  const name = literalVariableName(declaration.name);
  if (name === undefined || !declaration.initializer) return undefined;
  const command = awaitedCommand(declaration.initializer);
  return command ? { name, command } : undefined;
}

function singleConstDeclaration(
  statement: ts.Statement,
): ts.VariableDeclaration | undefined {
  const ts = typescript();
  if (
    !ts.isVariableStatement(statement) ||
    !(statement.declarationList.flags & ts.NodeFlags.Const) ||
    statement.declarationList.declarations.length !== 1
  )
    return undefined;
  return statement.declarationList.declarations[0];
}

function literalVariableName(name: ts.BindingName): string | undefined {
  const ts = typescript();
  if (!ts.isIdentifier(name) || ["tools", "text", "store"].includes(name.text))
    return undefined;
  return name.text;
}

function commandAccess(expression: ts.Expression): boolean {
  const ts = typescript();
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "tools" &&
    expression.name.text === "exec_command"
  );
}

function executorCall(
  expression: ts.Expression,
): ts.CallExpression | undefined {
  const ts = typescript();
  if (
    !ts.isCallExpression(expression) ||
    expression.arguments.length !== 1 ||
    !commandAccess(expression.expression)
  )
    return undefined;
  return expression;
}

function awaitedCommand(
  expression: ts.Expression,
): LiteralExecutorCommand | undefined {
  const ts = typescript();
  if (!ts.isAwaitExpression(expression)) return undefined;
  const call = executorCall(expression.expression);
  if (!call) return undefined;
  const [argument] = call.arguments;
  return argument ? commandOptions(argument) : undefined;
}

function resultProperty(
  node: ts.Expression,
  name: string,
  field: string,
): boolean {
  const ts = typescript();
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name &&
    node.name.text === field
  );
}

function outputStatement(
  statement: ts.Statement,
  name: string,
): string | undefined {
  const ts = typescript();
  if (
    !ts.isExpressionStatement(statement) ||
    !ts.isCallExpression(statement.expression) ||
    !ts.isIdentifier(statement.expression.expression)
  )
    return undefined;
  return directOutput(statement.expression, name);
}

function directOutput(
  call: ts.CallExpression,
  name: string,
): string | undefined {
  const operation = (call.expression as ts.Identifier).text;
  if (operation === "text" && textOutput(call, name)) return "text";
  if (operation === "store" && storeOutput(call, name)) return "store";
  return undefined;
}

function textOutput(call: ts.CallExpression, name: string): boolean {
  const [argument] = call.arguments;
  return (
    call.arguments.length === 1 &&
    argument !== undefined &&
    resultProperty(argument, name, "output")
  );
}

function storeOutput(call: ts.CallExpression, name: string): boolean {
  const ts = typescript();
  const [key, value] = call.arguments;
  if (call.arguments.length !== 2 || key === undefined || value === undefined)
    return false;
  return (
    ts.isStringLiteralLike(key) && resultProperty(value, name, "session_id")
  );
}

function validExecutorSource(source: ts.SourceFile): boolean {
  const diagnostics = (
    source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  return (
    diagnostics !== undefined &&
    diagnostics.length === 0 &&
    source.statements.length >= 2 &&
    source.statements.length <= 3
  );
}

function validExecutorOutputs(outputs: (string | undefined)[]): boolean {
  return (
    !outputs.some((output) => output === undefined) &&
    outputs.filter((output) => output === "text").length === 1 &&
    outputs.filter((output) => output === "store").length <= 1
  );
}

/** Recognize only one unconditional awaited command whose output is returned directly. */
export function literalExecutorCommand(
  code: unknown,
): LiteralExecutorCommand | undefined {
  if (typeof code !== "string") return undefined;
  const ts = typescript();
  const source = ts.createSourceFile(
    "native-exec.js",
    code,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  if (!validExecutorSource(source)) return undefined;
  const declaration = leadingCommandDeclaration(source);
  if (!declaration) return undefined;
  const outputs = source.statements
    .slice(1)
    .map((statement) => outputStatement(statement, declaration.name));
  if (!validExecutorOutputs(outputs)) return undefined;
  return declaration.command;
}

function leadingCommandDeclaration(source: ts.SourceFile) {
  const [statement] = source.statements;
  return statement ? commandDeclaration(statement) : undefined;
}
