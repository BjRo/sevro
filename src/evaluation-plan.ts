import { isRecord, isStringArray } from "./value-guards";
import { resolvedFixture } from "./resolved-case";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  isOutputGrader,
  prepareOutputChecks,
  type OutputCheckDeclaration,
} from "./graders/output";
import {
  prepareGitHeadChecks,
  type GitHeadCheckDeclaration,
} from "./graders/git-head";
import {
  prepareShellChecks,
  type ShellCheckDeclaration,
} from "./graders/shell";
import {
  prepareSemanticChecks,
  type SemanticCheckDeclaration,
} from "./graders/semantic";
import { canonicalJson, createEvaluationIdentity, hashJson } from "./identity";
import {
  prepareInstrumentation,
  type InstrumentationRequest,
} from "./instrumentation";
import {
  prepareGeneratedFixture,
  type GeneratedFixture,
} from "./generated-fixture";
import { prepareFixtureSetup, type FixtureSetup } from "./fixture-setup";
import {
  fixtureParts,
  prepareArtifacts,
  type InlineArtifact,
} from "./preparation";
import {
  prepareRepositoryFixture,
  resolveRepositorySource,
  type RepositoryFixture,
  type RepositorySource,
} from "./repository-fixture";
import { projectProvenance, runnerProvenance } from "./provenance";
import {
  EvaluationConfigurationError,
  type HostAdapter,
  type ResolvedCase,
  type EvaluationOptions,
} from "./evaluation-types";

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
  if (value !== undefined && (typeof value !== "string" || !value.trim()))
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
  if (
    !Object.hasOwn(fixture, "files") ||
    !isRecord(fixture.files) ||
    Object.values(fixture.files).some((content) => typeof content !== "string")
  )
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

async function prepareEvaluationEnvironment(
  options: EvaluationOptions,
  state: Awaited<ReturnType<typeof prepareCheckPlan>>,
) {
  const projectRoot = await realpath(options.projectRoot).catch(() => {
    throw new EvaluationConfigurationError("project root is unreadable");
  });
  const repository = options.case.fixture.sourceRef
    ? await resolveRepositorySource(
        options.case.fixture.sourceRef,
        options.preparationSources,
      ).catch((error: unknown) => {
        throw new EvaluationConfigurationError(
          error instanceof Error ? error.message : "invalid repository source",
        );
      })
    : null;
  const [runner, project] = await Promise.all([
    runnerProvenance(
      options.runnerBuildDigest,
      options.runnerCheckoutRoot,
    ).catch((error: unknown) => {
      throw new EvaluationConfigurationError(
        error instanceof Error ? error.message : "invalid runner provenance",
      );
    }),
    projectProvenance(projectRoot),
  ]);
  const extensionPreparation = options.extension
    ? await options.extension.session.prepare(
        options.extension.resolvedCase,
        {
          id: options.host.id,
          capabilities: [
            ...(options.host.instrumentation ?? []).map((item) => item.id),
            ...(options.host.hostCapabilities ?? []),
          ],
        },
        options.condition,
      )
    : null;
  return {
    ...state,
    projectRoot,
    repository,
    runner,
    project,
    extensionPreparation,
  };
}

type EnvironmentPlan = Awaited<ReturnType<typeof prepareEvaluationEnvironment>>;

function preparedFixtureSetup(
  preparation: EnvironmentPlan["extensionPreparation"],
): FixtureSetup | null {
  try {
    return prepareFixtureSetup(preparation?.fixtureSetup);
  } catch (cause) {
    throw new EvaluationConfigurationError(
      cause instanceof Error ? cause.message : "invalid fixture setup",
      { cause },
    );
  }
}

function validateSetupCapability(
  options: EvaluationOptions,
  setup: FixtureSetup | null,
): void {
  if (
    setup &&
    !options.extension?.session.identity.capabilities.includes(
      "sevro.fixture.setup",
    )
  )
    throw new EvaluationConfigurationError(
      "fixture setup capability was not negotiated",
    );
}

function validateSetupFixture(
  setup: FixtureSetup | null,
  generated: GeneratedFixture | null,
  repository: RepositorySource | null,
): void {
  if (setup && !generated && !repository)
    throw new EvaluationConfigurationError(
      "fixture setup requires a Git fixture",
    );
}

function negotiatedInstrumentationCapabilities(
  options: EvaluationOptions,
): string[] {
  return options.extension?.session.identity.capabilities ?? [];
}

function configurationFailureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function requestedInstrumentationPlan(
  options: EvaluationOptions,
  preparation: EnvironmentPlan["extensionPreparation"],
): InstrumentationRequest[] {
  try {
    return prepareInstrumentation(
      preparation?.requestedInstrumentation ?? [],
      options.host.instrumentation ?? [],
      negotiatedInstrumentationCapabilities(options),
      options.condition,
    );
  } catch (cause) {
    throw new EvaluationConfigurationError(
      configurationFailureMessage(cause, "invalid instrumentation"),
      { cause },
    );
  }
}

function fixturePreparationPaths(
  fixture: ResolvedCase["fixture"],
  generated: GeneratedFixture | null,
): string[] {
  if (!generated) return Object.keys(fixture.files ?? {});
  return [
    ...new Set([
      ...generated.commits.flatMap((commit) => Object.keys(commit.files)),
      ...Object.keys(generated.files ?? {}),
    ]),
  ];
}

async function preparedEvaluationArtifacts(
  options: EvaluationOptions,
  context: EnvironmentPlan,
): Promise<InlineArtifact[]> {
  try {
    return await prepareArtifacts(
      context.extensionPreparation?.artifacts ?? [],
      fixturePreparationPaths(options.case.fixture, context.generated),
      options.preparationSources,
    );
  } catch (cause) {
    throw new EvaluationConfigurationError(
      cause instanceof Error ? cause.message : "invalid preparation artifacts",
      { cause },
    );
  }
}

function validateArtifactMetadata(
  artifacts: InlineArtifact[],
  generated: GeneratedFixture | null,
  repository: RepositorySource | null,
): void {
  if (
    (repository || generated) &&
    artifacts.some((artifact) =>
      fixtureParts(artifact.relativePath).some(
        (part) => part.toLowerCase() === ".git",
      ),
    )
  )
    throw new EvaluationConfigurationError(
      "preparation artifacts cannot modify repository metadata",
    );
}

function validateArtifactExclusions(
  artifacts: InlineArtifact[],
  generated: GeneratedFixture | null,
  repository: RepositorySource | null,
): void {
  if (
    !repository &&
    !generated &&
    artifacts.some((artifact) => artifact.gitExclude)
  )
    throw new EvaluationConfigurationError(
      "Git-excluded preparation artifacts require a Git fixture",
    );
}

function validateSemanticArtifactId(
  artifacts: InlineArtifact[],
  declarations: SemanticCheckDeclaration[],
): void {
  if (
    declarations.length &&
    artifacts.some((item) => item.id === "sevro.semantic.verdicts")
  )
    throw new EvaluationConfigurationError(
      "preparation artifact uses a reserved semantic evidence ID",
    );
}

async function prepareEvaluationArtifacts(
  options: EvaluationOptions,
  state: EnvironmentPlan,
) {
  const fixtureSetup = preparedFixtureSetup(state.extensionPreparation);
  validateSetupCapability(options, fixtureSetup);
  validateSetupFixture(fixtureSetup, state.generated, state.repository);
  const requestedInstrumentation = requestedInstrumentationPlan(
    options,
    state.extensionPreparation,
  );
  const inlineArtifacts = await preparedEvaluationArtifacts(options, state);
  validateArtifactMetadata(inlineArtifacts, state.generated, state.repository);
  validateArtifactExclusions(
    inlineArtifacts,
    state.generated,
    state.repository,
  );
  validateSemanticArtifactId(inlineArtifacts, state.semanticDeclarations);
  return { ...state, fixtureSetup, requestedInstrumentation, inlineArtifacts };
}

type ArtifactPlan = Awaited<ReturnType<typeof prepareEvaluationArtifacts>>;
type ClaudePluginDirectories = NonNullable<
  NonNullable<ArtifactPlan["extensionPreparation"]>["claudePluginDirs"]
>;
type CodexMarketplace = NonNullable<
  NonNullable<ArtifactPlan["extensionPreparation"]>["codexMarketplace"]
>;

function uniquePluginRoots(value: unknown): value is string[] {
  return (
    isStringArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length
  );
}

function validateClaudePluginRoots(roots: string[]): void {
  try {
    if (!uniquePluginRoots(roots)) throw new Error("invalid plugin roots");
    for (const root of roots) fixtureParts(root);
    if (
      roots.some((root) =>
        roots.some((other) => root !== other && root.startsWith(`${other}/`)),
      )
    )
      throw new Error("overlapping plugin roots");
  } catch (cause) {
    throw new EvaluationConfigurationError(
      "invalid Claude plugin directory declaration",
      { cause },
    );
  }
}

function requireNegotiatedCapability(
  options: EvaluationOptions,
  capability: string,
  message: string,
): void {
  if (
    !options.extension?.session.identity.capabilities.includes(capability) ||
    !options.host.hostCapabilities?.includes(capability)
  )
    throw new EvaluationConfigurationError(message);
}

function validatePackageManifest(
  files: InlineArtifact[],
  manifest: string,
  message: string,
): void {
  if (
    !files.length ||
    !files.every((artifact) => artifact.gitExclude) ||
    !files.some((artifact) => artifact.relativePath === manifest)
  )
    throw new EvaluationConfigurationError(message);
}

function validateClaudePluginPackage(
  options: EvaluationOptions,
  directories: ClaudePluginDirectories | undefined,
  artifacts: InlineArtifact[],
): void {
  if (!directories) return;
  const roots = directories.artifactRoots;
  validateClaudePluginRoots(roots);
  requireNegotiatedCapability(
    options,
    "sevro.claude.plugin-dirs",
    "Claude plugin directory capability was not negotiated",
  );
  for (const root of roots) {
    const files = artifacts.filter((artifact) =>
      artifact.relativePath.startsWith(`${root}/`),
    );
    validatePackageManifest(
      files,
      `${root}/.claude-plugin/plugin.json`,
      "Claude plugin directory requires Git-excluded package artifacts and a manifest",
    );
  }
}

function marketplaceNamesValid(name: string, plugins: string[]): boolean {
  return (
    /^[a-z][a-z0-9-]*$/.test(name) &&
    plugins.length > 0 &&
    !plugins.some((plugin) => !/^[a-z][a-z0-9-]*$/.test(plugin)) &&
    new Set(plugins).size === plugins.length
  );
}

function validateMarketplaceDeclaration(marketplace: CodexMarketplace): void {
  try {
    fixtureParts(marketplace.artifactRoot);
    if (
      !marketplaceNamesValid(
        marketplace.marketplaceName,
        marketplace.pluginNames,
      )
    )
      throw new Error("invalid marketplace or plugin name");
  } catch (cause) {
    throw new EvaluationConfigurationError(
      "invalid Codex marketplace declaration",
      { cause },
    );
  }
}

function validateCodexMarketplacePackage(
  options: EvaluationOptions,
  marketplace: CodexMarketplace | undefined,
  artifacts: InlineArtifact[],
): void {
  if (!marketplace) return;
  validateMarketplaceDeclaration(marketplace);
  requireNegotiatedCapability(
    options,
    "sevro.codex.plugin-marketplace",
    "Codex marketplace capability was not negotiated",
  );
  const files = artifacts.filter((artifact) =>
    artifact.relativePath.startsWith(`${marketplace.artifactRoot}/`),
  );
  validatePackageManifest(
    files,
    `${marketplace.artifactRoot}/.claude-plugin/marketplace.json`,
    "Codex marketplace requires Git-excluded package artifacts and a manifest",
  );
}

function preparePackageArtifacts(
  options: EvaluationOptions,
  state: ArtifactPlan,
) {
  const codexMarketplace = state.extensionPreparation?.codexMarketplace;
  const claudePluginDirs = state.extensionPreparation?.claudePluginDirs;
  validateClaudePluginPackage(options, claudePluginDirs, state.inlineArtifacts);
  validateCodexMarketplacePackage(
    options,
    codexMarketplace,
    state.inlineArtifacts,
  );
  return { ...state, codexMarketplace, claudePluginDirs };
}

type PackagePlan = ReturnType<typeof preparePackageArtifacts>;
const INVOCATION_PLACEHOLDER = "{{sevro.skill_invocation}}";
const LEGACY_CODEX_PLACEHOLDER = "{{sevro.codex.skill_invocation}}";

function skillInvocationDeclarations(
  preparation: PackagePlan["extensionPreparation"],
) {
  return {
    codexSkillInvocation: preparation?.codexSkillInvocation,
    codexRepositorySkillInvocation: preparation?.codexRepositorySkillInvocation,
    claudeSkillInvocation: preparation?.claudeSkillInvocation,
    claudeRepositorySkillInvocation:
      preparation?.claudeRepositorySkillInvocation,
  };
}

type SkillDeclarations = ReturnType<typeof skillInvocationDeclarations>;
type PluginSkillInvocation = NonNullable<
  SkillDeclarations["codexSkillInvocation"]
>;
type RepositorySkillInvocation = NonNullable<
  SkillDeclarations["codexRepositorySkillInvocation"]
>;
type SelectedSkillInvocation =
  | { kind: "codex-plugin"; value: PluginSkillInvocation }
  | { kind: "codex-repository"; value: RepositorySkillInvocation }
  | { kind: "claude-plugin"; value: PluginSkillInvocation }
  | { kind: "claude-repository"; value: RepositorySkillInvocation }
  | { kind: "none" };

function selectedSkillInvocation(
  declarations: SkillDeclarations,
): SelectedSkillInvocation {
  if (declarations.codexSkillInvocation)
    return { kind: "codex-plugin", value: declarations.codexSkillInvocation };
  if (declarations.codexRepositorySkillInvocation)
    return {
      kind: "codex-repository",
      value: declarations.codexRepositorySkillInvocation,
    };
  if (declarations.claudeRepositorySkillInvocation)
    return {
      kind: "claude-repository",
      value: declarations.claudeRepositorySkillInvocation,
    };
  if (declarations.claudeSkillInvocation)
    return { kind: "claude-plugin", value: declarations.claudeSkillInvocation };
  return { kind: "none" };
}

function invocationTokenFor(declarations: SkillDeclarations): string | null {
  if (declarations.codexRepositorySkillInvocation)
    return `$${declarations.codexRepositorySkillInvocation.skillName}`;
  if (declarations.claudeRepositorySkillInvocation)
    return `/${declarations.claudeRepositorySkillInvocation.skillName}`;
  if (declarations.codexSkillInvocation)
    return `$${declarations.codexSkillInvocation.pluginName}:${declarations.codexSkillInvocation.skillName}`;
  if (declarations.claudeSkillInvocation)
    return `/${declarations.claudeSkillInvocation.pluginName}:${declarations.claudeSkillInvocation.skillName}`;
  return null;
}

function invocationMetadata(declarations: SkillDeclarations) {
  const repositoryInvocation =
    declarations.codexRepositorySkillInvocation ??
    declarations.claudeRepositorySkillInvocation;
  const invocation = repositoryInvocation
    ? { ...repositoryInvocation, scope: "repository" as const }
    : (declarations.codexSkillInvocation ?? declarations.claudeSkillInvocation);
  return { repositoryInvocation, invocation };
}

function promptPlaceholderCount(
  caseData: ResolvedCase,
  placeholder: string,
): number {
  return (
    caseData.prompt.split(placeholder).length -
    1 +
    (caseData.followUpPrompt?.split(placeholder).length ?? 1) -
    1
  );
}

function validateOnlyOneInvocation(declarations: SkillDeclarations): void {
  if (
    [
      declarations.codexSkillInvocation,
      declarations.codexRepositorySkillInvocation,
      declarations.claudeSkillInvocation,
      declarations.claudeRepositorySkillInvocation,
    ].filter(Boolean).length > 1
  )
    throw new EvaluationConfigurationError(
      "only one explicit skill invocation may be declared",
    );
}

function validateCodexInvocationMembership(
  marketplace: CodexMarketplace | undefined,
  pluginName: string,
): asserts marketplace is CodexMarketplace {
  if (
    !marketplace ||
    !marketplace.pluginNames.includes(pluginName) ||
    !/^[a-z][a-z0-9-]*$/.test(pluginName)
  )
    throw new EvaluationConfigurationError(
      "invalid Codex skill invocation declaration",
    );
}

function validateCodexInvocationBody(
  marketplace: CodexMarketplace,
  skillName: string,
  artifacts: InlineArtifact[],
  placeholders: number,
): void {
  if (
    !/^[A-Za-z0-9._-]+$/.test(skillName) ||
    placeholders !== 1 ||
    !artifacts.some(
      (artifact) =>
        artifact.relativePath ===
        `${marketplace.artifactRoot}/plugin/skills/${skillName}/SKILL.md`,
    )
  )
    throw new EvaluationConfigurationError(
      "invalid Codex skill invocation declaration",
    );
}

function validateCodexPluginInvocation(
  options: EvaluationOptions,
  context: PackagePlan,
  invocation: PluginSkillInvocation,
  placeholders: number,
): void {
  const marketplace = context.codexMarketplace;
  validateCodexInvocationMembership(marketplace, invocation.pluginName);
  validateCodexInvocationBody(
    marketplace,
    invocation.skillName,
    context.inlineArtifacts,
    placeholders,
  );
  requireNegotiatedCapability(
    options,
    "sevro.codex.explicit-invocation",
    "Codex explicit invocation capability was not negotiated",
  );
}

function validRepositoryInvocationIdentity(
  skillName: string,
  placeholders: number,
): boolean {
  return (
    /^[A-Za-z0-9._-]+$/.test(skillName) &&
    skillName !== "." &&
    skillName !== ".." &&
    placeholders === 1
  );
}

function validateRepositoryInvocationBody(
  artifacts: InlineArtifact[],
  path: string,
  message: string,
): void {
  if (
    !artifacts.some(
      (artifact) => artifact.gitExclude && artifact.relativePath === path,
    )
  )
    throw new EvaluationConfigurationError(message);
}

function validateCodexRepositoryInvocation(
  options: EvaluationOptions,
  context: PackagePlan,
  invocation: RepositorySkillInvocation,
  placeholders: number,
): void {
  const message = "invalid Codex repository skill invocation declaration";
  if (!validRepositoryInvocationIdentity(invocation.skillName, placeholders))
    throw new EvaluationConfigurationError(message);
  validateRepositoryInvocationBody(
    context.inlineArtifacts,
    `.agents/skills/${invocation.skillName}/SKILL.md`,
    message,
  );
  requireNegotiatedCapability(
    options,
    "sevro.codex.repository-invocation",
    "Codex repository invocation capability was not negotiated",
  );
}

function validateClaudeRepositoryPrompt(prompt: string): void {
  if (
    !prompt.startsWith(INVOCATION_PLACEHOLDER) ||
    prompt.includes(LEGACY_CODEX_PLACEHOLDER)
  )
    throw new EvaluationConfigurationError(
      "invalid Claude repository skill invocation declaration",
    );
}

function validateClaudeRepositoryInvocation(
  options: EvaluationOptions,
  context: PackagePlan,
  invocation: RepositorySkillInvocation,
  placeholders: number,
): void {
  const message = "invalid Claude repository skill invocation declaration";
  if (!validRepositoryInvocationIdentity(invocation.skillName, placeholders))
    throw new EvaluationConfigurationError(message);
  validateClaudeRepositoryPrompt(options.case.prompt);
  validateRepositoryInvocationBody(
    context.inlineArtifacts,
    `.claude/skills/${invocation.skillName}/SKILL.md`,
    message,
  );
  requireNegotiatedCapability(
    options,
    "sevro.claude.repository-invocation",
    "Claude repository invocation capability was not negotiated",
  );
}

function validateClaudeInvocationIdentity(
  directories: ClaudePluginDirectories | undefined,
  invocation: PluginSkillInvocation,
  placeholders: number,
): asserts directories is ClaudePluginDirectories {
  if (
    !directories ||
    !/^[a-z][a-z0-9-]*$/.test(invocation.pluginName) ||
    !/^[A-Za-z0-9._-]+$/.test(invocation.skillName) ||
    placeholders !== 1
  )
    throw new EvaluationConfigurationError(
      "invalid Claude skill invocation declaration",
    );
}

function validateClaudePluginPrompt(caseData: ResolvedCase): void {
  if (
    caseData.prompt.includes(LEGACY_CODEX_PLACEHOLDER) ||
    caseData.followUpPrompt?.includes(LEGACY_CODEX_PLACEHOLDER)
  )
    throw new EvaluationConfigurationError(
      "invalid Claude skill invocation declaration",
    );
}

function validateClaudeInvocationBody(
  directories: ClaudePluginDirectories,
  skillName: string,
  artifacts: InlineArtifact[],
): void {
  if (
    !directories.artifactRoots.some((root) =>
      artifacts.some(
        (artifact) =>
          artifact.relativePath === `${root}/skills/${skillName}/SKILL.md`,
      ),
    )
  )
    throw new EvaluationConfigurationError(
      "invalid Claude skill invocation declaration",
    );
}

function validateClaudePluginInvocation(
  options: EvaluationOptions,
  context: PackagePlan,
  invocation: PluginSkillInvocation,
  placeholders: number,
): void {
  const directories = context.claudePluginDirs;
  validateClaudeInvocationIdentity(directories, invocation, placeholders);
  validateClaudePluginPrompt(options.case);
  validateClaudeInvocationBody(
    directories,
    invocation.skillName,
    context.inlineArtifacts,
  );
  requireNegotiatedCapability(
    options,
    "sevro.claude.explicit-invocation",
    "Claude explicit invocation capability was not negotiated",
  );
}

function validateUndeclaredPlaceholder(placeholders: number): void {
  if (placeholders)
    throw new EvaluationConfigurationError(
      "skill invocation placeholder requires a declaration",
    );
}

function validateSelectedSkillInvocation(
  options: EvaluationOptions,
  context: PackagePlan,
  selected: SelectedSkillInvocation,
  placeholders: number,
): void {
  switch (selected.kind) {
    case "codex-plugin":
      validateCodexPluginInvocation(
        options,
        context,
        selected.value,
        placeholders,
      );
      break;
    case "codex-repository":
      validateCodexRepositoryInvocation(
        options,
        context,
        selected.value,
        placeholders,
      );
      break;
    case "claude-repository":
      validateClaudeRepositoryInvocation(
        options,
        context,
        selected.value,
        placeholders,
      );
      break;
    case "claude-plugin":
      validateClaudePluginInvocation(
        options,
        context,
        selected.value,
        placeholders,
      );
      break;
    case "none":
      validateUndeclaredPlaceholder(placeholders);
      break;
  }
}

function prepareSkillInvocation(
  options: EvaluationOptions,
  state: PackagePlan,
) {
  const declarations = skillInvocationDeclarations(state.extensionPreparation);
  const metadata = invocationMetadata(declarations);
  const invocationToken = invocationTokenFor(declarations);
  const placeholderCount =
    promptPlaceholderCount(options.case, INVOCATION_PLACEHOLDER) +
    promptPlaceholderCount(options.case, LEGACY_CODEX_PLACEHOLDER);
  validateOnlyOneInvocation(declarations);
  validateSelectedSkillInvocation(
    options,
    state,
    selectedSkillInvocation(declarations),
    placeholderCount,
  );
  return {
    ...state,
    ...declarations,
    ...metadata,
    invocationToken,
    invocationPlaceholder: INVOCATION_PLACEHOLDER,
    legacyCodexPlaceholder: LEGACY_CODEX_PLACEHOLDER,
    placeholderCount,
  };
}

type InvocationPlan = ReturnType<typeof prepareSkillInvocation>;
type EvaluationRouteRole = "candidate" | "semantic" | "advisory";
interface ActiveGrader {
  id: string;
  source: "builtin" | "extension";
  version: string;
}

function extensionPreparationData(
  options: EvaluationOptions,
  preparation: InvocationPlan["extensionPreparation"],
): Record<string, unknown> {
  return options.extension
    ? {
        ...options.extension.resolvedCase.extensionData,
        ...preparation?.extensionData,
      }
    : {};
}

function evaluationRoute(host: HostAdapter, role: EvaluationRouteRole) {
  return { role, host: host.id, model: host.model, effort: host.effort };
}

function semanticEvaluationRoute(host: HostAdapter | undefined) {
  if (!host)
    throw new EvaluationConfigurationError(
      "semantic checks require an explicit semantic host",
    );
  return evaluationRoute(host, "semantic");
}

function evaluationRoutes(
  options: EvaluationOptions,
  semantic: boolean,
  candidate: ReturnType<typeof evaluationRoute>,
) {
  return [
    candidate,
    ...(semantic ? [semanticEvaluationRoute(options.semanticHost)] : []),
    ...(options.advisoryHost
      ? [evaluationRoute(options.advisoryHost, "advisory")]
      : []),
  ];
}

function redactedHostConfiguration(
  options: EvaluationOptions,
  semantic: boolean,
) {
  const selections = [
    { role: "candidate", host: options.host },
    { role: "semantic", host: semantic ? options.semanticHost : undefined },
    { role: "advisory", host: options.advisoryHost },
  ];
  const configuration = Object.fromEntries(
    selections.flatMap(({ role, host }) => {
      if (host?.configuration === undefined) return [];
      return [[role, host.configuration]];
    }),
  );
  return Object.keys(configuration).length
    ? { hostConfiguration: configuration }
    : {};
}

function redactedExtensionConfiguration(options: EvaluationOptions) {
  return {
    extensionConfigurationDigest:
      options.extension?.session.identity.configurationDigest ?? null,
    ...(options.extension
      ? {
          extensionConfiguration:
            options.extension.session.redactedConfiguration,
        }
      : {}),
  };
}

function skillInvocationConfiguration(state: InvocationPlan) {
  return {
    ...(state.codexSkillInvocation
      ? { codexSkillInvocation: state.codexSkillInvocation }
      : {}),
    ...(state.codexRepositorySkillInvocation
      ? { codexRepositorySkillInvocation: state.codexRepositorySkillInvocation }
      : {}),
    ...(state.claudeSkillInvocation
      ? { claudeSkillInvocation: state.claudeSkillInvocation }
      : {}),
    ...(state.claudeRepositorySkillInvocation
      ? {
          claudeRepositorySkillInvocation:
            state.claudeRepositorySkillInvocation,
        }
      : {}),
  };
}

function redactedPreparationConfiguration(state: InvocationPlan) {
  return {
    ...(state.fixtureSetup
      ? { fixtureSetupDigest: hashJson(state.fixtureSetup) }
      : {}),
    ...(state.codexMarketplace
      ? { codexMarketplace: state.codexMarketplace }
      : {}),
    ...(state.claudePluginDirs
      ? { claudePluginDirs: state.claudePluginDirs }
      : {}),
  };
}

function redactedAdvisoryConfiguration(options: EvaluationOptions) {
  return options.advisoryHost
    ? {
        advisoryExcludedPaths: [
          ...(options.advisoryExcludedPaths ?? []),
        ].sort(),
      }
    : {};
}

function redactedEvaluationConfiguration(
  options: EvaluationOptions,
  state: InvocationPlan,
) {
  return {
    condition: options.condition,
    executionMode: options.dry ? "dry" : "executed",
    trialCount: options.trialCount,
    jobs: state.jobs,
    passThreshold: options.passThreshold,
    ...redactedHostConfiguration(options, state.preparedSemantic.length > 0),
    ...redactedExtensionConfiguration(options),
    ...redactedPreparationConfiguration(state),
    ...skillInvocationConfiguration(state),
    ...redactedAdvisoryConfiguration(options),
  };
}

function activeEvaluationGraders(
  options: EvaluationOptions,
  state: InvocationPlan,
): ActiveGrader[] {
  const graders: ActiveGrader[] = [
    ...new Set(
      [
        ...state.builtinDeclarations,
        ...state.shellDeclarations,
        ...state.gitHeadDeclarations,
        ...state.semanticDeclarations,
      ].map((check) => check.grader),
    ),
  ]
    .sort()
    .map((id) => ({ id, source: "builtin", version: "1.0.0" }));
  if (options.extension) {
    for (const id of [
      ...new Set(state.extensionDeclarations.map((check) => check.grader)),
    ].sort())
      graders.push({
        id,
        source: "extension",
        version: options.extension.session.identity.version,
      });
  }
  return graders;
}

function extensionIdentityDimensions(options: EvaluationOptions) {
  return {
    extensionDigest: options.extension?.session.identity.sourceDigest ?? null,
    extensionProtocol: options.extension?.session.identity.protocol ?? null,
  };
}

function caseIdentityData(
  caseData: ResolvedCase,
  extensionData: Record<string, unknown>,
) {
  return {
    id: caseData.id,
    prompt: caseData.prompt,
    ...(caseData.followUpPrompt !== undefined
      ? { followUpPrompt: caseData.followUpPrompt }
      : {}),
    extensionData,
  };
}

function baseFixtureIdentity(
  state: InvocationPlan,
  fixture: ResolvedCase["fixture"],
) {
  if (state.generated) return state.generated;
  if (state.repository)
    return { ...state.repositoryFixture, revision: state.repository.revision };
  return { files: fixture.files };
}

function artifactIdentityData(artifacts: InlineArtifact[]) {
  return artifacts.map(
    ({ id, relativePath, sha256, gitExclude, executable }) => ({
      id,
      relativePath,
      sha256,
      ...(gitExclude ? { gitExclude: true } : {}),
      ...(executable ? { executable: true } : {}),
    }),
  );
}

function fixtureIdentityData(
  state: InvocationPlan,
  fixture: ResolvedCase["fixture"],
) {
  return {
    ...baseFixtureIdentity(state, fixture),
    artifacts: artifactIdentityData(state.inlineArtifacts),
    ...(state.fixtureSetup ? { fixtureSetup: state.fixtureSetup } : {}),
    ...(state.codexMarketplace
      ? { codexMarketplace: state.codexMarketplace }
      : {}),
    ...(state.claudePluginDirs
      ? { claudePluginDirs: state.claudePluginDirs }
      : {}),
    ...skillInvocationConfiguration(state),
  };
}

function evaluatorIdentityData(
  options: EvaluationOptions,
  extensionData: Record<string, unknown>,
) {
  return {
    policy: "sevro.builtin-output.v1",
    extension: options.extension?.session.identity ?? null,
    extensionData,
  };
}

type IdentityPlan = InvocationPlan & {
  extensionData: Record<string, unknown>;
  route: ReturnType<typeof evaluationRoute>;
  routes: ReturnType<typeof evaluationRoutes>;
  redactedConfig: ReturnType<typeof redactedEvaluationConfiguration>;
  activeGraders: ActiveGrader[];
};

function evaluationComparisonIdentity(
  options: EvaluationOptions,
  context: IdentityPlan,
) {
  try {
    return createEvaluationIdentity({
      runnerBuildDigest: options.runnerBuildDigest,
      projectDigest: options.projectDigest,
      configurationDigest: hashJson(context.redactedConfig),
      ...extensionIdentityDimensions(options),
      caseDigest: hashJson(
        caseIdentityData(options.case, context.extensionData),
      ),
      fixtureDigest: hashJson(
        fixtureIdentityData(context, options.case.fixture),
      ),
      checksDigest: hashJson(options.case.checks),
      requiredEvidenceDigest: hashJson(options.case.requiredEvidence),
      evaluatorDigest: hashJson(
        evaluatorIdentityData(options, context.extensionData),
      ),
      graderDigest: hashJson(context.activeGraders),
      instrumentationDigest: hashJson({
        requested: context.requestedInstrumentation,
        applied: context.requestedInstrumentation,
      }),
      routeDigest: hashJson(
        context.routes.length > 1 ? context.routes : context.route,
      ),
      condition: options.condition,
      trialCount: options.trialCount,
      passThreshold: options.passThreshold,
    });
  } catch (cause) {
    throw new EvaluationConfigurationError(
      "invalid evaluation identity inputs",
      { cause },
    );
  }
}

function prepareEvaluationIdentity(
  options: EvaluationOptions,
  state: InvocationPlan,
) {
  const extensionData = extensionPreparationData(
    options,
    state.extensionPreparation,
  );
  const runId = randomUUID();
  const route = evaluationRoute(options.host, "candidate");
  const routes = evaluationRoutes(
    options,
    state.preparedSemantic.length > 0,
    route,
  );
  const redactedConfig = snapshotEvaluationConfiguration(options, state);
  const activeGraders = activeEvaluationGraders(options, state);
  const context = {
    ...state,
    extensionData,
    route,
    routes,
    redactedConfig,
    activeGraders,
  };
  const evaluationIdentity = evaluationComparisonIdentity(options, context);
  return { ...context, runId, evaluationIdentity };
}

function snapshotEvaluationConfiguration(
  options: EvaluationOptions,
  state: InvocationPlan,
): ReturnType<typeof redactedEvaluationConfiguration> {
  try {
    return JSON.parse(
      canonicalJson(redactedEvaluationConfiguration(options, state)),
    ) as ReturnType<typeof redactedEvaluationConfiguration>;
  } catch (cause) {
    throw new EvaluationConfigurationError(
      "invalid evaluation identity inputs",
      { cause },
    );
  }
}

export async function prepareEvaluation(options: EvaluationOptions) {
  validateEvaluationInputs(options);
  const fixture = prepareEvaluationFixture(options);
  const trials = prepareTrialParameters(options, fixture);
  const checks = prepareCheckPlan(options, trials);
  const environment = await prepareEvaluationEnvironment(options, checks);
  const artifacts = await prepareEvaluationArtifacts(options, environment);
  const packages = preparePackageArtifacts(options, artifacts);
  const invocation = prepareSkillInvocation(options, packages);
  return prepareEvaluationIdentity(options, invocation);
}

export type EvaluationPlan = Awaited<ReturnType<typeof prepareEvaluation>>;
