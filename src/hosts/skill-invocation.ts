import { EvaluationConfigurationError } from "../host-contract/index";
import {
  claudeInvocationDeclarations,
  prepareClaudePackage,
} from "./claude-invocation";
import {
  codexInvocationDeclarations,
  prepareCodexPackage,
} from "./codex-invocation";
import {
  invocationPlaceholderCount,
  INVOCATION_PLACEHOLDER,
  LEGACY_CODEX_PLACEHOLDER,
  type InvocationPreparation,
  type PreparedInvocation,
} from "./invocation-rules";
export {
  INVOCATION_PLACEHOLDER,
  LEGACY_CODEX_PLACEHOLDER,
  type InvocationPreparation,
  type PreparedInvocation,
} from "./invocation-rules";
/** Resolve wire declarations through the owning host, preserving their evidence shape. */
export function prepareHostInvocation(
  input: InvocationPreparation,
): PreparedInvocation {
  const claudePackage = prepareClaudePackage(input);
  const codexPackage = prepareCodexPackage(input);
  const selected = resolveInvocation(input);
  return {
    packageConfiguration: {
      ...codexPackage.configuration,
      ...claudePackage.configuration,
    },
    ...selected,
    hostRequest: {
      ...codexPackage.hostRequest,
      ...claudePackage.hostRequest,
      ...selected.hostRequest,
    },
  };
}

function resolveInvocation(
  input: InvocationPreparation,
): Omit<PreparedInvocation, "packageConfiguration"> {
  const declarations = [
    ...codexInvocationDeclarations(input),
    ...claudeInvocationDeclarations(input),
  ];
  if (declarations.length > 1)
    throw new EvaluationConfigurationError(
      "only one explicit skill invocation may be declared",
    );
  const selected = declarations[0];
  if (selected) {
    const explicitSkillInvocation = selected.resolve();
    return {
      configuration: selected.configuration,
      hostRequest: { explicitSkillInvocation },
      invocationToken: explicitSkillInvocation.token,
    };
  }
  if (invocationPlaceholderCount(input))
    throw new EvaluationConfigurationError(
      "skill invocation placeholder requires a declaration",
    );
  return { configuration: {}, hostRequest: {}, invocationToken: null };
}

export function renderSkillInvocation(
  prompt: string,
  token: string | null,
): string {
  return prompt
    .replaceAll(INVOCATION_PLACEHOLDER, token ?? INVOCATION_PLACEHOLDER)
    .replaceAll(LEGACY_CODEX_PLACEHOLDER, token ?? LEGACY_CODEX_PLACEHOLDER);
}
