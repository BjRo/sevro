import { realpath } from "node:fs/promises";
import {
  EvaluationConfigurationError,
  type EvaluationOptions,
  type HostAdapter,
  type ResolvedCase,
} from "./types";
import { prepareFixtureSetup, type FixtureSetup } from "../fixtures/setup";
import { type GeneratedFixture } from "../fixtures/generated";
import { type SemanticCheckDeclaration } from "../graders/semantic";
import { canonicalJson, createEvaluationIdentity, hashJson } from "../identity";
import {
  prepareInstrumentation,
  type InstrumentationRequest,
} from "../instrumentation";
import {
  fixtureParts,
  prepareArtifacts,
  type InlineArtifact,
} from "../fixtures/preparation";
import { projectProvenance, runnerProvenance } from "../provenance";
import {
  resolveRepositorySource,
  type RepositorySource,
} from "../fixtures/repository";
import { prepareEvaluationChecks } from "./check-plan";
import { prepareInvocationPlan } from "./invocation-plan";

async function prepareEvaluationEnvironment(options: EvaluationOptions) {
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
    projectProvenance(projectRoot, evaluationStorageRoots(options)),
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
    projectRoot,
    repository,
    runner,
    project,
    extensionPreparation,
  };
}

type EnvironmentPlan = Awaited<ReturnType<typeof prepareEvaluationEnvironment>>;

function evaluationStorageRoots(options: EvaluationOptions): string[] {
  return [options.resultsRoot, options.runStateRoot ?? options.resultsRoot];
}

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
  generated: GeneratedFixture | null,
): Promise<InlineArtifact[]> {
  try {
    return await prepareArtifacts(
      context.extensionPreparation?.artifacts ?? [],
      fixturePreparationPaths(options.case.fixture, generated),
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
  checks: CheckPlan,
) {
  const fixtureSetup = preparedFixtureSetup(state.extensionPreparation);
  validateSetupCapability(options, fixtureSetup);
  validateSetupFixture(fixtureSetup, checks.generated, state.repository);
  const requestedInstrumentation = requestedInstrumentationPlan(
    options,
    state.extensionPreparation,
  );
  const inlineArtifacts = await preparedEvaluationArtifacts(
    options,
    state,
    checks.generated,
  );
  validateArtifactMetadata(inlineArtifacts, checks.generated, state.repository);
  validateArtifactExclusions(
    inlineArtifacts,
    checks.generated,
    state.repository,
  );
  validateSemanticArtifactId(inlineArtifacts, checks.semanticDeclarations);
  return { fixtureSetup, requestedInstrumentation, inlineArtifacts };
}

type CheckPlan = ReturnType<typeof prepareEvaluationChecks>;
type ArtifactPlan = Awaited<ReturnType<typeof prepareEvaluationArtifacts>>;
type InvocationPlan = ReturnType<
  typeof prepareInvocationPlan<{
    extensionPreparation: EnvironmentPlan["extensionPreparation"];
    inlineArtifacts: InlineArtifact[];
  }>
>;
type EvaluationRouteRole = "candidate" | "semantic" | "advisory";
interface ActiveGrader {
  id: string;
  source: "builtin" | "extension";
  version: string;
}

export interface PreparedFixture {
  readonly projectRoot: string;
  readonly repository: EnvironmentPlan["repository"];
  readonly repositoryFixture: CheckPlan["repositoryFixture"];
  readonly generated: CheckPlan["generated"];
  readonly fixtureSetup: ArtifactPlan["fixtureSetup"];
  readonly inlineArtifacts: InlineArtifact[];
}

export interface PreparedChecks extends Readonly<
  Pick<
    CheckPlan,
    | "prepared"
    | "preparedShell"
    | "preparedGitHead"
    | "preparedSemantic"
    | "builtinDeclarations"
    | "shellDeclarations"
    | "gitHeadDeclarations"
    | "semanticDeclarations"
    | "extensionDeclarations"
    | "replacedBuiltinGraders"
  >
> {
  readonly replaced: ReadonlySet<string>;
}

export type PreparedInvocation = Readonly<
  Pick<
    InvocationPlan,
    | "codexMarketplace"
    | "claudePluginDirs"
    | "codexSkillInvocation"
    | "codexRepositorySkillInvocation"
    | "claudeSkillInvocation"
    | "claudeRepositorySkillInvocation"
    | "invocation"
    | "invocationToken"
    | "invocationPlaceholder"
    | "legacyCodexPlaceholder"
  >
>;

interface PreparedEvaluationInputs {
  readonly fixture: PreparedFixture;
  readonly checks: PreparedChecks;
  readonly invocation: PreparedInvocation;
  readonly jobs: number;
  readonly requestedInstrumentation: InstrumentationRequest[];
  readonly runner: EnvironmentPlan["runner"];
  readonly project: EnvironmentPlan["project"];
}

export interface PreparedEvaluation extends PreparedEvaluationInputs {
  readonly extensionData: Record<string, unknown>;
  readonly route: ReturnType<typeof evaluationRoute>;
  readonly routes: ReturnType<typeof evaluationRoutes>;
  readonly redactedConfig: ReturnType<typeof redactedEvaluationConfiguration>;
  readonly activeGraders: ActiveGrader[];
  readonly evaluationIdentity: ReturnType<typeof createEvaluationIdentity>;
}

function extensionPreparationData(
  options: EvaluationOptions,
  preparation: EnvironmentPlan["extensionPreparation"],
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

function skillInvocationConfiguration(state: PreparedInvocation) {
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

function redactedPreparationConfiguration(state: PreparedEvaluationInputs) {
  return {
    ...(state.fixture.fixtureSetup
      ? { fixtureSetupDigest: hashJson(state.fixture.fixtureSetup) }
      : {}),
    ...(state.invocation.codexMarketplace
      ? { codexMarketplace: state.invocation.codexMarketplace }
      : {}),
    ...(state.invocation.claudePluginDirs
      ? { claudePluginDirs: state.invocation.claudePluginDirs }
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
  state: PreparedEvaluationInputs,
) {
  return {
    condition: options.condition,
    executionMode: options.dry ? "dry" : "executed",
    ...(options.runtimePolicy ? { runtimePolicy: options.runtimePolicy } : {}),
    trialCount: options.trialCount,
    jobs: state.jobs,
    passThreshold: options.passThreshold,
    ...(options.assessmentSettings
      ? { runSettings: options.assessmentSettings }
      : {}),
    ...redactedHostConfiguration(
      options,
      state.checks.preparedSemantic.length > 0,
    ),
    ...redactedExtensionConfiguration(options),
    ...redactedPreparationConfiguration(state),
    ...skillInvocationConfiguration(state.invocation),
    ...redactedAdvisoryConfiguration(options),
  };
}

function activeEvaluationGraders(
  options: EvaluationOptions,
  state: PreparedChecks,
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
  state: PreparedFixture,
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
  state: PreparedEvaluationInputs,
  fixture: ResolvedCase["fixture"],
) {
  return {
    ...baseFixtureIdentity(state.fixture, fixture),
    artifacts: artifactIdentityData(state.fixture.inlineArtifacts),
    ...(state.fixture.fixtureSetup
      ? { fixtureSetup: state.fixture.fixtureSetup }
      : {}),
    ...(state.invocation.codexMarketplace
      ? { codexMarketplace: state.invocation.codexMarketplace }
      : {}),
    ...(state.invocation.claudePluginDirs
      ? { claudePluginDirs: state.invocation.claudePluginDirs }
      : {}),
    ...skillInvocationConfiguration(state.invocation),
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

type IdentityMetadata = {
  extensionData: Record<string, unknown>;
  route: ReturnType<typeof evaluationRoute>;
  routes: ReturnType<typeof evaluationRoutes>;
  redactedConfig: ReturnType<typeof redactedEvaluationConfiguration>;
  activeGraders: ActiveGrader[];
};

function evaluationComparisonIdentity(
  options: EvaluationOptions,
  prepared: PreparedEvaluationInputs,
  context: IdentityMetadata,
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
        fixtureIdentityData(prepared, options.case.fixture),
      ),
      checksDigest: hashJson(options.case.checks),
      requiredEvidenceDigest: hashJson(options.case.requiredEvidence),
      evaluatorDigest: hashJson(
        evaluatorIdentityData(options, context.extensionData),
      ),
      graderDigest: hashJson(context.activeGraders),
      instrumentationDigest: hashJson({
        requested: prepared.requestedInstrumentation,
        applied: prepared.requestedInstrumentation,
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
  state: PreparedEvaluationInputs,
  preparation: EnvironmentPlan["extensionPreparation"],
) {
  const extensionData = extensionPreparationData(options, preparation);
  const route = evaluationRoute(options.host, "candidate");
  const routes = evaluationRoutes(
    options,
    state.checks.preparedSemantic.length > 0,
    route,
  );
  const redactedConfig = snapshotEvaluationConfiguration(options, state);
  const activeGraders = activeEvaluationGraders(options, state.checks);
  const context = {
    extensionData,
    route,
    routes,
    redactedConfig,
    activeGraders,
  };
  const evaluationIdentity = evaluationComparisonIdentity(
    options,
    state,
    context,
  );
  return { ...state, ...context, evaluationIdentity };
}

function snapshotEvaluationConfiguration(
  options: EvaluationOptions,
  state: PreparedEvaluationInputs,
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

function preparedChecks(checks: CheckPlan): PreparedChecks {
  return {
    prepared: checks.prepared,
    preparedShell: checks.preparedShell,
    preparedGitHead: checks.preparedGitHead,
    preparedSemantic: checks.preparedSemantic,
    builtinDeclarations: checks.builtinDeclarations,
    shellDeclarations: checks.shellDeclarations,
    gitHeadDeclarations: checks.gitHeadDeclarations,
    semanticDeclarations: checks.semanticDeclarations,
    extensionDeclarations: checks.extensionDeclarations,
    replacedBuiltinGraders: checks.replacedBuiltinGraders,
    replaced: checks.replaced,
  };
}

function preparedInvocation(invocation: InvocationPlan): PreparedInvocation {
  return {
    codexMarketplace: invocation.codexMarketplace,
    claudePluginDirs: invocation.claudePluginDirs,
    codexSkillInvocation: invocation.codexSkillInvocation,
    codexRepositorySkillInvocation: invocation.codexRepositorySkillInvocation,
    claudeSkillInvocation: invocation.claudeSkillInvocation,
    claudeRepositorySkillInvocation: invocation.claudeRepositorySkillInvocation,
    invocation: invocation.invocation,
    invocationToken: invocation.invocationToken,
    invocationPlaceholder: invocation.invocationPlaceholder,
    legacyCodexPlaceholder: invocation.legacyCodexPlaceholder,
  };
}

export async function prepareEvaluation(
  options: EvaluationOptions,
): Promise<PreparedEvaluation> {
  const checks = prepareEvaluationChecks(options);
  const environment = await prepareEvaluationEnvironment(options);
  const artifacts = await prepareEvaluationArtifacts(
    options,
    environment,
    checks,
  );
  const invocation = prepareInvocationPlan(options, {
    extensionPreparation: environment.extensionPreparation,
    inlineArtifacts: artifacts.inlineArtifacts,
  });
  const prepared: PreparedEvaluationInputs = {
    fixture: {
      projectRoot: environment.projectRoot,
      repository: environment.repository,
      repositoryFixture: checks.repositoryFixture,
      generated: checks.generated,
      fixtureSetup: artifacts.fixtureSetup,
      inlineArtifacts: artifacts.inlineArtifacts,
    },
    checks: preparedChecks(checks),
    invocation: preparedInvocation(invocation),
    jobs: checks.jobs,
    requestedInstrumentation: artifacts.requestedInstrumentation,
    runner: environment.runner,
    project: environment.project,
  };
  return prepareEvaluationIdentity(
    options,
    prepared,
    environment.extensionPreparation,
  );
}
