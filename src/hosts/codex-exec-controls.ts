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
  inspectionReason?:
    | "unsupported_source"
    | "malformed_source"
    | "source_limit"
    | "foreign_namespace"
    | null;
  execution?: "completed" | "failed" | "incomplete";
  output?: "complete" | "truncated" | "unavailable";
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
  return [
    "tools",
    "text",
    "store",
    "Promise",
    "load",
    "JSON",
    "String",
  ].includes(node.text)
    ? undefined
    : node.text;
}
class Submission {
  readonly calls: SubmittedCall[] = [];
  private readonly locals = new Set<string>();
  private readonly collections = new Set<string>();
  private readonly indices = new Set<string>();
  private nodes = 0;
  expression(node: ts.Expression): boolean {
    const ts = typescript();
    if (++this.nodes > 2048) return false;
    switch (true) {
      case literal(node):
        return true;
      case ts.isTemplateExpression(node):
        return node.templateSpans.every((span) =>
          this.expression(span.expression),
        );
      case ts.isBinaryExpression(node):
        return this.composition(node);
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
      case ts.isConditionalExpression(node):
        return [node.condition, node.whenTrue, node.whenFalse].every((part) =>
          this.outputExpression(part),
        );
      case ts.isElementAccessExpression(node):
        return (
          this.collection(node.expression) &&
          typescript().isIdentifier(node.argumentExpression) &&
          this.indices.has(node.argumentExpression.text)
        );
      default:
        return false;
    }
  }
  private property(node: ts.ObjectLiteralElementLike): boolean {
    const ts = typescript();
    if (ts.isSpreadAssignment(node))
      return this.outputExpression(node.expression);
    if (ts.isShorthandPropertyAssignment(node)) return this.shorthand(node);
    if (!ts.isPropertyAssignment(node) || ts.isComputedPropertyName(node.name))
      return false;
    return this.expression(node.initializer);
  }
  private shorthand(node: ts.ShorthandPropertyAssignment): boolean {
    return !node.objectAssignmentInitializer && this.expression(node.name);
  }
  private composition(node: ts.BinaryExpression): boolean {
    if (
      [
        typescript().SyntaxKind.EqualsEqualsEqualsToken,
        typescript().SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(node.operatorToken.kind)
    )
      return (
        this.outputExpression(node.left) && this.outputExpression(node.right)
      );
    return (
      node.operatorToken.kind === typescript().SyntaxKind.PlusToken &&
      this.expression(node.left) &&
      this.expression(node.right)
    );
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
    if (ts.isForStatement(node)) return this.numericOutputLoop(node);
    return ts.isExpressionStatement(node) && this.expression(node.expression);
  }
  private localProperty(node: ts.PropertyAccessExpression): boolean {
    return (
      this.expression(node.expression) &&
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
    if (!node.initializer) return false;
    const names = this.bindingNames(node.name, node.initializer);
    if (!names) return false;
    if (!this.expression(node.initializer)) return false;
    names.forEach((name) => this.locals.add(name));
    this.retainCollection(node.name, node.initializer, names);
    return true;
  }
  private retainCollection(
    name: ts.BindingName,
    initializer: ts.Expression,
    names: string[],
  ): void {
    if (localName(name) && collectionExpression(initializer))
      names.forEach((name) => this.collections.add(name));
  }
  private bindingNames(
    node: ts.BindingName,
    initializer: ts.Expression,
  ): string[] | undefined {
    const ts = typescript();
    if (ts.isIdentifier(node)) {
      const name = this.declaredName(node);
      return name ? [name] : undefined;
    }
    if (!ts.isArrayBindingPattern(node) || !collectionExpression(initializer))
      return undefined;
    return this.batchNames(node);
  }
  private batchNames(node: ts.ArrayBindingPattern): string[] | undefined {
    const names = node.elements.map((element) => this.batchBinding(element));
    if (!names.every((name): name is string => name !== undefined))
      return undefined;
    return new Set(names).size === names.length ? names : undefined;
  }
  private batchBinding(node: ts.ArrayBindingElement): string | undefined {
    const ts = typescript();
    if (!ts.isBindingElement(node)) return undefined;
    if (node.dotDotDotToken || node.initializer || node.propertyName)
      return undefined;
    return this.declaredName(node.name);
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
    if (!name || this.locals.has(name)) return false;
    this.locals.add(name);
    const valid = this.outputBody(node.statement);
    this.locals.delete(name);
    return valid;
  }
  private outputExpression(node: ts.Expression): boolean {
    const count = this.calls.length;
    return this.expression(node) && this.calls.length === count;
  }
  private numericOutputLoop(node: ts.ForStatement): boolean {
    const name = numericLoopVariable(node);
    if (!name || this.locals.has(name)) return false;
    const condition = node.condition as ts.BinaryExpression;
    const bound = condition.right as ts.PropertyAccessExpression;
    if (!this.collection(bound.expression)) return false;
    this.locals.add(name);
    this.indices.add(name);
    const valid = this.outputBody(node.statement);
    this.locals.delete(name);
    this.indices.delete(name);
    return valid;
  }
  private outputBody(node: ts.Statement): boolean {
    const ts = typescript();
    if (ts.isBlock(node))
      return node.statements.every((statement) => this.outputBody(statement));
    if (ts.isIfStatement(node)) return this.outputConditional(node);
    return (
      ts.isExpressionStatement(node) && this.outputExpression(node.expression)
    );
  }
  private outputConditional(node: ts.IfStatement): boolean {
    return (
      this.outputExpression(node.expression) &&
      this.outputBody(node.thenStatement) &&
      (!node.elseStatement || this.outputBody(node.elseStatement))
    );
  }
  private collection(node: ts.Expression): boolean {
    const ts = typescript();
    return ts.isIdentifier(node) && this.collections.has(node.text);
  }
}
function helperCall(node: ts.Expression): boolean {
  const ts = typescript();
  if (ts.isIdentifier(node) && ["text", "store", "String"].includes(node.text))
    return true;
  return (
    member(node, "Promise", ["all", "allSettled"]) ||
    member(node, "JSON", ["stringify"])
  );
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
function numericLoopVariable(node: ts.ForStatement): string | undefined {
  const ts = typescript();
  if (!node.initializer || !ts.isVariableDeclarationList(node.initializer))
    return undefined;
  const name = numericBinding(node.initializer);
  return name && numericLoopBounds(node, name) ? name : undefined;
}
function numericBinding(list: ts.VariableDeclarationList): string | undefined {
  if (
    !(list.flags & typescript().NodeFlags.Let) ||
    list.declarations.length !== 1
  )
    return undefined;
  const declaration = list.declarations[0];
  return declaration && zeroInitializer(declaration.initializer)
    ? localName(declaration.name)
    : undefined;
}
function zeroInitializer(node: ts.Expression | undefined): boolean {
  return (
    node !== undefined &&
    typescript().isNumericLiteral(node) &&
    node.text === "0"
  );
}
function numericLoopBounds(node: ts.ForStatement, name: string): boolean {
  const ts = typescript();
  const condition = node.condition;
  if (!condition || !ts.isBinaryExpression(condition)) return false;
  return (
    numericCondition(condition, name) &&
    numericIncrement(node.incrementor, name)
  );
}
function numericCondition(node: ts.BinaryExpression, name: string): boolean {
  return (
    node.operatorToken.kind === typescript().SyntaxKind.LessThanToken &&
    namedIdentifier(node.left, name) &&
    lengthProperty(node.right)
  );
}
function lengthProperty(node: ts.Expression): boolean {
  return (
    typescript().isPropertyAccessExpression(node) && node.name.text === "length"
  );
}
function numericIncrement(
  node: ts.Expression | undefined,
  name: string,
): boolean {
  return (
    node !== undefined &&
    typescript().isPostfixUnaryExpression(node) &&
    node.operator === typescript().SyntaxKind.PlusPlusToken &&
    namedIdentifier(node.operand, name)
  );
}
function inspectedSource(code: unknown): {
  submission?: Submission;
  reason: ExecCallReceipt["inspectionReason"];
} {
  if (typeof code !== "string") return { reason: "unsupported_source" };
  if (code.length > 65536) return { reason: "source_limit" };
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
  if (diagnostics.length !== 0) return { reason: "malformed_source" };
  const submission = new Submission();
  return source.statements.every((statement) => submission.statement(statement))
    ? { submission, reason: null }
    : { reason: "unsupported_source" };
}
function outputBlocks(output: unknown): unknown[] {
  if (isUnknownArray(output)) return output;
  if (typeof output !== "string") return [];
  try {
    const blocks: unknown = JSON.parse(output);
    return isUnknownArray(blocks) ? blocks : [];
  } catch {
    return [];
  }
}
function completeTextBlock(block: unknown): boolean {
  if (!isRecord(block) || !["text", "input_text"].includes(String(block.type)))
    return false;
  return typeof block.text === "string";
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
function submissionOutput(entry: Entry, entries: Entry[]): unknown[] {
  const id = entry.payload.call_id;
  if (typeof id !== "string") return [];
  const matches = entries.filter((other) => other.payload.call_id === id);
  if (matches.length !== 2) return [];
  const result = matches.find(
    (other) => other.payload.type === "custom_tool_call_output",
  );
  return result && result.ordinal > entry.ordinal
    ? outputBlocks(result.payload.output)
    : [];
}
function outputEvidence(
  blocks: unknown[],
): Pick<ExecCallReceipt, "execution" | "output"> {
  if (!blocks.length || !blocks.every(completeTextBlock))
    return { execution: "incomplete", output: "unavailable" };
  const header = blocks[0] as { text: string };
  const execution = executionStatus(header);
  const truncated = blocks.some((block) =>
    (block as { text: string }).text.includes("Warning: truncated output"),
  );
  return { execution, output: truncated ? "truncated" : "complete" };
}
function executionStatus(header: {
  text: string;
}): ExecCallReceipt["execution"] {
  if (completedHeader(header)) return "completed";
  return /^Script failed\b/.test(header.text) ? "failed" : "incomplete";
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
    .map((entry) => ({
      ordinal: entry.ordinal,
      ...inspectionEvidence(entry),
      ...outputEvidence(submissionOutput(entry, entries)),
    }));
}
function inspectionEvidence(
  entry: Entry,
): Pick<ExecCallReceipt, "completeness" | "calls" | "inspectionReason"> {
  if (!nativeExecNamespace(entry.payload.namespace))
    return {
      completeness: "partial",
      calls: [],
      inspectionReason: "foreign_namespace",
    };
  const inspected = inspectedSource(entry.payload.input);
  return {
    completeness: inspected.submission ? "complete" : "partial",
    calls: inspected.submission?.calls ?? [],
    inspectionReason: inspected.reason,
  };
}
