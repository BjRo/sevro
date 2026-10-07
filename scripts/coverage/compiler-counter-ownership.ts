import ts from "typescript";

export function ownsIntegerCounter(
  node: ts.FunctionDeclaration,
  helpers: Set<string>,
): boolean {
  const aliases = counterAliases(node);
  const state = { initialized: false, safe: true };
  const privateArray = privateErrorsOwned(node, helpers);
  function inspect(child: ts.Node): void {
    if (counterDeclaration(child)) state.initialized = true;
    state.safe = counterNodeSafe(child, aliases, privateArray) && state.safe;
    ts.forEachChild(child, inspect);
  }
  inspect(node);
  return state.initialized && state.safe;
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

export function ownedErrorHelpers(
  functions: ts.FunctionDeclaration[],
): Set<string> {
  const names = new Set(
    functions.flatMap((node) => (node.name ? [node.name.text] : [])),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of functions)
      if (removeUnsafeHelper(node, names)) changed = true;
  }
  return names;
}

function removeUnsafeHelper(
  node: ts.FunctionDeclaration,
  names: Set<string>,
): boolean {
  if (!node.name || privateErrorsOwned(node, names)) return false;
  return names.delete(node.name.text);
}

function privateErrorsOwned(
  node: ts.FunctionDeclaration,
  helpers: Set<string>,
): boolean {
  const state = { initialized: false, safe: true };
  function inspect(child: ts.Node): void {
    if (errorDeclaration(child)) state.initialized = true;
    state.safe = arrayNodeSafe(child, helpers) && state.safe;
    ts.forEachChild(child, inspect);
  }
  inspect(node);
  return state.initialized && state.safe;
}

function errorDeclaration(node: ts.Node): node is ts.VariableDeclaration {
  return ts.isVariableDeclaration(node) && named(node.name, "vErrors");
}

function arrayNodeSafe(node: ts.Node, helpers: Set<string>): boolean {
  if (errorDeclaration(node))
    return node.initializer?.kind === ts.SyntaxKind.NullKeyword;
  if (!ts.isBinaryExpression(node)) return true;
  return !errorArrayWrite(node, helpers) || ownedArrayAssignment(node, helpers);
}

function named(node: ts.Node, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name;
}

function errorArrayWrite(
  node: ts.BinaryExpression,
  helpers: Set<string>,
): boolean {
  if (!assignment(node)) return false;
  if (named(node.left, "vErrors")) return true;
  return helperErrors(node.left, helpers);
}

function helperErrors(node: ts.Expression, helpers: Set<string>): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "errors")
    return false;
  return ts.isIdentifier(node.expression) && helpers.has(node.expression.text);
}

function ownedArrayAssignment(
  node: ts.BinaryExpression,
  helpers: Set<string>,
): boolean {
  return (
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ownedArrayValue(node.right, helpers)
  );
}

function ownedArrayValue(node: ts.Expression, helpers: Set<string>): boolean {
  if (literalOrPrivateArray(node, helpers)) return true;
  if (ts.isConditionalExpression(node))
    return (
      ownedArrayValue(node.whenTrue, helpers) &&
      ownedArrayValue(node.whenFalse, helpers)
    );
  return concatenatedArray(node, helpers);
}

function literalOrPrivateArray(
  node: ts.Expression,
  helpers: Set<string>,
): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    ts.isArrayLiteralExpression(node) ||
    named(node, "vErrors") ||
    helperErrors(node, helpers)
  );
}

function concatenatedArray(node: ts.Expression, helpers: Set<string>): boolean {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression)
  )
    return false;
  if (
    node.expression.name.text !== "concat" ||
    !named(node.expression.expression, "vErrors")
  )
    return false;
  return node.arguments.every((argument) => ownedArrayValue(argument, helpers));
}
