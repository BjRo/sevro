import ts from "typescript";
import type { Range } from "istanbul-lib-coverage";

export type Primitive = string | number | boolean | null;
const nonNull = Symbol("non-null local binding");
type Fact = Primitive | typeof nonNull;
type FactDescription = Primitive | { kind: "non-null-binding" };
export type Facts = Map<string, Fact>;
export type FlowProof = {
  location: Range;
  unreachableRange?: Range;
  outcome: number;
  guard: string;
  facts: Record<string, FactDescription>;
};
type Result = { facts: Facts; terminated: boolean };
const unknown = Symbol("unknown compiler value");

export function analyzeCompilerFlow(text: string): FlowProof[] {
  const { source, functions } = compilerFunctions(text);
  const proofs: FlowProof[] = [];
  for (const node of functions)
    if (node.body) visit(node.body, new Map(), source, proofs);
  return proofs;
}

export function compilerFunctions(text: string) {
  const source = ts.createSourceFile(
    "validator.cjs",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const diagnostics: unknown = Reflect.get(source, "parseDiagnostics");
  if (!Array.isArray(diagnostics) || diagnostics.length)
    return { source, functions: [] };
  const functions = source.statements
    .filter(ts.isFunctionDeclaration)
    .filter(supportedFunction);
  return { source, functions };
}

function supportedFunction(node: ts.FunctionDeclaration): boolean {
  const bindings = new Map<string, boolean>();
  for (const parameter of node.parameters)
    registerParameter(parameter.name, bindings);
  const state = { supported: true };
  function inspect(child: ts.Node): void {
    if (nestedFunction(child, node)) {
      state.supported = false;
      return;
    }
    if (forbiddenSyntax(child)) state.supported = false;
    if (ts.isVariableDeclaration(child)) {
      if (!registerBinding(child, bindings)) state.supported = false;
    }
    ts.forEachChild(child, inspect);
  }
  inspect(node);
  return state.supported && privateBindings(node, bindings);
}

function privateBindings(
  node: ts.Node,
  bindings: Map<string, boolean>,
): boolean {
  const state = { safe: true };
  function inspect(child: ts.Node): void {
    if (!safePrivateReference(child, bindings)) state.safe = false;
    ts.forEachChild(child, inspect);
  }
  inspect(node);
  return state.safe;
}

function safePrivateReference(
  node: ts.Node,
  bindings: Map<string, boolean>,
): boolean {
  if (
    !ts.isIdentifier(node) ||
    !/^(?:errors|vErrors|_errs\d+|_?valid\d*)$/.test(node.text)
  )
    return true;
  if (propertyName(node)) return true;
  return bindings.has(node.text);
}

function propertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  return ts.isPropertyAssignment(parent) && parent.name === node;
}

function registerParameter(
  name: ts.BindingName,
  bindings: Map<string, boolean>,
): void {
  if (ts.isIdentifier(name)) {
    bindings.set(name.text, true);
    return;
  }
  for (const element of name.elements)
    if (ts.isBindingElement(element)) registerParameter(element.name, bindings);
}

function nestedFunction(node: ts.Node, root: ts.Node): boolean {
  return node !== root && ts.isFunctionLike(node);
}

function registerBinding(
  node: ts.VariableDeclaration,
  bindings: Map<string, boolean>,
): boolean {
  if (!ts.isIdentifier(node.name)) return false;
  const lexical = (node.parent.flags & ts.NodeFlags.BlockScoped) !== 0;
  const shadow =
    bindings.has(node.name.text) && (lexical || bindings.get(node.name.text));
  bindings.set(node.name.text, lexical);
  return !shadow;
}

function forbiddenSyntax(node: ts.Node): boolean {
  if (unsupportedLabel(node)) return true;
  if (unsupportedStatement(node)) return true;
  if (
    [
      ts.SyntaxKind.TryStatement,
      ts.SyntaxKind.SwitchStatement,
      ts.SyntaxKind.WithStatement,
    ].includes(node.kind)
  )
    return true;
  return dynamicEvaluation(node);
}

function unsupportedLabel(node: ts.Node): boolean {
  return (
    ts.isLabeledStatement(node) &&
    !ts.isIterationStatement(node.statement, false)
  );
}

function unsupportedStatement(node: ts.Node): boolean {
  return ts.isStatement(node) && !supportedStatements.has(node.kind);
}

function dynamicEvaluation(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression))
    return false;
  return ["eval", "Function"].includes(node.expression.text);
}

const supportedStatements = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.Block,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement,
  ts.SyntaxKind.EmptyStatement,
]);

function constant(
  node: ts.Expression | undefined,
  facts: Facts,
): Fact | typeof unknown {
  if (!node) return unknown;
  if (ts.isParenthesizedExpression(node))
    return constant(node.expression, facts);
  if (ts.isIdentifier(node)) return identifierValue(node.text, facts);
  const literal = literalValue(node);
  return literal === unknown ? literalOrOperation(node, facts) : literal;
}

function literalValue(node: ts.Expression): Fact | typeof unknown {
  if (ts.isArrayLiteralExpression(node)) return nonNull;
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text);
    return finiteCounter(value) ? value : unknown;
  }
  if (ts.isStringLiteral(node)) return node.text;
  return unknown;
}

function identifierValue(name: string, facts: Facts): Fact | typeof unknown {
  if (!facts.has(name)) return unknown;
  return facts.get(name) ?? null;
}

function literalOrOperation(
  node: ts.Expression,
  facts: Facts,
): Fact | typeof unknown {
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isBinaryExpression(node)) return binary(node, facts);
  return negation(node, facts);
}

function negation(node: ts.Expression, facts: Facts): Fact | typeof unknown {
  if (
    !ts.isPrefixUnaryExpression(node) ||
    node.operator !== ts.SyntaxKind.ExclamationToken
  )
    return unknown;
  const value = constant(node.operand, facts);
  return value === unknown || value === nonNull ? unknown : !value;
}

function binary(
  node: ts.BinaryExpression,
  facts: Facts,
): Fact | typeof unknown {
  const left = constant(node.left, facts),
    right = constant(node.right, facts);
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      return equality(left, right, false);
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      return equality(left, right, true);
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return conjunction(left, right);
    case ts.SyntaxKind.BarBarToken:
      return disjunction(left, right);
    default:
      return unknown;
  }
}

function equality(
  left: Fact | typeof unknown,
  right: Fact | typeof unknown,
  negate: boolean,
): Fact | typeof unknown {
  if (left === nonNull || right === nonNull)
    return nullEquality(left, right, negate);
  if (left === unknown || right === unknown) return unknown;
  return (left === right) !== negate;
}

function conjunction(
  left: Fact | typeof unknown,
  right: Fact | typeof unknown,
): Fact | typeof unknown {
  if (left === nonNull) return unknown;
  if (left !== unknown) return left ? right : left;
  return unknown;
}

function disjunction(
  left: Fact | typeof unknown,
  right: Fact | typeof unknown,
): Fact | typeof unknown {
  if (left === nonNull) return unknown;
  if (left !== unknown) return left ? left : right;
  return unknown;
}

export function writes(node: ts.Node, names = new Set<string>()): Set<string> {
  const target = writtenIdentifier(node);
  if (target) names.add(target);
  ts.forEachChild(node, (child) => {
    writes(child, names);
  });
  return names;
}

function writtenIdentifier(node: ts.Node): string | undefined {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
    return node.name.text;
  if (ts.isBinaryExpression(node)) return assignedIdentifier(node);
  return updatedIdentifier(node);
}

function assignedIdentifier(node: ts.BinaryExpression): string | undefined {
  if (!isAssignment(node.operatorToken.kind)) return;
  return ts.isIdentifier(node.left) ? node.left.text : undefined;
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function updatedIdentifier(node: ts.Node): string | undefined {
  if (!ts.isPrefixUnaryExpression(node) && !ts.isPostfixUnaryExpression(node))
    return;
  if (
    ![ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
      node.operator,
    )
  )
    return;
  return ts.isIdentifier(node.operand) ? node.operand.text : undefined;
}

function invalidate(node: ts.Node, facts: Facts): void {
  if (unknownAssignment(node)) {
    facts.clear();
    return;
  }
  for (const name of writes(node)) facts.delete(name);
}

export function unknownAssignment(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
    if (!supportedTarget(node.left)) return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (unknownAssignment(child)) found = true;
  });
  return found;
}

function supportedTarget(node: ts.Expression): boolean {
  return (
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  );
}

function assign(
  name: string,
  expression: ts.Expression | undefined,
  facts: Facts,
): void {
  const value = constant(expression, facts);
  if (expression) invalidate(expression, facts);
  if (value === unknown) facts.delete(name);
  else facts.set(name, value);
}

function statementExpression(node: ts.Expression, facts: Facts): void {
  if (advance(node, facts)) return;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(node.left)
  ) {
    assign(node.left.text, node.right, facts);
  } else invalidate(node, facts);
}

function visit(
  node: ts.Statement | undefined,
  incoming: Facts,
  source: ts.SourceFile,
  proofs: FlowProof[],
): Result {
  const facts = new Map(incoming);
  if (!node) return { facts, terminated: false };
  if (ts.isBlock(node)) return block(node, facts, source, proofs);
  if (ts.isIfStatement(node)) return conditional(node, facts, source, proofs);
  if (
    [ts.SyntaxKind.ReturnStatement, ts.SyntaxKind.ThrowStatement].includes(
      node.kind,
    )
  )
    return { facts, terminated: true };
  return ordinary(node, facts, source, proofs);
}

function block(
  node: ts.Block,
  incoming: Facts,
  source: ts.SourceFile,
  proofs: FlowProof[],
): Result {
  let result: Result = { facts: incoming, terminated: false };
  for (const statement of node.statements) {
    result = visit(statement, result.facts, source, proofs);
    if (result.terminated) return result;
  }
  return result;
}

function conditional(
  node: ts.IfStatement,
  facts: Facts,
  source: ts.SourceFile,
  proofs: FlowProof[],
): Result {
  const value = constant(node.expression, facts);
  invalidate(node.expression, facts);
  const truth = truthValue(value);
  if (typeof truth === "boolean") {
    recordProof(node, truth, facts, source, proofs);
    return visit(
      truth ? node.thenStatement : node.elseStatement,
      facts,
      source,
      proofs,
    );
  }
  return join(
    visit(
      node.thenStatement,
      refineNull(node.expression, facts, true),
      source,
      proofs,
    ),
    visit(
      node.elseStatement,
      refineNull(node.expression, facts, false),
      source,
      proofs,
    ),
  );
}

function join(yes: Result, no: Result): Result {
  if (yes.terminated && no.terminated)
    return { facts: intersection(yes.facts, no.facts), terminated: true };
  if (yes.terminated) return no;
  if (no.terminated) return yes;
  return { facts: intersection(yes.facts, no.facts), terminated: false };
}

function intersection(left: Facts, right: Facts): Facts {
  const facts: Facts = new Map();
  for (const [name, value] of left)
    if (right.has(name) && right.get(name) === value) facts.set(name, value);
  return facts;
}

function ordinary(
  node: ts.Statement,
  facts: Facts,
  source: ts.SourceFile,
  proofs: FlowProof[],
): Result {
  if (ts.isVariableStatement(node)) declarations(node, facts);
  else if (ts.isExpressionStatement(node))
    statementExpression(node.expression, facts);
  else return control(node, facts, source, proofs);
  return { facts, terminated: false };
}

function declarations(node: ts.VariableStatement, facts: Facts): void {
  for (const declaration of node.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name))
      assign(declaration.name.text, declaration.initializer, facts);
    else facts.clear();
  }
}

function control(
  node: ts.Statement,
  facts: Facts,
  source: ts.SourceFile,
  proofs: FlowProof[],
): Result {
  if (
    [ts.SyntaxKind.BreakStatement, ts.SyntaxKind.ContinueStatement].includes(
      node.kind,
    )
  )
    return { facts, terminated: true };
  if (ts.isLabeledStatement(node))
    return visit(node.statement, facts, source, proofs);
  if (isLoop(node)) {
    invalidate(node, facts);
    visit(node.statement, facts, source, proofs);
  } else if (!ts.isEmptyStatement(node)) facts.clear();
  return { facts, terminated: false };
}

function isLoop(node: ts.Statement): node is ts.IterationStatement {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function recordProof(
  node: ts.IfStatement,
  value: boolean,
  facts: Facts,
  source: ts.SourceFile,
  proofs: FlowProof[],
): void {
  if (!compilerGuard(node.expression)) return;
  const dead = value ? node.elseStatement : node.thenStatement;
  proofs.push({
    location: range(node, source),
    ...(dead ? { unreachableRange: range(dead, source) } : {}),
    outcome: value ? 1 : 0,
    guard: node.expression.getText(source),
    facts: describeFacts(facts),
  });
}

function compilerGuard(node: ts.Node): boolean {
  if (ts.isIdentifier(node))
    return /^(?:errors|vErrors|_errs\d+|_?valid\d*)$/.test(node.text);
  if (
    ts.isLiteralExpression(node) ||
    [
      ts.SyntaxKind.NullKeyword,
      ts.SyntaxKind.TrueKeyword,
      ts.SyntaxKind.FalseKeyword,
    ].includes(node.kind)
  )
    return true;
  if (ts.isParenthesizedExpression(node)) return compilerGuard(node.expression);
  return compoundGuard(node);
}

function compoundGuard(node: ts.Node): boolean {
  if (ts.isPrefixUnaryExpression(node))
    return (
      node.operator === ts.SyntaxKind.ExclamationToken &&
      compilerGuard(node.operand)
    );
  if (!ts.isBinaryExpression(node)) return false;
  return compilerGuard(node.left) && compilerGuard(node.right);
}

function nullEquality(
  left: Fact | typeof unknown,
  right: Fact | typeof unknown,
  negate: boolean,
): Fact | typeof unknown {
  return left === null || right === null ? negate : unknown;
}

function finiteCounter(
  value: Fact | typeof unknown | undefined,
): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function truthValue(value: Fact | typeof unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === null) return false;
  if (finiteCounter(value)) return value !== 0;
  return undefined;
}

function advance(node: ts.Expression, facts: Facts): boolean {
  const name = updatedIdentifier(node);
  if (!name) return false;
  const current = facts.get(name);
  const next = finiteCounter(current) ? current + updateDelta(node) : undefined;
  if (finiteCounter(next)) facts.set(name, next);
  else facts.delete(name);
  return true;
}

function updateDelta(node: ts.Expression): number {
  if (!ts.isPrefixUnaryExpression(node) && !ts.isPostfixUnaryExpression(node))
    return 0;
  return node.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1;
}

function refineNull(
  node: ts.Expression,
  incoming: Facts,
  truth: boolean,
): Facts {
  const facts = new Map(incoming);
  const compared = nullComparedName(node);
  if (compared)
    facts.set(compared.name, compared.equal === truth ? null : nonNull);
  return facts;
}

function nullComparedName(
  node: ts.Expression,
): { name: string; equal: boolean } | undefined {
  if (ts.isParenthesizedExpression(node))
    return nullComparedName(node.expression);
  if (!ts.isBinaryExpression(node)) return;
  if (
    !ts.isIdentifier(node.left) ||
    node.right.kind !== ts.SyntaxKind.NullKeyword
  )
    return;
  return nullComparison(node);
}

function nullComparison(
  node: ts.BinaryExpression,
): { name: string; equal: boolean } | undefined {
  if (!ts.isIdentifier(node.left)) return;
  if (
    ![
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(node.operatorToken.kind)
  )
    return;
  return {
    name: node.left.text,
    equal: node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken,
  };
}

function describeFacts(facts: Facts): Record<string, FactDescription> {
  return Object.fromEntries(
    [...facts].map(([name, value]): [string, FactDescription] => [
      name,
      value === nonNull ? { kind: "non-null-binding" } : value,
    ]),
  );
}

export function range(node: ts.Node, source: ts.SourceFile): Range {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.end);
  return {
    start: { line: start.line + 1, column: start.character },
    end: { line: end.line + 1, column: end.character },
  };
}
