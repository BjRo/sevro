import ts from "typescript";

export function ownsIntegerCounter(node: ts.FunctionDeclaration): boolean {
  if (!initializesCounter(node)) return false;
  const aliases = counterAliases(node);
  const state = { safe: true };
  const privateArray = privateErrorsOwned(node);
  function inspect(child: ts.Node): void {
    state.safe = counterNodeSafe(child, aliases, privateArray) && state.safe;
    ts.forEachChild(child, inspect);
  }
  inspect(node);
  return state.safe;
}

function initializesCounter(node: ts.FunctionDeclaration): boolean {
  if (!node.body) return false;
  for (const statement of node.body.statements) {
    const result = statementInitialization(statement);
    if (result !== undefined) return result;
  }
  return false;
}

function statementInitialization(statement: ts.Statement): boolean | undefined {
  if (ts.isVariableStatement(statement))
    return declarationInitialization(statement.declarationList.declarations);
  if (mentionsCounter(statement)) return false;
  return undefined;
}

function declarationInitialization(
  declarations: readonly ts.VariableDeclaration[],
): boolean | undefined {
  for (const declaration of declarations) {
    if (counterDeclaration(declaration)) return zero(declaration.initializer);
    if (mentionsCounter(declaration)) return false;
  }
  return undefined;
}

function mentionsCounter(node: ts.Node): boolean {
  const state = { found: false };
  function inspect(child: ts.Node): void {
    if (
      ts.isIdentifier(child) &&
      child.text === "errors" &&
      !propertyName(child)
    )
      state.found = true;
    ts.forEachChild(child, inspect);
  }
  inspect(node);
  return state.found;
}

function propertyName(node: ts.Identifier): boolean {
  if (ts.isPropertyAccessExpression(node.parent))
    return node.parent.name === node;
  return ts.isPropertyAssignment(node.parent) && node.parent.name === node;
}

function counterNodeSafe(
  node: ts.Node,
  aliases: Set<string>,
  privateArray: boolean,
): boolean {
  if (counterDeclaration(node)) return zero(node.initializer);
  if (!ts.isBinaryExpression(node)) return true;
  if (assignsCounter(node))
    return counterAssignment(node, aliases, privateArray);
  return !assignsAlias(node, aliases);
}

function counterDeclaration(node: ts.Node): node is ts.VariableDeclaration {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "errors"
  );
}

function zero(node: ts.Expression | undefined): boolean {
  return node !== undefined && ts.isNumericLiteral(node) && node.text === "0";
}

function counterAliases(node: ts.Node): Set<string> {
  const aliases = new Set<string>();
  function inspect(child: ts.Node): void {
    if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name)) {
      if (copiedAlias(child)) aliases.add(child.name.text);
    }
    ts.forEachChild(child, inspect);
  }
  inspect(node);
  return aliases;
}

function copiedAlias(node: ts.VariableDeclaration): boolean {
  const initializer = node.initializer;
  return Boolean(
    initializer &&
    ts.isIdentifier(initializer) &&
    initializer.text === "errors" &&
    node.parent.flags & ts.NodeFlags.Const,
  );
}

function assignment(node: ts.BinaryExpression): boolean {
  return (
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

function assignsCounter(node: ts.BinaryExpression): boolean {
  return (
    assignment(node) &&
    ts.isIdentifier(node.left) &&
    node.left.text === "errors"
  );
}

function assignsAlias(
  node: ts.BinaryExpression,
  aliases: Set<string>,
): boolean {
  return (
    assignment(node) &&
    ts.isIdentifier(node.left) &&
    aliases.has(node.left.text)
  );
}

function counterAssignment(
  node: ts.BinaryExpression,
  aliases: Set<string>,
  privateArray: boolean,
): boolean {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  if (zero(node.right)) return true;
  if (ts.isIdentifier(node.right)) return aliases.has(node.right.text);
  return privateArray && ownedArrayLength(node.right);
}

function ownedArrayLength(node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "length")
    return false;
  // The only length used by AJV's local counter is its private error array.
  // Input object properties and arbitrary numeric values are never inferred.
  return ts.isIdentifier(node.expression) && node.expression.text === "vErrors";
}

function privateErrorsOwned(node: ts.FunctionDeclaration): boolean {
  const state = { initialized: false, safe: true };
  function inspect(child: ts.Node): void {
    if (errorDeclaration(child)) state.initialized = true;
    state.safe = arrayNodeSafe(child) && state.safe;
    ts.forEachChild(child, inspect);
  }
  inspect(node);
  return state.initialized && state.safe;
}

function errorDeclaration(node: ts.Node): node is ts.VariableDeclaration {
  return ts.isVariableDeclaration(node) && named(node.name, "vErrors");
}

function arrayNodeSafe(node: ts.Node): boolean {
  if (errorDeclaration(node)) return ownedArrayValue(node.initializer);
  if (!ts.isBinaryExpression(node)) return true;
  if (!errorArrayWrite(node)) return true;
  return (
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ownedArrayValue(node.right)
  );
}

function errorArrayWrite(node: ts.BinaryExpression): boolean {
  return assignment(node) && named(node.left, "vErrors");
}

function named(node: ts.Node, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name;
}

function ownedArrayValue(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  if (literalOrPrivateArray(node)) return true;
  if (ts.isConditionalExpression(node))
    return ownedArrayValue(node.whenTrue) && ownedArrayValue(node.whenFalse);
  return false;
}

function literalOrPrivateArray(node: ts.Expression): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    ts.isArrayLiteralExpression(node) ||
    named(node, "vErrors")
  );
}
