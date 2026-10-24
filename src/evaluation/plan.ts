import { realpath } from "node:fs/promises";
import {
  EvaluationConfigurationError,
  type EvaluationOptions,
  type HostAdapter,
  type ResolvedCase,
} from "./types";
import { prepareFixtureSetup, type FixtureSetup } from "../fixtures/setup";
import type { FixtureSource } from "../fixtures/create";
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
import { resolveRepositorySource } from "../fixtures/repository";
import {
  prepareEvaluationChecks,
  type EvaluationCheckPlan,
  type PreparedChecks,
} from "./check-plan";
import {
  prepareInvocationPlan,
  type PreparedInvocation,
} from "./invocation-plan";
import type { PreparationResult } from "../extension-session";

export type { PreparedChecks } from "./check-plan";
export type { PreparedInvocation } from "./invocation-plan";

interface EnvironmentPlan {
  readonly projectRoot: string;
  readonly source: FixtureSource;
  readonly runner: Awaited<ReturnType<typeof runnerProvenance>>;
  readonly project: Awaited<ReturnType<typeof projectProvenance>>;
  readonly extensionPreparation: PreparationResult | null;
}

interface ArtifactPlan {
  readonly fixtureSetup: FixtureSetup | null;
  readonly requestedInstrumentation: InstrumentationRequest[];
  readonly inlineArtifacts: InlineArtifact[];
}

async function prepareEvaluationEnvironment(
  options: EvaluationOptions,
  source: FixtureSource<null>,
): Promise<EnvironmentPlan> {
  const projectRoot = await realpath(options.projectRoot).catch(() => {
    throw new EvaluationConfigurationError("project root is unreadable");
  });
  const resolvedSource = await resolveFixtureSource(options, source);
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
    source: resolvedSource,
    runner,
    project,
    extensionPreparation,
  };
}

async function resolveFixtureSource(
  options: EvaluationOptions,
  source: FixtureSource<null>,
): Promise<FixtureSource> {
  if (source.kind !== "repository") return source;
  const repository = await resolveRepositorySource(
    source.fixture.sourceRef,
    options.preparationSources,
  ).catch((error: unknown) => {
    throw new EvaluationConfigurationError(
      error instanceof Error ? error.message : "invalid repository source",
    );
  });
  return { ...source, repository };
}

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
  source: FixtureSource,
): void {
  if (setup && source.kind === "inline")
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

function fixturePreparationPaths(source: FixtureSource): string[] {
  switch (source.kind) {
    case "inline":
      return Object.keys(source.files ?? {});
    case "repository":
      return Object.keys(source.fixture.files ?? {});
    case "generated":
      return [
        ...new Set([
          ...source.fixture.commits.flatMap((commit) =>
            Object.keys(commit.files),
          ),
          ...Object.keys(source.fixture.files ?? {}),
        ]),
      ];
  }
}

async function preparedEvaluationArtifacts(
  options: EvaluationOptions,
  context: EnvironmentPlan,
): Promise<InlineArtifact[]> {
  try {
    return await prepareArtifacts(
      context.extensionPreparation?.artifacts ?? [],
      fixturePreparationPaths(context.source),
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
  source: FixtureSource,
): void {
  if (
    source.kind !== "inline" &&
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
  source: FixtureSource,
): void {
  if (
    source.kind === "inline" &&
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
  checks: EvaluationCheckPlan,
): Promise<ArtifactPlan> {
  const fixtureSetup = preparedFixtureSetup(state.extensionPreparation);
  validateSetupCapability(options, fixtureSetup);
  validateSetupFixture(fixtureSetup, state.source);
  const requestedInstrumentation = requestedInstrumentationPlan(
    options,
    state.extensionPreparation,
  );
  const inlineArtifacts = await preparedEvaluationArtifacts(options, state);
  validateArtifactMetadata(inlineArtifacts, state.source);
  validateArtifactExclusions(inlineArtifacts, state.source);
  validateSemanticArtifactId(
    inlineArtifacts,
    checks.checks.semanticDeclarations,
  );
  return { fixtureSetup, requestedInstrumentation, inlineArtifacts };
}

type EvaluationRouteRole = "candidate" | "semantic" | "advisory";
interface ActiveGrader {
  id: string;
  source: "builtin" | "extension";
  version: string;
}

export interface PreparedFixture {
  readonly projectRoot: string;
  readonly source: FixtureSource;
  readonly fixtureSetup: ArtifactPlan["fixtureSetup"];
  readonly inlineArtifacts: InlineArtifact[];
}

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
    ...state.invocation.configuration,
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

function baseFixtureIdentity(source: FixtureSource) {
  switch (source.kind) {
    case "generated":
      return source.fixture;
    case "repository":
      return { ...source.fixture, revision: source.repository.revision };
    case "inline":
      return { files: source.files };
  }
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

function fixtureIdentityData(state: PreparedEvaluationInputs) {
  return {
    ...baseFixtureIdentity(state.fixture.source),
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
    ...state.invocation.configuration,
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
      fixtureDigest: hashJson(fixtureIdentityData(prepared)),
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
): PreparedEvaluation {
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

export async function prepareEvaluation(
  options: EvaluationOptions,
): Promise<PreparedEvaluation> {
  const checks = prepareEvaluationChecks(options);
  const environment = await prepareEvaluationEnvironment(
    options,
    checks.source,
  );
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
      source: environment.source,
      fixtureSetup: artifacts.fixtureSetup,
      inlineArtifacts: artifacts.inlineArtifacts,
    },
    checks: checks.checks,
    invocation,
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
