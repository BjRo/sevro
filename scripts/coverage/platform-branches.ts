import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  createCoverageMap,
  type CoverageMap,
  type CoverageMapData,
} from "istanbul-lib-coverage";
import ts from "typescript";

type Branch = {
  type: string;
  loc: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  locations: unknown[];
};
type Decision = { file: string; line: number; branch: string; outcome: number };
type FileData = CoverageMapData[string];

function platformName(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "platform" &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process"
  );
}

function platformComparison(
  node: ts.BinaryExpression,
  platform: NodeJS.Platform,
): boolean | undefined {
  const operator = node.operatorToken.kind;
  if (
    operator !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken
  )
    return undefined;
  const name = comparedPlatform(node.left, node.right);
  if (name === undefined) return undefined;
  return operator === ts.SyntaxKind.EqualsEqualsEqualsToken
    ? platform === name
    : platform !== name;
}

function comparedPlatform(left: ts.Expression, right: ts.Expression) {
  if (platformName(left) && ts.isStringLiteral(right)) return right.text;
  if (platformName(right) && ts.isStringLiteral(left)) return left.text;
  return undefined;
}

function negateKnown(value: boolean | undefined) {
  return value === undefined ? undefined : !value;
}

function knownAnd(left: boolean | undefined, right: boolean | undefined) {
  if (left === false || right === false) return false;
  if (left === true && right === true) return true;
  return undefined;
}

function knownOr(left: boolean | undefined, right: boolean | undefined) {
  if (left === true || right === true) return true;
  if (left === false && right === false) return false;
  return undefined;
}

function binaryBoolean(node: ts.BinaryExpression, platform: NodeJS.Platform) {
  const comparison = platformComparison(node, platform);
  if (comparison !== undefined) return comparison;
  const operator = node.operatorToken.kind;
  if (
    operator !== ts.SyntaxKind.AmpersandAmpersandToken &&
    operator !== ts.SyntaxKind.BarBarToken
  )
    return undefined;
  const left = knownBoolean(node.left, platform);
  const right = knownBoolean(node.right, platform);
  return operator === ts.SyntaxKind.AmpersandAmpersandToken
    ? knownAnd(left, right)
    : knownOr(left, right);
}

function knownBoolean(
  expression: ts.Expression,
  platform: NodeJS.Platform,
): boolean | undefined {
  if (ts.isParenthesizedExpression(expression))
    return knownBoolean(expression.expression, platform);
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  )
    return negateKnown(knownBoolean(expression.operand, platform));
  return ts.isBinaryExpression(expression)
    ? binaryBoolean(expression, platform)
    : undefined;
}

function logicalOperator(expression: ts.Expression) {
  if (!ts.isBinaryExpression(expression)) return undefined;
  const operator = expression.operatorToken.kind;
  if (
    operator === ts.SyntaxKind.AmpersandAmpersandToken ||
    operator === ts.SyntaxKind.BarBarToken
  )
    return operator;
  return undefined;
}

function canReachRight(operator: ts.SyntaxKind, value: boolean | undefined) {
  return operator === ts.SyntaxKind.AmpersandAmpersandToken
    ? value !== false
    : value !== true;
}

function logicalOutcomes(
  expression: ts.Expression,
  platform: NodeJS.Platform,
  reachable: boolean,
): boolean[] {
  if (ts.isParenthesizedExpression(expression))
    return logicalOutcomes(expression.expression, platform, reachable);
  const operator = logicalOperator(expression);
  if (operator === undefined || !ts.isBinaryExpression(expression))
    return [reachable];
  const left = logicalOutcomes(expression.left, platform, reachable);
  const rightReachable =
    reachable &&
    canReachRight(operator, knownBoolean(expression.left, platform));
  return [
    ...left,
    ...logicalOutcomes(expression.right, platform, rightReachable),
  ];
}

function branchType(node: ts.Node): string | undefined {
  if (ts.isIfStatement(node)) return "if";
  if (ts.isConditionalExpression(node)) return "cond-expr";
  if (ts.isBinaryExpression(node) && logicalOperator(node) !== undefined)
    return "binary-expr";
  return undefined;
}

function matchesBranch(source: ts.SourceFile, node: ts.Node, branch: Branch) {
  if (branchType(node) !== branch.type) return false;
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return (
    start.line + 1 === branch.loc.start.line &&
    start.character === branch.loc.start.column &&
    end.line + 1 === branch.loc.end.line &&
    end.character === branch.loc.end.column
  );
}

function branchNode(
  source: ts.SourceFile,
  branch: Branch,
): ts.Node | undefined {
  let matching: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (matchesBranch(source, node, branch)) matching = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return matching;
}

function branchCondition(node: ts.Node): ts.Expression | undefined {
  if (ts.isIfStatement(node)) return node.expression;
  if (ts.isConditionalExpression(node)) return node.condition;
  return undefined;
}

function conditionalOutcomes(
  node: ts.Node,
  platform: NodeJS.Platform,
): number[] {
  const condition = branchCondition(node);
  if (!condition) return [];
  const value = knownBoolean(condition, platform);
  return value === undefined ? [] : [value ? 1 : 0];
}

function excludedOutcomes(
  node: ts.Node,
  branch: Branch,
  platform: NodeJS.Platform,
): number[] {
  if (ts.isBinaryExpression(node)) {
    const outcomes = logicalOutcomes(node, platform, true);
    return outcomes.length === branch.locations.length
      ? outcomes.flatMap((reachable, index) => (reachable ? [] : [index]))
      : [];
  }
  return conditionalOutcomes(node, platform);
}

function requireUnreachable(
  file: FileData,
  path: string,
  branch: Branch,
  id: string,
  index: number,
) {
  if (file.b[id]?.[index] !== 0)
    throw new Error(
      `Platform-unreachable branch was executed: ${path}:${branch.loc.start.line}:${index}`,
    );
}

function filterOutcomes(
  file: FileData,
  branch: Branch,
  id: string,
  skipped: number[],
) {
  file.b[id] = file.b[id]?.filter((_, index) => !skipped.includes(index)) ?? [];
  branch.locations = branch.locations.filter(
    (_, index) => !skipped.includes(index),
  );
  if (!branch.locations.length) {
    Reflect.deleteProperty(file.b, id);
    Reflect.deleteProperty(file.branchMap, id);
  }
}

function projectBranch(
  file: FileData,
  source: ts.SourceFile,
  path: string,
  sourceRoot: string,
  id: string,
  branch: Branch,
  platform: NodeJS.Platform,
): Decision[] {
  const node = branchNode(source, branch);
  if (!node) return [];
  const skipped = excludedOutcomes(node, branch, platform);
  for (const index of skipped)
    requireUnreachable(file, path, branch, id, index);
  if (skipped.length) filterOutcomes(file, branch, id, skipped);
  return skipped.map((outcome) => ({
    file: relative(sourceRoot, path),
    line: branch.loc.start.line,
    branch: id,
    outcome,
  }));
}

function projectFile(
  file: FileData,
  path: string,
  sourceRoot: string,
  platform: NodeJS.Platform,
): Decision[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return Object.entries(file.branchMap).flatMap(([id, branch]) =>
    projectBranch(file, source, path, sourceRoot, id, branch, platform),
  );
}

/** Project only statically impossible OS outcomes after raw report validation. */
export function platformBranchCoverage(
  raw: CoverageMap,
  sourceRoot: string,
  platform: NodeJS.Platform = process.platform,
) {
  const projected = JSON.parse(JSON.stringify(raw.toJSON())) as CoverageMapData;
  const exclusions = Object.entries(projected).flatMap(([path, file]) =>
    projectFile(file, path, sourceRoot, platform),
  );
  return { map: createCoverageMap(projected), exclusions };
}
