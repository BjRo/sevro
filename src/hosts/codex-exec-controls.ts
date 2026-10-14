import { createRequire } from "node:module";
import type ts from "typescript";
import { isRecord, isUnknownArray } from "../value-guards";

const require = createRequire(import.meta.url);
let parser: typeof ts | undefined;
function typescript(): typeof ts {
  return (parser ??= require("typescript") as typeof ts);
}

interface Entry {
  ordinal: number;
  payload: Record<string, unknown>;
}
interface SubmittedCall {
  index: number;
  namespace: "functions" | "collaboration" | "other";
  name: string;
}
export interface ExecCallReceipt {
  ordinal: number;
  completeness: "complete" | "partial";
  calls: SubmittedCall[];
}

function toolNamespace(name: string): SubmittedCall["namespace"] {
  if (
    [
      "spawn_agent",
      "list_agents",
      "wait_agent",
      "followup_task",
      "send_message",
      "interrupt_agent",
    ].includes(name)
  )
    return "collaboration";
  if (
    [
      "create_goal",
      "get_goal",
      "update_goal",
      "exec_command",
      "write_stdin",
    ].includes(name)
  )
    return "functions";
  return "other";
}
function toolName(node: ts.Expression): string | undefined {
  const ts = typescript();
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "tools")
    return undefined;
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(node.name.text)
    ? node.name.text
    : undefined;
}
function literal(node: ts.Expression): boolean {
  const ts = typescript();
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return true;
  return [
    ts.SyntaxKind.TrueKeyword,
    ts.SyntaxKind.FalseKeyword,
    ts.SyntaxKind.NullKeyword,
  ].includes(node.kind);
}
function member(node: ts.Expression, owner: string, names: string[]): boolean {
  const ts = typescript();
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === owner &&
    names.includes(node.name.text)
  );
}
function localName(node: ts.BindingName): string | undefined {
  const ts = typescript();
  if (!ts.isIdentifier(node)) return undefined;
  return ["tools", "text", "store", "Promise", "load"].includes(node.text)
    ? undefined
    : node.text;
}
class Submission {
  readonly calls: SubmittedCall[] = [];
  private readonly locals = new Set<string>();
  private readonly collections = new Set<string>();
  private nodes = 0;
  expression(node: ts.Expression): boolean {
    const ts = typescript();
    if (++this.nodes > 2048) return false;
    switch (true) {
      case literal(node):
        return true;
      case ts.isAwaitExpression(node):
        return this.expression(node.expression);
      case ts.isObjectLiteralExpression(node):
        return node.properties.every((property) => this.property(property));
      case ts.isArrayLiteralExpression(node):
        return node.elements.every((element) => this.expression(element));
      case ts.isIdentifier(node):
        return this.locals.has(node.text);
      case ts.isPropertyAccessExpression(node):
        return this.localProperty(node);
      case ts.isCallExpression(node):
        return this.call(node);
      default:
        return false;
    }
  }
  private property(node: ts.ObjectLiteralElementLike): boolean {
    const ts = typescript();
    if (!ts.isPropertyAssignment(node) || ts.isComputedPropertyName(node.name))
      return false;
    return this.expression(node.initializer);
  }
  private call(node: ts.CallExpression): boolean {
    if (this.outputEach(node)) return true;
    if (!node.arguments.every((argument) => this.expression(argument)))
      return false;
    return helperCall(node.expression) || this.retainToolCall(node.expression);
  }
  private retainToolCall(expression: ts.Expression): boolean {
    const name = toolName(expression);
    if (!name || this.calls.length >= 128) return false;
    this.calls.push({
      index: this.calls.length,
      namespace: toolNamespace(name),
      name,
    });
    return name !== "exec";
  }
  statement(node: ts.Statement): boolean {
    const ts = typescript();
    if (ts.isVariableStatement(node))
      return this.declarations(node.declarationList);
    if (ts.isForOfStatement(node)) return this.outputLoop(node);
    return ts.isExpressionStatement(node) && this.expression(node.expression);
  }
  private localProperty(node: ts.PropertyAccessExpression): boolean {
    const ts = typescript();
    return (
      ts.isIdentifier(node.expression) &&
      this.locals.has(node.expression.text) &&
      !["constructor", "__proto__", "prototype"].includes(node.name.text)
    );
  }
  private declarations(list: ts.VariableDeclarationList): boolean {
    const ts = typescript();
    if (!(list.flags & ts.NodeFlags.Const)) return false;
    return list.declarations.every((declaration) =>
      this.declaration(declaration),
    );
  }
  private declaration(node: ts.VariableDeclaration): boolean {
    const name = this.declaredName(node.name);
    if (!name || !node.initializer) return false;
    if (!this.expression(node.initializer)) return false;
    this.locals.add(name);
    if (collectionExpression(node.initializer)) this.collections.add(name);
    return true;
  }
  private declaredName(node: ts.BindingName): string | undefined {
    const name = localName(node);
    return name && !this.locals.has(name) ? name : undefined;
  }
  private outputEach(node: ts.CallExpression): boolean {
    const ts = typescript();
    const [callback] = node.arguments;
    if (
      node.arguments.length !== 1 ||
      !callback ||
      !ts.isIdentifier(callback) ||
      callback.text !== "text"
    )
      return false;
    return [...this.collections].some((name) =>
      member(node.expression, name, ["forEach"]),
    );
  }
  private outputLoop(node: ts.ForOfStatement): boolean {
    const ts = typescript();
    if (!this.collection(node.expression)) return false;
    if (!ts.isVariableDeclarationList(node.initializer)) return false;
    const name = loopVariable(node.initializer);
    return (
      name !== undefined &&
      !this.locals.has(name) &&
      outputLoopBody(node.statement, name)
    );
  }
  private collection(node: ts.Expression): boolean {
    const ts = typescript();
    return ts.isIdentifier(node) && this.collections.has(node.text);
  }
}
function helperCall(node: ts.Expression): boolean {
  const ts = typescript();
  if (ts.isIdentifier(node) && ["text", "store"].includes(node.text))
    return true;
  return member(node, "Promise", ["all", "allSettled"]);
}
function namedIdentifier(
  node: ts.Expression | undefined,
  name: string,
): boolean {
  return (
    node !== undefined && typescript().isIdentifier(node) && node.text === name
  );
}
function collectionExpression(node: ts.Expression): boolean {
  const ts = typescript();
  if (!ts.isAwaitExpression(node) || !ts.isCallExpression(node.expression))
    return false;
  return member(node.expression.expression, "Promise", ["all", "allSettled"]);
}
function loopVariable(list: ts.VariableDeclarationList): string | undefined {
  const ts = typescript();
  if (!(list.flags & ts.NodeFlags.Const) || list.declarations.length !== 1)
    return undefined;
  const declaration = list.declarations[0];
  return declaration && !declaration.initializer
    ? localName(declaration.name)
    : undefined;
}
function outputLoopBody(statement: ts.Statement, name: string): boolean {
  const ts = typescript();
  if (
    !ts.isExpressionStatement(statement) ||
    !ts.isCallExpression(statement.expression)
  )
    return false;
  const call = statement.expression;
  return (
    namedIdentifier(call.expression, "text") &&
    call.arguments.length === 1 &&
    namedIdentifier(call.arguments[0], name)
  );
}
function inspectedSource(code: unknown): Submission | undefined {
  if (typeof code !== "string" || code.length > 65536) return undefined;
  const ts = typescript();
  const source = ts.createSourceFile(
    "submitted.js",
    code,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const diagnostics = (
    source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (diagnostics.length !== 0) return undefined;
  const submission = new Submission();
  return source.statements.every((statement) => submission.statement(statement))
    ? submission
    : undefined;
}
function completedOutput(output: unknown): boolean {
  if (isUnknownArray(output)) return completedBlocks(output);
  if (typeof output !== "string") return false;
  try {
    const blocks: unknown = JSON.parse(output);
    if (!isUnknownArray(blocks)) return false;
    return completedBlocks(blocks);
  } catch {
    return false;
  }
}
function completedBlocks(blocks: unknown[]): boolean {
  return blocks.every(completeTextBlock) && completedHeader(blocks[0]);
}
function completeTextBlock(block: unknown): boolean {
  if (!isRecord(block) || !["text", "input_text"].includes(String(block.type)))
    return false;
  return (
    typeof block.text === "string" &&
    !block.text.includes("Warning: truncated output")
  );
}
function completedHeader(block: unknown): boolean {
  return (
    isRecord(block) &&
    typeof block.text === "string" &&
    /^Script completed\nWall time [0-9]+(?:\.[0-9]+)? seconds\nOutput:\n$/.test(
      block.text,
    )
  );
}
function completedSubmission(entry: Entry, entries: Entry[]): boolean {
  if (!nativeExecNamespace(entry.payload.namespace)) return false;
  const id = entry.payload.call_id;
  if (typeof id !== "string") return false;
  const matches = entries.filter((other) => other.payload.call_id === id);
  if (matches.length !== 2) return false;
  const result = matches.find(
    (other) => other.payload.type === "custom_tool_call_output",
  );
  return laterCompletion(result, entry.ordinal);
}
function laterCompletion(result: Entry | undefined, ordinal: number): boolean {
  return (
    result !== undefined &&
    result.ordinal > ordinal &&
    completedOutput(result.payload.output)
  );
}
function nativeExecNamespace(namespace: unknown): boolean {
  return namespace === undefined || namespace === "functions";
}
/** Static inspection only: submitted code is never executed by the observer. */
export function codexExecCallReceipts(entries: Entry[]): ExecCallReceipt[] {
  return entries
    .filter(
      ({ payload }) =>
        payload.type === "custom_tool_call" && payload.name === "exec",
    )
    .map((entry) => {
      const submission = inspectedSource(entry.payload.input);
      const complete =
        submission !== undefined && completedSubmission(entry, entries);
      return {
        ordinal: entry.ordinal,
        completeness: complete ? "complete" : "partial",
        calls: submission?.calls ?? [],
      };
    });
}
