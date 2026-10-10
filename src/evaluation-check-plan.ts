import { isAbsolute } from "node:path";
import { validInlineFixture } from "./case-validation";
import {
  EvaluationConfigurationError,
  type EvaluationOptions,
  type HostAdapter,
  type ResolvedCase,
} from "./evaluation-types";
import {
  prepareGeneratedFixture,
  type GeneratedFixture,
} from "./generated-fixture";
import {
  prepareGitHeadChecks,
  type GitHeadCheckDeclaration,
} from "./graders/git-head";
import {
  isOutputGrader,
  prepareOutputChecks,
  type OutputCheckDeclaration,
} from "./graders/output";
import {
  prepareSemanticChecks,
  type SemanticCheckDeclaration,
} from "./graders/semantic";
import {
  prepareShellChecks,
  type ShellCheckDeclaration,
} from "./graders/shell";
import { hashJson } from "./identity";
import { fixtureParts } from "./preparation";
import {
  prepareRepositoryFixture,
  type RepositoryFixture,
} from "./repository-fixture";
import { resolvedFixture } from "./resolved-case";
import { isOptionalNonblankString, isRecord } from "./value-guards";

function validateRootOptions(options: EvaluationOptions): void {
  if (
    !isAbsolute(options.projectRoot) ||
    !isAbsolute(options.resultsRoot) ||
    (options.runStateRoot !== undefined && !isAbsolute(options.runStateRoot))
  )
    throw new EvaluationConfigurationError(
      "project, results, and run-state roots must be absolute",
    );
}

function hostIdentityComplete(host: HostAdapter): boolean {
  return Boolean(host.id && host.model && host.effort);
}

function validateEvaluationIdentity(options: EvaluationOptions): void {
  if (
    !options.case.id ||
    !options.case.prompt ||
    !hostIdentityComplete(options.host)
  )
    throw new EvaluationConfigurationError(
      "case and host identities must be nonempty",
    );
}

function validateFollowUpPrompt(value: unknown): void {
  if (!isOptionalNonblankString(value))
    throw new EvaluationConfigurationError("follow-up prompt must be nonempty");
}

function validateContinuationHost(options: EvaluationOptions): void {
  if (
    options.case.followUpPrompt !== undefined &&
    !options.host.hostCapabilities?.includes("sevro.host.continuation")
  )
    throw new EvaluationConfigurationError(
      "selected host does not support continuation",
    );
}

function validateContinuationNegotiation(options: EvaluationOptions): void {
  if (
    options.case.followUpPrompt !== undefined &&
    options.extension &&
    !options.extension.session.identity.capabilities.includes(
      "sevro.host.continuation",
    )
  )
    throw new EvaluationConfigurationError(
      "continuation capability was not negotiated",
    );
}

function validateEvaluationInputs(options: EvaluationOptions): void {
  validateRootOptions(options);
  validateEvaluationIdentity(options);
  validateFollowUpPrompt(options.case.followUpPrompt);
  validateContinuationHost(options);
  validateContinuationNegotiation(options);
}

function evaluationFixtureObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    throw new EvaluationConfigurationError("invalid fixture declaration");
  return value;
}

function generatedEvaluationFixture(
  fixture: Record<string, unknown>,
): GeneratedFixture {
  try {
    return prepareGeneratedFixture(fixture);
  } catch (cause) {
    throw new EvaluationConfigurationError(
      cause instanceof Error ? cause.message : "invalid generated fixture",
      { cause },
    );
  }
}

function repositoryEvaluationFixture(
  fixture: Record<string, unknown>,
): RepositoryFixture {
  try {
    return prepareRepositoryFixture({ kind: "repository", ...fixture });
  } catch (cause) {
    throw new EvaluationConfigurationError(
      cause instanceof Error ? cause.message : "invalid repository fixture",
      { cause },
    );
  }
}

function validateInlineEvaluationFixture(
  fixture: Record<string, unknown>,
): void {
  if (!validInlineFixture(fixture))
    throw new EvaluationConfigurationError(
      "fixture must declare inline files or a repository source",
    );
}

function prepareEvaluationFixture(options: EvaluationOptions): {
  generated: GeneratedFixture | null;
  repositoryFixture: RepositoryFixture | null;
} {
  const fixture = evaluationFixtureObject(options.case.fixture);
  if ("kind" in fixture)
    return {
      generated: generatedEvaluationFixture(fixture),
      repositoryFixture: null,
    };
  if (Object.hasOwn(fixture, "sourceRef"))
    return {
      generated: null,
      repositoryFixture: repositoryEvaluationFixture(fixture),
    };
  validateInlineEvaluationFixture(fixture);
  return { generated: null, repositoryFixture: null };
}

function validateTrialInteger(value: number, message: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new EvaluationConfigurationError(message);
}

function validatePassThreshold(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1)
    throw new EvaluationConfigurationError(
      "pass threshold must be greater than zero and at most one",
    );
}

function validateRequiredEvidence(ids: string[]): void {
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(id))
  )
    throw new EvaluationConfigurationError("invalid required evidence IDs");
}

function prepareTrialParameters(
  options: EvaluationOptions,
  state: ReturnType<typeof prepareEvaluationFixture>,
) {
  validateTrialInteger(
    options.trialCount,
    "trial count must be a positive integer",
  );
  const jobs = options.jobs ?? 3;
  validateTrialInteger(jobs, "jobs must be a positive integer");
  validatePassThreshold(options.passThreshold);
  validateRequiredEvidence(options.case.requiredEvidence);
  return { ...state, jobs };
}

function declaredCaseChecks(options: EvaluationOptions) {
  const allBuiltinDeclarations = options.case.checks.filter((check) =>
    isOutputGrader(check.grader),
  ) as OutputCheckDeclaration[];
  const allShellDeclarations = options.case.checks.filter(
    (check) => check.grader === "sevro.shell",
  ) as ShellCheckDeclaration[];
  const allGitHeadDeclarations = options.case.checks.filter(
    (check) => check.grader === "sevro.git-head",
  ) as GitHeadCheckDeclaration[];
  const allSemanticDeclarations = options.case.checks.filter(
    (check) => check.grader === "sevro.semantic",
  ) as SemanticCheckDeclaration[];
  const extensionDeclarations = options.case.checks.filter(
    (check) =>
      !isOutputGrader(check.grader) &&
      check.grader !== "sevro.shell" &&
      check.grader !== "sevro.git-head" &&
      check.grader !== "sevro.semantic",
  );
  const replacedBuiltinGraders =
    options.extension?.session.identity.replacedBuiltinGraders ?? [];
  const replaced = new Set(replacedBuiltinGraders);
  return {
    allBuiltinDeclarations,
    allShellDeclarations,
    allGitHeadDeclarations,
    allSemanticDeclarations,
    extensionDeclarations,
    replacedBuiltinGraders,
    replaced,
  };
}

type CaseCheckDeclarations = ReturnType<typeof declaredCaseChecks>;

function validateBuiltInReplacements(context: CaseCheckDeclarations): void {
  const {
    allBuiltinDeclarations,
    allShellDeclarations,
    allGitHeadDeclarations,
    allSemanticDeclarations,
    extensionDeclarations,
    replacedBuiltinGraders,
    replaced,
  } = context;
  const declaredGraders = new Set<string>(
    [
      ...allBuiltinDeclarations,
      ...allShellDeclarations,
      ...allGitHeadDeclarations,
      ...allSemanticDeclarations,
    ].map((check) => check.grader),
  );
  if (
    replaced.size !== replacedBuiltinGraders.length ||
    replacedBuiltinGraders.some((id) => !declaredGraders.has(id))
  )
    throw new EvaluationConfigurationError(
      "unknown or duplicate built-in grader replacement",
    );
  if (replaced.size && !extensionDeclarations.length)
    throw new EvaluationConfigurationError(
      "built-in grader replacement requires an extension check",
    );
}

function activeCheckDeclarations(context: CaseCheckDeclarations) {
  const {
    allBuiltinDeclarations,
    allShellDeclarations,
    allGitHeadDeclarations,
    allSemanticDeclarations,
    replaced,
  } = context;
  const builtinDeclarations = allBuiltinDeclarations.filter(
    (check) => !replaced.has(check.grader),
  );
  const shellDeclarations = allShellDeclarations.filter(
    (check) => !replaced.has(check.grader),
  );
  const gitHeadDeclarations = allGitHeadDeclarations.filter(
    (check) => !replaced.has(check.grader),
  );
  const semanticDeclarations = allSemanticDeclarations.filter(
    (check) => !replaced.has(check.grader),
  );
  return {
    builtinDeclarations,
    shellDeclarations,
    gitHeadDeclarations,
    semanticDeclarations,
  };
}

type CaseCheckPlan = ReturnType<typeof prepareTrialParameters> &
  CaseCheckDeclarations &
  ReturnType<typeof activeCheckDeclarations>;

function validateSemanticRoute(
  options: EvaluationOptions,
  checks: SemanticCheckDeclaration[],
): void {
  if (checks.length && !options.semanticHost)
    throw new EvaluationConfigurationError(
      "semantic checks require an explicit semantic host",
    );
  if (options.semanticHost && !hostIdentityComplete(options.semanticHost))
    throw new EvaluationConfigurationError(
      "semantic host identity is incomplete",
    );
}

function validateAdvisoryGitFixture(
  options: EvaluationOptions,
  generated: GeneratedFixture | null,
): void {
  if (!generated && !options.case.fixture.sourceRef)
    throw new EvaluationConfigurationError(
      "advisory review requires a Git fixture",
    );
}

function validateAdvisoryExclusions(paths: string[]): void {
  try {
    for (const path of paths) {
      fixtureParts(path);
      if (
        path.toLowerCase() === ".git" ||
        path.toLowerCase().startsWith(".git/")
      )
        throw new Error("repository metadata cannot be an advisory exclusion");
    }
  } catch (cause) {
    throw new EvaluationConfigurationError("invalid advisory exclusion path", {
      cause,
    });
  }
}

function validateAdvisoryRoute(
  options: EvaluationOptions,
  generated: GeneratedFixture | null,
): void {
  const host = options.advisoryHost;
  if (!host) {
    if (options.advisoryExcludedPaths?.length)
      throw new EvaluationConfigurationError(
        "advisory exclusions require an advisory host",
      );
    return;
  }
  validateAdvisoryGitFixture(options, generated);
  validateAdvisoryIdentity(host);
  validateAdvisoryExclusions(options.advisoryExcludedPaths ?? []);
}

function validateAdvisoryIdentity(host: HostAdapter): void {
  if (!hostIdentityComplete(host))
    throw new EvaluationConfigurationError(
      "advisory host identity is incomplete",
    );
}

function validateShellRoute(
  options: EvaluationOptions,
  checks: ShellCheckDeclaration[],
): void {
  if (checks.length && !options.shellIsolation)
    throw new EvaluationConfigurationError(
      "shell checks require explicit protected source roots",
    );
}

function validateGitHeadRoute(context: CaseCheckPlan): void {
  if (
    context.gitHeadDeclarations.length &&
    !context.generated &&
    !context.repositoryFixture
  )
    throw new EvaluationConfigurationError(
      "Git HEAD checks require a Git fixture",
    );
}

function validateCaseCheckIds(checks: ResolvedCase["checks"]): void {
  if (new Set(checks.map((check) => check.id)).size !== checks.length)
    throw new EvaluationConfigurationError("case check IDs must be unique");
}

function validateExtensionGraders(
  options: EvaluationOptions,
  declarations: ResolvedCase["checks"],
): void {
  if (!declarations.length) return;
  const extension = options.extension;
  if (!extension)
    throw new EvaluationConfigurationError(
      "case declares an unavailable extension grader",
    );
  if (
    declarations.some(
      (check) => !extension.session.identity.graders.includes(check.grader),
    )
  )
    throw new EvaluationConfigurationError(
      "case declares an unavailable extension grader",
    );
}

function comparisonCase(caseData: ResolvedCase) {
  return {
    id: caseData.id,
    prompt: caseData.prompt,
    ...(caseData.followUpPrompt !== undefined
      ? { followUpPrompt: caseData.followUpPrompt }
      : {}),
    fixture: caseData.fixture,
    checks: caseData.checks,
    requiredEvidence: caseData.requiredEvidence,
  };
}

function validateResolvedExtensionCase(options: EvaluationOptions): void {
  if (!options.extension) return;
  const resolved = options.extension.resolvedCase;
  const comparable = comparisonCase({
    ...resolved,
    fixture: resolvedFixture(resolved.fixture),
  });
  if (hashJson(comparable) !== hashJson(comparisonCase(options.case)))
    throw new EvaluationConfigurationError(
      "resolved extension case does not match the selected case",
    );
}

function activePreparedChecks<T>(
  checks: T[],
  replaced: Set<string>,
  grader: string,
): T[] {
  return replaced.has(grader) ? [] : checks;
}

function validateInlinePaths(files: ResolvedCase["fixture"]["files"]): void {
  for (const path of Object.keys(files ?? {})) fixtureParts(path);
}

function prepareBuiltInChecks(
  options: EvaluationOptions,
  context: CaseCheckPlan,
) {
  const {
    allBuiltinDeclarations,
    allShellDeclarations,
    allGitHeadDeclarations,
    allSemanticDeclarations,
    replaced,
  } = context;
  try {
    const prepared = prepareOutputChecks(allBuiltinDeclarations).filter(
      (check) => !replaced.has(check.grader),
    );
    const preparedShell = activePreparedChecks(
      prepareShellChecks(allShellDeclarations),
      replaced,
      "sevro.shell",
    );
    const preparedGitHead = activePreparedChecks(
      prepareGitHeadChecks(allGitHeadDeclarations),
      replaced,
      "sevro.git-head",
    );
    const preparedSemantic = activePreparedChecks(
      prepareSemanticChecks(allSemanticDeclarations),
      replaced,
      "sevro.semantic",
    );
    validateInlinePaths(options.case.fixture.files);
    return { prepared, preparedShell, preparedGitHead, preparedSemantic };
  } catch (cause) {
    throw new EvaluationConfigurationError(
      cause instanceof Error ? cause.message : "invalid case configuration",
      { cause },
    );
  }
}

function prepareCheckPlan(
  options: EvaluationOptions,
  state: ReturnType<typeof prepareTrialParameters>,
) {
  const declarations = declaredCaseChecks(options);
  validateBuiltInReplacements(declarations);
  const context = {
    ...state,
    ...declarations,
    ...activeCheckDeclarations(declarations),
  };
  validateSemanticRoute(options, context.semanticDeclarations);
  validateAdvisoryRoute(options, context.generated);
  validateShellRoute(options, context.shellDeclarations);
  validateGitHeadRoute(context);
  validateCaseCheckIds(options.case.checks);
  validateExtensionGraders(options, context.extensionDeclarations);
  validateResolvedExtensionCase(options);
  return { ...context, ...prepareBuiltInChecks(options, context) };
}

export function prepareEvaluationChecks(options: EvaluationOptions) {
  validateEvaluationInputs(options);
  const fixture = prepareEvaluationFixture(options);
  const trials = prepareTrialParameters(options, fixture);
  return prepareCheckPlan(options, trials);
}
