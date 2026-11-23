import type ts from "typescript";

/** Recognizes catalog syntax only; never evaluates metadata, callbacks or regexes. */
export class CatalogQueries {
  private readonly bindings = new Set<string>();
  private readonly filtered = new WeakSet<ts.Expression>();

  constructor(
    private readonly syntax: typeof ts,
    private readonly visit: () => boolean,
    private readonly localName: (node: ts.BindingName) => string | undefined,
  ) {}

  query(node: ts.CallExpression): boolean {
    const receiver = this.queryReceiver(node.expression);
    if (!receiver) return false;
    const callback = this.callback(node);
    if (!callback) return false;
    const valid =
      receiver.name.text === "filter"
        ? this.predicate(callback.body, callback.parameter)
        : this.projection(callback.body, callback.parameter);
    return this.retainQuery(node, receiver.name.text, valid);
  }

  private retainQuery(node: ts.CallExpression, method: string, valid: boolean) {
    if (valid && method === "filter") this.filtered.add(node);
    return valid;
  }

  private queryReceiver(node: ts.Expression) {
    if (!this.syntax.isPropertyAccessExpression(node)) return undefined;
    if (!["filter", "map"].includes(node.name.text)) return undefined;
    return this.entries(node.expression) ? node : undefined;
  }

  retain(name: string, initializer: ts.Expression): void {
    if (this.reference(initializer) || this.filtered.has(initializer))
      this.bindings.add(name);
  }

  private reference(node: ts.Expression): boolean {
    return (
      this.syntax.isIdentifier(node) &&
      (node.text === "ALL_TOOLS" || this.bindings.has(node.text))
    );
  }

  private entries(node: ts.Expression): boolean {
    if (!this.visit()) return false;
    if (this.reference(node)) return true;
    return (
      this.syntax.isCallExpression(node) &&
      this.query(node) &&
      this.filtered.has(node)
    );
  }

  private callback(node: ts.CallExpression) {
    const arrow = this.arrow(node.arguments);
    if (!arrow || this.syntax.isBlock(arrow.body)) return undefined;
    const name = this.parameter(arrow.parameters);
    return name ? { body: arrow.body, parameter: name } : undefined;
  }

  private arrow(args: ts.NodeArray<ts.Expression>) {
    if (args.length !== 1) return undefined;
    const arrow = args[0] as ts.Expression;
    if (!this.syntax.isArrowFunction(arrow)) return undefined;
    return arrow.modifiers?.length ? undefined : arrow;
  }

  private parameter(parameters: ts.NodeArray<ts.ParameterDeclaration>) {
    if (parameters.length !== 1) return undefined;
    const parameter = parameters[0] as ts.ParameterDeclaration;
    if (parameter.initializer || parameter.dotDotDotToken) return undefined;
    return this.localName(parameter.name);
  }

  private predicate(node: ts.Expression, parameter: string): boolean {
    if (!this.visit() || !this.syntax.isCallExpression(node)) return false;
    return (
      this.regexTest(node.expression) &&
      this.singleStringArgument(node, parameter)
    );
  }

  private regexTest(node: ts.Expression): boolean {
    if (!this.syntax.isPropertyAccessExpression(node)) return false;
    const { expression: receiver, name } = node;
    return (
      receiver.kind === this.syntax.SyntaxKind.RegularExpressionLiteral &&
      name.text === "test"
    );
  }

  private singleStringArgument(
    node: ts.CallExpression,
    parameter: string,
  ): boolean {
    const [argument] = node.arguments;
    return (
      node.arguments.length === 1 &&
      argument !== undefined &&
      this.string(argument, parameter)
    );
  }

  private projection(node: ts.Expression, parameter: string): boolean {
    if (this.syntax.isParenthesizedExpression(node))
      return this.visit() && this.projection(node.expression, parameter);
    if (!this.syntax.isObjectLiteralExpression(node))
      return this.string(node, parameter);
    return (
      this.visit() &&
      node.properties.every((property) => this.field(property, parameter))
    );
  }

  private field(node: ts.ObjectLiteralElementLike, parameter: string): boolean {
    return (
      this.syntax.isPropertyAssignment(node) &&
      !this.syntax.isComputedPropertyName(node.name) &&
      this.string(node.initializer, parameter)
    );
  }

  private string(node: ts.Expression, parameter: string): boolean {
    if (!this.visit()) return false;
    switch (true) {
      case this.syntax.isStringLiteralLike(node):
        return true;
      case this.syntax.isPropertyAccessExpression(node):
        return this.metadata(node, parameter);
      case this.syntax.isBinaryExpression(node):
        return (
          node.operatorToken.kind === this.syntax.SyntaxKind.PlusToken &&
          this.string(node.left, parameter) &&
          this.string(node.right, parameter)
        );
      case this.syntax.isCallExpression(node):
        return this.slice(node, parameter);
      default:
        return false;
    }
  }

  private metadata(node: ts.PropertyAccessExpression, parameter: string) {
    return (
      this.syntax.isIdentifier(node.expression) &&
      node.expression.text === parameter &&
      ["name", "description"].includes(node.name.text)
    );
  }

  private slice(node: ts.CallExpression, parameter: string): boolean {
    if (!this.syntax.isPropertyAccessExpression(node.expression)) return false;
    const { expression: receiver, name } = node.expression;
    return (
      name.text === "slice" &&
      this.string(receiver, parameter) &&
      this.bounds(node.arguments)
    );
  }

  private bounds(args: ts.NodeArray<ts.Expression>): boolean {
    return (
      args.length >= 1 &&
      args.length <= 2 &&
      args.every((argument) => this.bound(argument))
    );
  }

  private bound(node: ts.Expression): boolean {
    if (!this.visit() || !this.syntax.isNumericLiteral(node)) return false;
    return Number.isSafeInteger(Number(node.text));
  }
}
