/** @type {import('eslint').Rule.RuleModule} */
export const testCallbackLines = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      long: "Test callback has {{lines}} code lines; named integration exceptions are bounded at 200.",
    },
  },
  create(context) {
    const source = context.sourceCode;
    /** @param {(import('estree').ArrowFunctionExpression | import('estree').FunctionExpression) & {parent?: import('estree').Node}} node */
    function inspect(node) {
      if (!isTestCallback(node)) return;
      const text = source.getText(node);
      const lines = text
        .split("\n")
        .filter((line) => line.trim() && !line.trim().startsWith("//")).length;
      if (lines > 200)
        context.report({ node, messageId: "long", data: { lines } });
    }
    return { ArrowFunctionExpression: inspect, FunctionExpression: inspect };
  },
};

/** @param {{parent?: import('estree').Node}} node */
function isTestCallback(node) {
  const parent = node.parent;
  if (!parent || parent.type !== "CallExpression") return false;
  return isTestCallee(parent.callee);
}

/** @param {import('estree').Node} node */
function isTestCallee(node) {
  if (node.type === "Identifier") return ["test", "it"].includes(node.name);
  if (node.type === "CallExpression") return isTestCallee(node.callee);
  if (node.type === "MemberExpression") return isTestCallee(node.object);
  return false;
}
