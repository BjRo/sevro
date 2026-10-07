import ts from "typescript";
import {
  compilerFunctions,
  range,
  writes,
  unknownAssignment,
} from "./compiler-flow";
import type { FlowProof } from "./compiler-flow";
import {
  ownsIntegerCounter,
  ownedErrorHelpers,
} from "./compiler-counter-ownership";

export function analyzeCounterCopies(text: string): FlowProof[] {
  const { source, functions } = compilerFunctions(text);
  const proofs: FlowProof[] = [];
  function walk(node: ts.Node): void {
    if (ts.isBlock(node)) blockCopies(node, source, proofs);
    ts.forEachChild(node, walk);
  }
  const helpers = ownedErrorHelpers(functions);
  for (const node of functions)
    if (node.body && ownsIntegerCounter(node, helpers)) walk(node.body);
  return proofs;
}

function counterGuard(node: ts.Expression): string | undefined {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  )
    return;
  if (!ts.isIdentifier(node.left) || node.left.text !== "errors") return;
  return counterName(node.right);
}

function counterName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node))
    return /^(?:errors|_errs\d+)$/.test(node.text) ? node.text : undefined;
  return ts.isNumericLiteral(node) && node.text === "0" ? "errors" : undefined;
}

function blockCopies(
  node: ts.Block,
  source: ts.SourceFile,
  proofs: FlowProof[],
): void {
  for (let index = 1; index < node.statements.length; index++) {
    const statement = node.statements[index];
    if (!statement) continue;
    if (!ts.isIfStatement(statement)) continue;
    const proof = copyProof(statement, node.statements.slice(0, index), source);
    if (proof) proofs.push(proof);
  }
}

function copyProof(
  statement: ts.IfStatement,
  preceding: readonly ts.Statement[],
  source: ts.SourceFile,
): FlowProof | undefined {
  const name = counterGuard(statement.expression);
  if (!name || !precedingCopy(preceding, name)) return;
  return {
    location: range(statement, source),
    ...(statement.elseStatement
      ? { unreachableRange: range(statement.elseStatement, source) }
      : {}),
    outcome: 1,
    guard: statement.expression.getText(source),
    facts: {},
  };
}

function precedingCopy(
  statements: readonly ts.Statement[],
  name: string,
): boolean {
  for (const statement of [...statements].reverse()) {
    if (unknownAssignment(statement)) return false;
    const declaration = matchingDeclaration(statement, name);
    if (declaration) return copiedCounter(declaration, name);
    if (changesCapturedCounter(statement, name)) return false;
  }
  return false;
}

function changesCapturedCounter(node: ts.Statement, name: string): boolean {
  const changed = writes(node);
  return changed.has("errors") || changed.has(name);
}

function matchingDeclaration(
  node: ts.Statement,
  name: string,
): ts.VariableDeclaration | undefined {
  if (!ts.isVariableStatement(node)) return;
  if (node.declarationList.declarations.length !== 1) return;
  return node.declarationList.declarations.find(
    (declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === name,
  );
}

function copiedCounter(node: ts.VariableDeclaration, name: string): boolean {
  const initializer = node.initializer;
  if (!initializer) return false;
  if (name === "errors") return zeroInitializer(initializer);
  if (!(node.parent.flags & ts.NodeFlags.Const)) return false;
  return ts.isIdentifier(initializer) && initializer.text === "errors";
}

function zeroInitializer(node: ts.Expression): boolean {
  return ts.isNumericLiteral(node) && node.text === "0";
}
