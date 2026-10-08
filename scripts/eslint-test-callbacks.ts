import type { Rule } from "eslint";
import type { ArrowFunctionExpression, FunctionExpression, Node } from "estree";

export const testCallbackLines: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      long: "Test callback has {{lines}} code lines; named integration exceptions are bounded at 200.",
    },
  },
  create(context) {
    const source = context.sourceCode;
    function inspect(
      node: (ArrowFunctionExpression | FunctionExpression) & { parent?: Node },
    ) {
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

function isTestCallback(node: { parent?: Node }) {
  const parent = node.parent;
  if (!parent || parent.type !== "CallExpression") return false;
  return isTestCallee(parent.callee);
}

function isTestCallee(node: Node): boolean {
  if (node.type === "Identifier") return ["test", "it"].includes(node.name);
  if (node.type === "CallExpression") return isTestCallee(node.callee);
  if (node.type === "MemberExpression") return isTestCallee(node.object);
  return false;
}
