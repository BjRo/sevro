import { createHash, randomUUID } from "node:crypto";
import {
  advisoryPrompt,
  parseAdvisoryAssessment,
  type AdvisoryAssessment,
} from "./advisory";
import {
  advisoryBaseRevision,
  buildBlindAdvisoryFixture,
} from "./advisory-fixture";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  gradeOutput,
  isOutputGrader,
  prepareOutputChecks,
  type OutputCheckDeclaration,
} from "./graders/output";
import {
  assessGitHeadCheck,
  gitHeadRevision,
  gitHeadState,
  prepareGitHeadChecks,
  type GitHeadCheckDeclaration,
} from "./graders/git-head";
import {
  assessShellCheck,
  prepareShellChecks,
  runShellCheck,
  type ShellCheckDeclaration,
} from "./graders/shell";
import {
  parseSemanticVerdicts,
  prepareSemanticChecks,
  semanticPrompt,
  type SemanticCheckDeclaration,
} from "./graders/semantic";
import { evaluationProtectedRoots } from "./hosts/isolation-roots";
import { canonicalJson, createEvaluationIdentity, hashJson } from "./identity";
import { fixtureBinDirectory, installFixtureBin } from "./fixture-bin";
import { installGitHooks } from "./git-hooks";
import {
  InstrumentationEvidenceError,
  prepareInstrumentation,
  verifyAppliedInstrumentation,
  type InstrumentationCapability,
  type InstrumentationRequest,
} from "./instrumentation";
import {
  materializeGeneratedFixture,
  prepareGeneratedFixture,
  type GeneratedFixture,
} from "./generated-fixture";
import {
  prepareFixtureSetup,
  runFixtureSetup,
  type FixtureSetup,
} from "./fixture-setup";
import {
  fixtureParts,
  prepareArtifacts,
  safePreparationTarget,
  type InlineArtifact,
  type PreparationSources,
} from "./preparation";
import {
  applyRepositoryOverlay,
  cloneRepositorySource,
  prepareRepositoryFixture,
  resolveRepositorySource,
  type RepositoryFixture,
  type RepositorySource,
} from "./repository-fixture";
import type { EvaluationResult, ExtensionCase } from "./extension-session";
import { openExtensionSession } from "./extension-session";
import {
  applyTaskVerdictPolicy,
  assessTrial,
  exitCodeFor,
  summarizeAssessments,
  summarizeCases,
  type Assessment,
  type CheckOutcome,
} from "./results";
import { assertCliResult, assertRunEvidence } from "./schema";
import { atomicWriteJson } from "./storage";
import { projectProvenance, runnerProvenance } from "./provenance";
import { checkpointRunOwner, startRunOwner } from "./run-owner";

const MAX_FINAL_MESSAGE_BYTES = 8 * 1024 * 1024;

export class EvaluationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationConfigurationError";
  }
}

export interface HostResult {
  finalMessage: string | null;
  complete: boolean;
  executionFailed?: boolean;
  artifacts?: { id: string; bytes: Uint8Array }[];
  observations?: {
    id: string;
    completeness: "complete" | "partial" | "unavailable";
    data: Record<string, unknown>;
  }[];
  actualCondition?: "passive" | "enforced" | "unknown";
  appliedInstrumentation?: InstrumentationRequest[];
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  usageComplete?: boolean;
}

export interface HostAdapter {
  id: string;
  model: string;
  effort: string;
  instrumentation?: InstrumentationCapability[];
  hostCapabilities?: string[];
  run(request: {
    prompt: string;
    followUpPrompt?: string;
    workspace: string;
    condition: "passive" | "enforced";
    fixtureBinDir?: string;
    instrumentation?: InstrumentationRequest[];
    codexMarketplace?: {
      artifactRoot: string;
      marketplaceName: string;
      pluginNames: string[];
      artifactPaths: string[];
    };
    claudePluginDirs?: {
      artifactRoots: string[];
      artifactPaths: string[];
    };
    explicitSkillInvocation?:
      | {
          scope?: "plugin";
          pluginName: string;
          skillName: string;
          token: string;
        }
      | {
          scope: "repository";
          pluginName?: never;
          skillName: string;
          token: string;
        };
    signal?: AbortSignal;
  }): Promise<HostResult>;
}

export interface ResolvedCase {
  id: string;
  prompt: string;
  followUpPrompt?: string;
  fixture:
    | { files: Record<string, string>; sourceRef?: never }
    | Omit<RepositoryFixture, "kind">
    | (GeneratedFixture & { sourceRef?: never });
  checks: {
    id: string;
    grader: string;
    configuration: Record<string, unknown>;
  }[];
  requiredEvidence: string[];
}

export interface EvaluationOptions {
  projectRoot: string;
  resultsRoot: string;
  runStateRoot?: string;
  case: ResolvedCase;
  host: HostAdapter;
  semanticHost?: HostAdapter;
  advisoryHost?: HostAdapter;
  advisoryExcludedPaths?: string[];
  runnerBuildDigest: string;
  runnerCheckoutRoot?: string;
  projectDigest: string;
  condition: "passive" | "enforced";
  trialCount: number;
  passThreshold: number;
  dry?: boolean;
  signal?: AbortSignal;
  extension?: {
    session: Awaited<ReturnType<typeof openExtensionSession>>;
    resolvedCase: ExtensionCase;
  };
  preparationSources?: PreparationSources;
  shellIsolation?: {
    protectedRoots: string[];
    toolchainBinDir?: string;
    uvRuntimeCache?: boolean;
  };
}

interface TrialSummary extends Assessment {
  trial: number;
  checks: CheckOutcome[];
  domainOutcomes: NonNullable<EvaluationResult["domainOutcomes"]>;
  artifactPath: string;
}

interface CaseSummary extends Assessment {
  caseId: string;
  trials: TrialSummary[];
}

export interface CliResult extends Assessment {
  format: "sevro.cli-result.v1";
  runId: string;
  exitCode: number;
  evidencePath: string;
  cases: CaseSummary[];
}

async function createFixture(
  fixture: ResolvedCase["fixture"],
  artifacts: InlineArtifact[],
  sources: PreparationSources | undefined,
  repository: RepositorySource | null,
  repositoryFixture: RepositoryFixture | null,
  generated: GeneratedFixture | null,
  setup: FixtureSetup | null,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const paths = Object.entries(
    generated || repository ? {} : (fixture.files ?? {}),
  ).map(([path, content]) => ({
    path,
    parts: fixtureParts(path),
    content,
  }));
  const workspace = await mkdtemp(join(tmpdir(), "sevro-case-"));
  try {
    if (repository)
      await cloneRepositorySource(
        fixture.sourceRef!,
        sources!,
        repository,
        workspace,
      );
    if (generated) await materializeGeneratedFixture(generated, workspace);
    if (repositoryFixture)
      await applyRepositoryOverlay(repositoryFixture, workspace);
    await installFixtureBin(
      generated?.bin ?? repositoryFixture?.bin,
      workspace,
    );
    await installGitHooks(
      generated?.hooks ?? repositoryFixture?.hooks,
      workspace,
    );
    for (const file of paths) {
      const target = join(workspace, ...file.parts);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { flag: "wx", mode: 0o600 });
    }
    if (setup)
      await runFixtureSetup(setup, {
        workspace,
        projectRoot,
        fixtureBinDir: (await fixtureBinDirectory(workspace)) ?? undefined,
        signal,
      });
    for (const artifact of artifacts) {
      const target = await safePreparationTarget(
        workspace,
        artifact.relativePath,
      );
      await writeFile(target, artifact.bytes, {
        flag: "wx",
        mode: artifact.executable ? 0o700 : 0o600,
      });
    }
    const gitExcluded = artifacts.filter((artifact) => artifact.gitExclude);
    if (gitExcluded.length) {
      const special = new Set(["\\", "*", "?", "[", "]", "#", "!", " "]);
      const patterns = gitExcluded.map((artifact) =>
        [...artifact.relativePath]
          .map((character) =>
            special.has(character) ? `\\${character}` : character,
          )
          .join(""),
      );
      await appendFile(
        join(workspace, ".git", "info", "exclude"),
        `\n${patterns.map((path) => `/${path}`).join("\n")}\n`,
      );
    }
    await fixtureBinDirectory(workspace);
    return workspace;
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function hostObservations(
  result: HostResult,
  hostId: string,
  existingIds: Set<string>,
) {
  const items = result.observations ?? [];
  if (items.length > 128) throw new Error("too many host observations");
  const ids = new Set([...existingIds, "sevro.observation.final-message"]);
  let totalBytes = 0;
  return items.map((item) => {
    if (
      !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(item.id) ||
      item.id.startsWith("sevro.observation.") ||
      ids.has(item.id) ||
      !["complete", "partial", "unavailable"].includes(item.completeness) ||
      !item.data ||
      typeof item.data !== "object" ||
      Array.isArray(item.data)
    )
      throw new Error("invalid host observation");
    ids.add(item.id);
    const data = canonicalJson(item.data);
    totalBytes += Buffer.byteLength(data, "utf8");
    if (totalBytes > 8 * 1024 * 1024)
      throw new Error("host observations exceed 8 MiB");
    return {
      id: item.id,
      source: hostId,
      completeness: item.completeness,
      data: JSON.parse(data) as Record<string, unknown>,
    };
  });
}

function hostArtifacts(result: HostResult, existingIds: Set<string>) {
  const items = result.artifacts ?? [];
  if (!Array.isArray(items) || items.length > 32)
    throw new Error("too many host artifacts");
  const ids = new Set(existingIds);
  let totalBytes = 0;
  return items.map((item) => {
    if (
      !item ||
      !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(item.id) ||
      ids.has(item.id) ||
      !(item.bytes instanceof Uint8Array)
    )
      throw new Error("invalid host artifact");
    ids.add(item.id);
    totalBytes += item.bytes.byteLength;
    if (
      item.bytes.byteLength > 8 * 1024 * 1024 ||
      totalBytes > 32 * 1024 * 1024
    )
      throw new Error("host artifacts exceed the size limit");
    return { id: item.id, bytes: Buffer.from(item.bytes) };
  });
}

async function verifyRetainedArtifacts(
  artifacts: { path: string; sha256: string }[],
): Promise<void> {
  for (const artifact of artifacts) {
    let actual: string;
    try {
      actual = sha256(await readFile(fileURLToPath(artifact.path)));
    } catch {
      throw new Error("retained preparation artifact is unreadable");
    }
    if (actual !== artifact.sha256)
      throw new Error("retained preparation artifact changed");
  }
}

function usage(result: HostResult | null) {
  return {
    inputTokens: result?.inputTokens ?? null,
    outputTokens: result?.outputTokens ?? null,
    costUsd: result?.costUsd ?? null,
    complete: result?.usageComplete ?? false,
  };
}

/** Execute resolved evaluator data through an injected host and retain every trial. */
export async function runEvaluation(
  options: EvaluationOptions,
): Promise<{ result: CliResult }> {
  if (
    !isAbsolute(options.projectRoot) ||
    !isAbsolute(options.resultsRoot) ||
    (options.runStateRoot !== undefined && !isAbsolute(options.runStateRoot))
  )
    throw new EvaluationConfigurationError(
      "project, results, and run-state roots must be absolute",
    );
  if (
    !options.case.id ||
    !options.case.prompt ||
    !options.host.id ||
    !options.host.model ||
    !options.host.effort
  )
    throw new EvaluationConfigurationError(
      "case and host identities must be nonempty",
    );
  if (
    options.case.followUpPrompt !== undefined &&
    (typeof options.case.followUpPrompt !== "string" ||
      !options.case.followUpPrompt.trim())
  )
    throw new EvaluationConfigurationError("follow-up prompt must be nonempty");
  if (
    options.case.followUpPrompt !== undefined &&
    !options.host.hostCapabilities?.includes("sevro.host.continuation")
  )
    throw new EvaluationConfigurationError(
      "selected host does not support continuation",
    );
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
  if (
    !options.case.fixture ||
    typeof options.case.fixture !== "object" ||
    Array.isArray(options.case.fixture)
  )
    throw new EvaluationConfigurationError("invalid fixture declaration");
  let generated: GeneratedFixture | null = null;
  let repositoryFixture: RepositoryFixture | null = null;
  if ("kind" in options.case.fixture) {
    try {
      generated = prepareGeneratedFixture(options.case.fixture);
    } catch (error) {
      throw new EvaluationConfigurationError(
        error instanceof Error ? error.message : "invalid generated fixture",
      );
    }
  } else if (Object.hasOwn(options.case.fixture, "sourceRef")) {
    try {
      repositoryFixture = prepareRepositoryFixture({
        kind: "repository",
        ...options.case.fixture,
      });
    } catch (error) {
      throw new EvaluationConfigurationError(
        error instanceof Error ? error.message : "invalid repository fixture",
      );
    }
  } else if (
    !Object.hasOwn(options.case.fixture, "files") ||
    options.case.fixture.files === null ||
    typeof options.case.fixture.files !== "object" ||
    Array.isArray(options.case.fixture.files) ||
    Object.values(options.case.fixture.files).some(
      (content) => typeof content !== "string",
    )
  ) {
    throw new EvaluationConfigurationError(
      "fixture must declare inline files or a repository source",
    );
  }
  if (!Number.isSafeInteger(options.trialCount) || options.trialCount < 1)
    throw new EvaluationConfigurationError(
      "trial count must be a positive integer",
    );
  if (
    !Number.isFinite(options.passThreshold) ||
    options.passThreshold <= 0 ||
    options.passThreshold > 1
  )
    throw new EvaluationConfigurationError(
      "pass threshold must be greater than zero and at most one",
    );
  if (
    new Set(options.case.requiredEvidence).size !==
      options.case.requiredEvidence.length ||
    options.case.requiredEvidence.some(
      (id) => !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(id),
    )
  )
    throw new EvaluationConfigurationError("invalid required evidence IDs");
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
  if (
    replaced.size !== replacedBuiltinGraders.length ||
    replacedBuiltinGraders.some(
      (id) =>
        ![
          ...allBuiltinDeclarations,
          ...allShellDeclarations,
          ...allGitHeadDeclarations,
          ...allSemanticDeclarations,
        ].some((check) => check.grader === id),
    )
  )
    throw new EvaluationConfigurationError(
      "unknown or duplicate built-in grader replacement",
    );
  if (replaced.size && !extensionDeclarations.length)
    throw new EvaluationConfigurationError(
      "built-in grader replacement requires an extension check",
    );
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
  if (semanticDeclarations.length && !options.semanticHost)
    throw new EvaluationConfigurationError(
      "semantic checks require an explicit semantic host",
    );
  if (
    options.semanticHost &&
    (!options.semanticHost.id ||
      !options.semanticHost.model ||
      !options.semanticHost.effort)
  )
    throw new EvaluationConfigurationError(
      "semantic host identity is incomplete",
    );
  if (options.advisoryHost) {
    if (!generated && !options.case.fixture.sourceRef)
      throw new EvaluationConfigurationError(
        "advisory review requires a Git fixture",
      );
    if (
      !options.advisoryHost.id ||
      !options.advisoryHost.model ||
      !options.advisoryHost.effort
    )
      throw new EvaluationConfigurationError(
        "advisory host identity is incomplete",
      );
    try {
      for (const path of options.advisoryExcludedPaths ?? []) {
        fixtureParts(path);
        if (
          path.toLowerCase() === ".git" ||
          path.toLowerCase().startsWith(".git/")
        )
          throw new Error(
            "repository metadata cannot be an advisory exclusion",
          );
      }
    } catch {
      throw new EvaluationConfigurationError("invalid advisory exclusion path");
    }
  } else if (options.advisoryExcludedPaths?.length) {
    throw new EvaluationConfigurationError(
      "advisory exclusions require an advisory host",
    );
  }
  if (shellDeclarations.length && !options.shellIsolation)
    throw new EvaluationConfigurationError(
      "shell checks require explicit protected source roots",
    );
  if (gitHeadDeclarations.length && !generated && !repositoryFixture)
    throw new EvaluationConfigurationError(
      "Git HEAD checks require a Git fixture",
    );
  if (
    new Set(options.case.checks.map((check) => check.id)).size !==
    options.case.checks.length
  )
    throw new EvaluationConfigurationError("case check IDs must be unique");
  if (
    extensionDeclarations.length &&
    (!options.extension ||
      extensionDeclarations.some(
        (check) =>
          !options.extension!.session.identity.graders.includes(check.grader),
      ))
  )
    throw new EvaluationConfigurationError(
      "case declares an unavailable extension grader",
    );
  if (options.extension) {
    const resolved = options.extension.resolvedCase;
    const fixture =
      resolved.fixture.kind === "inline"
        ? { files: resolved.fixture.files }
        : resolved.fixture.kind === "repository"
          ? {
              sourceRef: resolved.fixture.sourceRef,
              ...(resolved.fixture.files
                ? { files: resolved.fixture.files }
                : {}),
              ...(resolved.fixture.staged
                ? { staged: resolved.fixture.staged }
                : {}),
              ...(resolved.fixture.commitFiles ? { commitFiles: true } : {}),
              ...(resolved.fixture.hooks
                ? { hooks: resolved.fixture.hooks }
                : {}),
              ...(resolved.fixture.bin ? { bin: resolved.fixture.bin } : {}),
            }
          : resolved.fixture;
    if (
      hashJson({
        id: resolved.id,
        prompt: resolved.prompt,
        ...(resolved.followUpPrompt !== undefined
          ? { followUpPrompt: resolved.followUpPrompt }
          : {}),
        fixture,
        checks: resolved.checks,
        requiredEvidence: resolved.requiredEvidence,
      }) !==
      hashJson({
        id: options.case.id,
        prompt: options.case.prompt,
        ...(options.case.followUpPrompt !== undefined
          ? { followUpPrompt: options.case.followUpPrompt }
          : {}),
        fixture: options.case.fixture,
        checks: options.case.checks,
        requiredEvidence: options.case.requiredEvidence,
      })
    )
      throw new EvaluationConfigurationError(
        "resolved extension case does not match the selected case",
      );
  }
  let prepared: ReturnType<typeof prepareOutputChecks>;
  let preparedShell: ReturnType<typeof prepareShellChecks>;
  let preparedGitHead: ReturnType<typeof prepareGitHeadChecks>;
  let preparedSemantic: ReturnType<typeof prepareSemanticChecks>;
  try {
    prepared = prepareOutputChecks(allBuiltinDeclarations).filter(
      (check) => !replaced.has(check.grader),
    );
    const allPreparedShell = prepareShellChecks(allShellDeclarations);
    preparedShell = replaced.has("sevro.shell") ? [] : allPreparedShell;
    const allPreparedGitHead = prepareGitHeadChecks(allGitHeadDeclarations);
    preparedGitHead = replaced.has("sevro.git-head") ? [] : allPreparedGitHead;
    const allPreparedSemantic = prepareSemanticChecks(allSemanticDeclarations);
    preparedSemantic = replaced.has("sevro.semantic")
      ? []
      : allPreparedSemantic;
    for (const path of Object.keys(options.case.fixture.files ?? {}))
      fixtureParts(path);
  } catch (error) {
    throw new EvaluationConfigurationError(
      error instanceof Error ? error.message : "invalid case configuration",
    );
  }

  const projectRoot = await realpath(options.projectRoot).catch(() => {
    throw new EvaluationConfigurationError("project root is unreadable");
  });
  const repository = options.case.fixture.sourceRef
    ? await resolveRepositorySource(
        options.case.fixture.sourceRef,
        options.preparationSources,
      ).catch((error) => {
        throw new EvaluationConfigurationError(
          error instanceof Error ? error.message : "invalid repository source",
        );
      })
    : null;
  const [runner, project] = await Promise.all([
    runnerProvenance(
      options.runnerBuildDigest,
      options.runnerCheckoutRoot,
    ).catch((error) => {
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
  let fixtureSetup: FixtureSetup | null;
  try {
    fixtureSetup = prepareFixtureSetup(extensionPreparation?.fixtureSetup);
  } catch (error) {
    throw new EvaluationConfigurationError(
      error instanceof Error ? error.message : "invalid fixture setup",
    );
  }
  if (
    fixtureSetup &&
    !options.extension?.session.identity.capabilities.includes(
      "sevro.fixture.setup",
    )
  )
    throw new EvaluationConfigurationError(
      "fixture setup capability was not negotiated",
    );
  if (fixtureSetup && !generated && !repository)
    throw new EvaluationConfigurationError(
      "fixture setup requires a Git fixture",
    );
  let requestedInstrumentation: InstrumentationRequest[];
  try {
    requestedInstrumentation = prepareInstrumentation(
      extensionPreparation?.requestedInstrumentation ?? [],
      options.host.instrumentation ?? [],
      options.extension?.session.identity.capabilities ?? [],
      options.condition,
    );
  } catch (error) {
    throw new EvaluationConfigurationError(
      error instanceof Error ? error.message : "invalid instrumentation",
    );
  }
  let inlineArtifacts: InlineArtifact[];
  try {
    const fixturePaths = generated
      ? [
          ...new Set([
            ...generated.commits.flatMap((commit) => Object.keys(commit.files)),
            ...Object.keys(generated.files ?? {}),
          ]),
        ]
      : Object.keys(options.case.fixture.files ?? {});
    inlineArtifacts = await prepareArtifacts(
      extensionPreparation?.artifacts ?? [],
      fixturePaths,
      options.preparationSources,
    );
  } catch (error) {
    throw new EvaluationConfigurationError(
      error instanceof Error ? error.message : "invalid preparation artifacts",
    );
  }
  if (
    (repository || generated) &&
    inlineArtifacts.some((artifact) =>
      fixtureParts(artifact.relativePath).some(
        (part) => part.toLowerCase() === ".git",
      ),
    )
  )
    throw new EvaluationConfigurationError(
      "preparation artifacts cannot modify repository metadata",
    );
  if (
    !repository &&
    !generated &&
    inlineArtifacts.some((artifact) => artifact.gitExclude)
  )
    throw new EvaluationConfigurationError(
      "Git-excluded preparation artifacts require a Git fixture",
    );
  if (
    semanticDeclarations.length &&
    inlineArtifacts.some((item) => item.id === "sevro.semantic.verdicts")
  )
    throw new EvaluationConfigurationError(
      "preparation artifact uses a reserved semantic evidence ID",
    );
  const codexMarketplace = extensionPreparation?.codexMarketplace;
  const claudePluginDirs = extensionPreparation?.claudePluginDirs;
  if (claudePluginDirs) {
    const roots = claudePluginDirs.artifactRoots;
    try {
      if (
        !Array.isArray(roots) ||
        !roots.length ||
        new Set(roots).size !== roots.length
      )
        throw new Error("invalid plugin roots");
      for (const root of roots) fixtureParts(root);
      if (
        roots.some((root) =>
          roots.some((other) => root !== other && root.startsWith(`${other}/`)),
        )
      )
        throw new Error("overlapping plugin roots");
    } catch {
      throw new EvaluationConfigurationError(
        "invalid Claude plugin directory declaration",
      );
    }
    if (
      !options.extension?.session.identity.capabilities.includes(
        "sevro.claude.plugin-dirs",
      ) ||
      !options.host.hostCapabilities?.includes("sevro.claude.plugin-dirs")
    )
      throw new EvaluationConfigurationError(
        "Claude plugin directory capability was not negotiated",
      );
    for (const root of roots) {
      const files = inlineArtifacts.filter((artifact) =>
        artifact.relativePath.startsWith(`${root}/`),
      );
      if (
        !files.length ||
        !files.every((artifact) => artifact.gitExclude) ||
        !files.some(
          (artifact) =>
            artifact.relativePath === `${root}/.claude-plugin/plugin.json`,
        )
      )
        throw new EvaluationConfigurationError(
          "Claude plugin directory requires Git-excluded package artifacts and a manifest",
        );
    }
  }
  if (codexMarketplace) {
    const { artifactRoot, marketplaceName, pluginNames } = codexMarketplace;
    try {
      fixtureParts(artifactRoot);
      if (
        !/^[a-z][a-z0-9-]*$/.test(marketplaceName) ||
        !pluginNames.length ||
        pluginNames.some((name) => !/^[a-z][a-z0-9-]*$/.test(name)) ||
        new Set(pluginNames).size !== pluginNames.length
      )
        throw new Error("invalid marketplace or plugin name");
    } catch {
      throw new EvaluationConfigurationError(
        "invalid Codex marketplace declaration",
      );
    }
    if (
      !options.extension?.session.identity.capabilities.includes(
        "sevro.codex.plugin-marketplace",
      ) ||
      !options.host.hostCapabilities?.includes("sevro.codex.plugin-marketplace")
    )
      throw new EvaluationConfigurationError(
        "Codex marketplace capability was not negotiated",
      );
    const packageArtifacts = inlineArtifacts.filter((artifact) =>
      artifact.relativePath.startsWith(`${artifactRoot}/`),
    );
    if (
      !packageArtifacts.length ||
      !packageArtifacts.every((artifact) => artifact.gitExclude) ||
      !packageArtifacts.some(
        (artifact) =>
          artifact.relativePath ===
          `${artifactRoot}/.claude-plugin/marketplace.json`,
      )
    )
      throw new EvaluationConfigurationError(
        "Codex marketplace requires Git-excluded package artifacts and a manifest",
      );
  }
  const codexSkillInvocation = extensionPreparation?.codexSkillInvocation;
  const codexRepositorySkillInvocation =
    extensionPreparation?.codexRepositorySkillInvocation;
  const claudeSkillInvocation = extensionPreparation?.claudeSkillInvocation;
  const claudeRepositorySkillInvocation =
    extensionPreparation?.claudeRepositorySkillInvocation;
  const invocationPlaceholder = "{{sevro.skill_invocation}}";
  const legacyCodexPlaceholder = "{{sevro.codex.skill_invocation}}";
  const repositoryInvocation =
    codexRepositorySkillInvocation ?? claudeRepositorySkillInvocation;
  const invocation = repositoryInvocation
    ? { ...repositoryInvocation, scope: "repository" as const }
    : (codexSkillInvocation ?? claudeSkillInvocation);
  const invocationToken = codexRepositorySkillInvocation
    ? `$${codexRepositorySkillInvocation.skillName}`
    : claudeRepositorySkillInvocation
      ? `/${claudeRepositorySkillInvocation.skillName}`
      : codexSkillInvocation
        ? `$${codexSkillInvocation.pluginName}:${codexSkillInvocation.skillName}`
        : claudeSkillInvocation
          ? `/${claudeSkillInvocation.pluginName}:${claudeSkillInvocation.skillName}`
          : null;
  const placeholderCount =
    options.case.prompt.split(invocationPlaceholder).length -
    1 +
    (options.case.followUpPrompt?.split(invocationPlaceholder).length ?? 1) -
    1 +
    options.case.prompt.split(legacyCodexPlaceholder).length -
    1 +
    (options.case.followUpPrompt?.split(legacyCodexPlaceholder).length ?? 1) -
    1;
  if (
    [
      codexSkillInvocation,
      codexRepositorySkillInvocation,
      claudeSkillInvocation,
      claudeRepositorySkillInvocation,
    ].filter(Boolean).length > 1
  )
    throw new EvaluationConfigurationError(
      "only one explicit skill invocation may be declared",
    );
  if (codexSkillInvocation) {
    const { pluginName, skillName } = codexSkillInvocation;
    if (
      !codexMarketplace ||
      !codexMarketplace.pluginNames.includes(pluginName) ||
      !/^[a-z][a-z0-9-]*$/.test(pluginName) ||
      !/^[A-Za-z0-9._-]+$/.test(skillName) ||
      placeholderCount !== 1 ||
      !inlineArtifacts.some(
        (artifact) =>
          artifact.relativePath ===
          `${codexMarketplace.artifactRoot}/plugin/skills/${skillName}/SKILL.md`,
      )
    )
      throw new EvaluationConfigurationError(
        "invalid Codex skill invocation declaration",
      );
    if (
      !options.extension?.session.identity.capabilities.includes(
        "sevro.codex.explicit-invocation",
      ) ||
      !options.host.hostCapabilities?.includes(
        "sevro.codex.explicit-invocation",
      )
    )
      throw new EvaluationConfigurationError(
        "Codex explicit invocation capability was not negotiated",
      );
  } else if (codexRepositorySkillInvocation) {
    const { skillName } = codexRepositorySkillInvocation;
    if (
      !/^[A-Za-z0-9._-]+$/.test(skillName) ||
      skillName === "." ||
      skillName === ".." ||
      placeholderCount !== 1 ||
      !inlineArtifacts.some(
        (artifact) =>
          artifact.gitExclude &&
          artifact.relativePath === `.agents/skills/${skillName}/SKILL.md`,
      )
    )
      throw new EvaluationConfigurationError(
        "invalid Codex repository skill invocation declaration",
      );
    if (
      !options.extension?.session.identity.capabilities.includes(
        "sevro.codex.repository-invocation",
      ) ||
      !options.host.hostCapabilities?.includes(
        "sevro.codex.repository-invocation",
      )
    )
      throw new EvaluationConfigurationError(
        "Codex repository invocation capability was not negotiated",
      );
  } else if (claudeRepositorySkillInvocation) {
    const { skillName } = claudeRepositorySkillInvocation;
    if (
      !/^[A-Za-z0-9._-]+$/.test(skillName) ||
      skillName === "." ||
      skillName === ".." ||
      placeholderCount !== 1 ||
      !options.case.prompt.startsWith(invocationPlaceholder) ||
      options.case.prompt.includes(legacyCodexPlaceholder) ||
      !inlineArtifacts.some(
        (artifact) =>
          artifact.gitExclude &&
          artifact.relativePath === `.claude/skills/${skillName}/SKILL.md`,
      )
    )
      throw new EvaluationConfigurationError(
        "invalid Claude repository skill invocation declaration",
      );
    if (
      !options.extension?.session.identity.capabilities.includes(
        "sevro.claude.repository-invocation",
      ) ||
      !options.host.hostCapabilities?.includes(
        "sevro.claude.repository-invocation",
      )
    )
      throw new EvaluationConfigurationError(
        "Claude repository invocation capability was not negotiated",
      );
  } else if (claudeSkillInvocation) {
    const { pluginName, skillName } = claudeSkillInvocation;
    if (
      !claudePluginDirs ||
      !/^[a-z][a-z0-9-]*$/.test(pluginName) ||
      !/^[A-Za-z0-9._-]+$/.test(skillName) ||
      placeholderCount !== 1 ||
      options.case.prompt.includes(legacyCodexPlaceholder) ||
      options.case.followUpPrompt?.includes(legacyCodexPlaceholder) ||
      !claudePluginDirs.artifactRoots.some((root) =>
        inlineArtifacts.some(
          (artifact) =>
            artifact.relativePath === `${root}/skills/${skillName}/SKILL.md`,
        ),
      )
    )
      throw new EvaluationConfigurationError(
        "invalid Claude skill invocation declaration",
      );
    if (
      !options.extension?.session.identity.capabilities.includes(
        "sevro.claude.explicit-invocation",
      ) ||
      !options.host.hostCapabilities?.includes(
        "sevro.claude.explicit-invocation",
      )
    )
      throw new EvaluationConfigurationError(
        "Claude explicit invocation capability was not negotiated",
      );
  } else if (placeholderCount)
    throw new EvaluationConfigurationError(
      "skill invocation placeholder requires a declaration",
    );
  const extensionData = options.extension
    ? {
        ...options.extension.resolvedCase.extensionData,
        ...extensionPreparation?.extensionData,
      }
    : {};
  const runId = randomUUID();
  const route = {
    role: "candidate",
    host: options.host.id,
    model: options.host.model,
    effort: options.host.effort,
  };
  const routes = [
    route,
    ...(preparedSemantic.length
      ? [
          {
            role: "semantic" as const,
            host: options.semanticHost!.id,
            model: options.semanticHost!.model,
            effort: options.semanticHost!.effort,
          },
        ]
      : []),
    ...(options.advisoryHost
      ? [
          {
            role: "advisory" as const,
            host: options.advisoryHost.id,
            model: options.advisoryHost.model,
            effort: options.advisoryHost.effort,
          },
        ]
      : []),
  ];
  const redactedConfig = {
    condition: options.condition,
    executionMode: options.dry ? "dry" : "executed",
    trialCount: options.trialCount,
    passThreshold: options.passThreshold,
    extensionConfigurationDigest:
      options.extension?.session.identity.configurationDigest ?? null,
    ...(fixtureSetup ? { fixtureSetupDigest: hashJson(fixtureSetup) } : {}),
    ...(codexMarketplace ? { codexMarketplace } : {}),
    ...(claudePluginDirs ? { claudePluginDirs } : {}),
    ...(codexSkillInvocation ? { codexSkillInvocation } : {}),
    ...(codexRepositorySkillInvocation
      ? { codexRepositorySkillInvocation }
      : {}),
    ...(claudeSkillInvocation ? { claudeSkillInvocation } : {}),
    ...(claudeRepositorySkillInvocation
      ? { claudeRepositorySkillInvocation }
      : {}),
    ...(options.advisoryHost
      ? {
          advisoryExcludedPaths: [
            ...(options.advisoryExcludedPaths ?? []),
          ].sort(),
        }
      : {}),
  };
  const activeGraders: {
    id: string;
    source: "builtin" | "extension";
    version: string;
  }[] = [
    ...new Set(
      [
        ...builtinDeclarations,
        ...shellDeclarations,
        ...gitHeadDeclarations,
        ...semanticDeclarations,
      ].map((check) => check.grader),
    ),
  ]
    .sort()
    .map((id) => ({ id, source: "builtin", version: "1.0.0" }));
  if (options.extension) {
    for (const id of [
      ...new Set(extensionDeclarations.map((check) => check.grader)),
    ].sort())
      activeGraders.push({
        id,
        source: "extension",
        version: options.extension.session.identity.version,
      });
  }
  let evaluationIdentity: ReturnType<typeof createEvaluationIdentity>;
  try {
    evaluationIdentity = createEvaluationIdentity({
      runnerBuildDigest: options.runnerBuildDigest,
      projectDigest: options.projectDigest,
      configurationDigest: hashJson(redactedConfig),
      extensionDigest: options.extension?.session.identity.sourceDigest ?? null,
      extensionProtocol: options.extension?.session.identity.protocol ?? null,
      caseDigest: hashJson({
        id: options.case.id,
        prompt: options.case.prompt,
        ...(options.case.followUpPrompt !== undefined
          ? { followUpPrompt: options.case.followUpPrompt }
          : {}),
        extensionData,
      }),
      fixtureDigest: hashJson({
        ...(generated
          ? generated
          : repository
            ? {
                ...repositoryFixture,
                revision: repository.revision,
              }
            : { files: options.case.fixture.files }),
        artifacts: inlineArtifacts.map(
          ({ id, relativePath, sha256, gitExclude, executable }) => ({
            id,
            relativePath,
            sha256,
            ...(gitExclude ? { gitExclude: true } : {}),
            ...(executable ? { executable: true } : {}),
          }),
        ),
        ...(fixtureSetup ? { fixtureSetup } : {}),
        ...(codexMarketplace ? { codexMarketplace } : {}),
        ...(claudePluginDirs ? { claudePluginDirs } : {}),
        ...(codexSkillInvocation ? { codexSkillInvocation } : {}),
        ...(codexRepositorySkillInvocation
          ? { codexRepositorySkillInvocation }
          : {}),
        ...(claudeSkillInvocation ? { claudeSkillInvocation } : {}),
        ...(claudeRepositorySkillInvocation
          ? { claudeRepositorySkillInvocation }
          : {}),
      }),
      checksDigest: hashJson(options.case.checks),
      requiredEvidenceDigest: hashJson(options.case.requiredEvidence),
      evaluatorDigest: hashJson({
        policy: "sevro.builtin-output.v1",
        extension: options.extension?.session.identity ?? null,
        extensionData,
      }),
      graderDigest: hashJson(activeGraders),
      instrumentationDigest: hashJson({
        requested: requestedInstrumentation,
        applied: requestedInstrumentation,
      }),
      routeDigest: hashJson(routes.length > 1 ? routes : route),
      condition: options.condition,
      trialCount: options.trialCount,
      passThreshold: options.passThreshold,
    });
  } catch {
    throw new EvaluationConfigurationError(
      "invalid evaluation identity inputs",
    );
  }

  await mkdir(options.resultsRoot, { recursive: true, mode: 0o700 });
  const runDir = resolve(await realpath(options.resultsRoot), runId);
  await mkdir(runDir, { mode: 0o700 });
  const runStateRoot = options.runStateRoot ?? options.resultsRoot;
  await mkdir(runStateRoot, { recursive: true, mode: 0o700 });
  const stateRoot = await realpath(runStateRoot);
  const stateDir = join(stateRoot, runId);
  if (stateDir !== runDir) await mkdir(stateDir, { mode: 0o700 });
  const activePath = join(stateRoot, "active", `${runId}.json`);
  const checkpointPath = join(stateDir, "checkpoint.json");
  const evidencePath = join(runDir, "run.json");
  const trialSummaries: TrialSummary[] = [];
  let owner: ReturnType<typeof startRunOwner>;
  try {
    owner = startRunOwner({
      stateRoot,
      evaluationDigest: evaluationIdentity.digest,
      attemptId: runId,
      activeRunPath: activePath,
      checkpointPath,
      evidenceDirectory: stateDir,
      artifactPath: evidencePath,
    });
  } catch (error) {
    await rm(runDir, { recursive: true, force: true });
    if (stateDir !== runDir)
      await rm(stateDir, { recursive: true, force: true });
    throw error;
  }
  try {
    const artifactRefs: {
      id: string;
      path: string;
      sha256: string;
      gitExclude?: boolean;
      executable?: boolean;
    }[] = [];
    for (const artifact of inlineArtifacts) {
      const retainedPath = join(
        runDir,
        "prepared",
        ...fixtureParts(artifact.relativePath),
      );
      await mkdir(dirname(retainedPath), { recursive: true, mode: 0o700 });
      await writeFile(retainedPath, artifact.bytes, {
        flag: "wx",
        mode: artifact.executable ? 0o700 : 0o600,
      });
      artifactRefs.push({
        id: artifact.id,
        path: pathToFileURL(retainedPath).href,
        sha256: artifact.sha256,
        ...(artifact.gitExclude ? { gitExclude: true } : {}),
        ...(artifact.executable ? { executable: true } : {}),
      });
    }

    const trialEvidence: Record<string, unknown>[] = [];
    function saveState(status: "active" | "complete" | "interrupted"): void {
      const completedTrials = trialSummaries.map((trial) => ({
        trial: trial.trial,
        artifactPath: trial.artifactPath,
      }));
      checkpointRunOwner(owner, completedTrials, status);
    }
    let diagnostic: { code: string; message: string } | undefined;
    for (let trial = 1; trial <= options.trialCount; trial++) {
      const workspace = await createFixture(
        options.case.fixture,
        inlineArtifacts,
        options.preparationSources,
        repository,
        repositoryFixture,
        generated,
        fixtureSetup,
        projectRoot,
        options.signal,
      );
      const fixtureBinDir = (await fixtureBinDirectory(workspace)) ?? undefined;
      const trialPrompt = options.case.prompt
        .replaceAll("{{sevro.workspace}}", workspace)
        .replaceAll(
          invocationPlaceholder,
          invocationToken ?? invocationPlaceholder,
        )
        .replaceAll(
          legacyCodexPlaceholder,
          invocationToken ?? legacyCodexPlaceholder,
        );
      const trialFollowUpPrompt = options.case.followUpPrompt
        ?.replaceAll("{{sevro.workspace}}", workspace)
        .replaceAll(
          invocationPlaceholder,
          invocationToken ?? invocationPlaceholder,
        )
        .replaceAll(
          legacyCodexPlaceholder,
          invocationToken ?? legacyCodexPlaceholder,
        );
      let persisted = false;
      try {
        const gitHeadBase = preparedGitHead.length
          ? await gitHeadRevision(workspace, options.signal)
          : null;
        const advisoryRevision = options.advisoryHost
          ? await advisoryBaseRevision(workspace)
          : null;
        let hostResult: HostResult | null = null;
        let appliedInstrumentation: InstrumentationRequest[] = [];
        let additionalObservations: ReturnType<typeof hostObservations> = [];
        let producedArtifacts: ReturnType<typeof hostArtifacts> = [];
        let execution: "completed" | "failed" | "cancelled" | "not_run" =
          options.dry ? "not_run" : "completed";
        let candidateDurationMs: number | null = null;
        if (!options.dry) {
          const candidateStarted = performance.now();
          try {
            if (options.signal?.aborted) throw new Error("cancelled");
            hostResult = await options.host.run({
              prompt: trialPrompt,
              ...(trialFollowUpPrompt !== undefined
                ? { followUpPrompt: trialFollowUpPrompt }
                : {}),
              workspace,
              condition: options.condition,
              fixtureBinDir,
              instrumentation: requestedInstrumentation,
              ...(codexMarketplace
                ? {
                    codexMarketplace: {
                      ...codexMarketplace,
                      artifactPaths: inlineArtifacts
                        .filter((artifact) =>
                          artifact.relativePath.startsWith(
                            `${codexMarketplace.artifactRoot}/`,
                          ),
                        )
                        .map((artifact) => artifact.relativePath),
                    },
                  }
                : {}),
              ...(claudePluginDirs
                ? {
                    claudePluginDirs: {
                      ...claudePluginDirs,
                      artifactPaths: inlineArtifacts
                        .filter((artifact) =>
                          claudePluginDirs.artifactRoots.some((root) =>
                            artifact.relativePath.startsWith(`${root}/`),
                          ),
                        )
                        .map((artifact) => artifact.relativePath),
                    },
                  }
                : {}),
              ...(invocation
                ? {
                    explicitSkillInvocation: {
                      ...invocation,
                      token: invocationToken!,
                    },
                  }
                : {}),
              signal: options.signal,
            });
            if (options.signal?.aborted) throw new Error("cancelled");
            appliedInstrumentation = verifyAppliedInstrumentation(
              requestedInstrumentation,
              hostResult.appliedInstrumentation,
              options.condition,
              hostResult.actualCondition,
            );
            if (
              hostResult.finalMessage !== null &&
              Buffer.byteLength(hostResult.finalMessage, "utf8") >
                MAX_FINAL_MESSAGE_BYTES
            )
              throw new Error("oversized host result");
            additionalObservations = hostObservations(
              hostResult,
              options.host.id,
              new Set([
                ...artifactRefs.map((item) => item.id),
                ...options.case.checks.map((item) => item.id),
              ]),
            );
            producedArtifacts = hostArtifacts(
              hostResult,
              new Set([
                "sevro.observation.final-message",
                ...artifactRefs.map((item) => item.id),
                ...additionalObservations.map((item) => item.id),
                ...options.case.checks.map((item) => item.id),
                ...preparedShell.map(
                  (item) => `sevro.observation.shell.${item.id}`,
                ),
                ...(preparedGitHead.length
                  ? ["sevro.observation.git-head"]
                  : []),
                ...(preparedSemantic.length ? ["sevro.semantic.verdicts"] : []),
              ]),
            );
            if (hostResult.executionFailed) {
              execution = "failed";
              diagnostic = {
                code: "sevro.host.failed",
                message: "host execution did not complete",
              };
            }
          } catch (error) {
            execution = options.signal?.aborted ? "cancelled" : "failed";
            hostResult = null;
            diagnostic = {
              code:
                execution === "cancelled"
                  ? "sevro.run.cancelled"
                  : error instanceof InstrumentationEvidenceError
                    ? "sevro.instrumentation.mismatch"
                    : "sevro.host.failed",
              message:
                execution === "cancelled"
                  ? "run cancelled"
                  : error instanceof InstrumentationEvidenceError
                    ? error.message
                    : "host execution did not complete",
            };
          } finally {
            candidateDurationMs = Math.max(
              0,
              performance.now() - candidateStarted,
            );
          }
        }
        const trialArtifactRefs = [...artifactRefs];
        for (const artifact of producedArtifacts) {
          const path = join(runDir, `trial-${trial}-host-${artifact.id}.bin`);
          try {
            await writeFile(path, artifact.bytes, { flag: "wx", mode: 0o600 });
          } catch {
            throw new Error(
              `trial persistence failed; fixture retained at ${workspace}`,
            );
          }
          trialArtifactRefs.push({
            id: artifact.id,
            path: pathToFileURL(path).href,
            sha256: sha256(artifact.bytes),
          });
        }
        await verifyRetainedArtifacts(trialArtifactRefs);
        const rawDigest =
          hostResult?.finalMessage == null
            ? null
            : sha256(hostResult.finalMessage);
        const completeness =
          hostResult?.finalMessage == null
            ? "unavailable"
            : hostResult.complete
              ? "complete"
              : "partial";
        const observation = {
          id: "sevro.observation.final-message",
          source: options.host.id,
          completeness,
          data: rawDigest
            ? {
                sha256: rawDigest,
                byteLength: Buffer.byteLength(
                  hostResult!.finalMessage!,
                  "utf8",
                ),
              }
            : {},
        };
        const shellObservations: {
          id: string;
          source: string;
          completeness: "complete";
          data: Record<string, unknown>;
        }[] = [];
        const gitHeadObservations: {
          id: string;
          source: string;
          completeness: "complete";
          data: Record<string, unknown>;
        }[] = [];
        const semanticObservations: {
          id: string;
          source: string;
          completeness: "complete" | "partial";
          data: Record<string, unknown>;
        }[] = [];
        let checks: CheckOutcome[] = [];
        let extensionMetrics: {
          id: string;
          value: number | null;
          unit: string;
        }[] = [];
        let domainOutcomes: NonNullable<EvaluationResult["domainOutcomes"]> =
          [];
        let taskPolicyRecommendation:
          "passed" | "failed" | "not_assessed" | null = null;
        let graderError = false;
        if (execution === "completed") {
          try {
            checks = gradeOutput(
              hostResult!.finalMessage,
              hostResult!.complete,
              prepared,
            ).map((check) => ({
              ...check,
              evidenceRefs: rawDigest ? [observation.id] : [],
            }));
          } catch {
            graderError = true;
            diagnostic = {
              code: "sevro.grader.error",
              message: "output grading did not complete",
            };
          }
        }
        if (execution === "completed" && !graderError && preparedShell.length) {
          try {
            const protectedRoots = await evaluationProtectedRoots({
              workspace,
              projectRoot,
              resultsRoot: options.resultsRoot,
              additionalRoots: [
                ...options.shellIsolation!.protectedRoots,
                ...(options.preparationSources
                  ? [options.preparationSources.root]
                  : []),
                runStateRoot,
              ],
            });
            for (const check of preparedShell) {
              const shellResult = await runShellCheck(check, {
                workspace,
                fixtureBinDir,
                toolchainBinDir: options.shellIsolation?.toolchainBinDir,
                uvRuntimeCache: options.shellIsolation?.uvRuntimeCache,
                protectedRoots,
                protectedRootsCanonical: true,
                privateStateRoot: join(stateDir, "shell-sandbox"),
                signal: options.signal,
              });
              const graded = assessShellCheck(check, shellResult);
              const observationId = `sevro.observation.shell.${check.id}`;
              shellObservations.push({
                id: observationId,
                source: "sevro.shell",
                completeness: "complete",
                data: {
                  exitCode: shellResult.exitCode,
                  expectedExitCode: check.expectedExitCode,
                  ...(shellResult.stdout === null
                    ? {}
                    : {
                        stdoutSha256: sha256(shellResult.stdout),
                        stdoutByteLength: Buffer.byteLength(
                          shellResult.stdout,
                          "utf8",
                        ),
                      }),
                },
              });
              checks.push({
                id: check.id,
                grader: "sevro.shell",
                status: graded.passed ? "passed" : "failed",
                detail: graded.detail,
                evidenceRefs: [observationId],
              });
            }
          } catch {
            if (options.signal?.aborted) {
              execution = "cancelled";
              diagnostic = {
                code: "sevro.run.cancelled",
                message: "run cancelled",
              };
            } else {
              graderError = true;
              diagnostic = {
                code: "sevro.grader.error",
                message: "shell grading did not complete",
              };
            }
          }
        }
        if (
          execution === "completed" &&
          !graderError &&
          preparedGitHead.length
        ) {
          try {
            const state = await gitHeadState(
              workspace,
              gitHeadBase!,
              options.signal,
            );
            const observationId = "sevro.observation.git-head";
            gitHeadObservations.push({
              id: observationId,
              source: "sevro.git-head",
              completeness: "complete",
              data: {
                baseRevision: gitHeadBase,
                currentRevision: state.currentRevision,
                baseAncestor: state.baseAncestor,
              },
            });
            checks.push(
              ...preparedGitHead.map((check) => {
                const graded = assessGitHeadCheck(check, gitHeadBase!, state);
                return {
                  id: check.id,
                  grader: "sevro.git-head",
                  status: graded.passed
                    ? ("passed" as const)
                    : ("failed" as const),
                  detail: graded.detail,
                  evidenceRefs: [observationId],
                };
              }),
            );
          } catch {
            if (options.signal?.aborted) {
              execution = "cancelled";
              diagnostic = {
                code: "sevro.run.cancelled",
                message: "run cancelled",
              };
            } else {
              graderError = true;
              diagnostic = {
                code: "sevro.grader.error",
                message: "Git HEAD grading did not complete",
              };
            }
          }
        }
        if (
          execution === "completed" &&
          !graderError &&
          preparedSemantic.length
        ) {
          if (hostResult?.finalMessage == null || !hostResult.complete) {
            checks.push(
              ...preparedSemantic.map((check) => ({
                id: check.id,
                grader: "sevro.semantic",
                status: "unavailable" as const,
                evidenceRefs: [],
              })),
            );
          } else {
            const semanticWorkspace = await createFixture(
              { files: {} },
              [],
              undefined,
              null,
              null,
              null,
              null,
              projectRoot,
            );
            let semanticResult: HostResult | null = null;
            let semanticArtifacts: ReturnType<typeof hostArtifacts> = [];
            try {
              const response = await options.semanticHost!.run({
                prompt: semanticPrompt(
                  hostResult.finalMessage,
                  preparedSemantic,
                ),
                workspace: semanticWorkspace,
                condition: "passive",
                signal: options.signal,
              });
              semanticArtifacts = hostArtifacts(
                {
                  ...response,
                  artifacts: response.artifacts?.map((item) => ({
                    ...item,
                    id: `sevro.semantic.${item.id}`,
                  })),
                },
                new Set([
                  ...trialArtifactRefs.map((item) => item.id),
                  ...options.case.checks.map((item) => item.id),
                  "sevro.semantic.verdicts",
                ]),
              );
              semanticResult = response;
            } catch {
              if (options.signal?.aborted) {
                execution = "cancelled";
                diagnostic = {
                  code: "sevro.run.cancelled",
                  message: "run cancelled",
                };
              } else {
                graderError = true;
                diagnostic = {
                  code: "sevro.grader.error",
                  message: "semantic grading did not complete",
                };
              }
            } finally {
              await rm(semanticWorkspace, { recursive: true, force: true });
            }
            if (semanticResult) {
              for (const artifact of semanticArtifacts) {
                const path = join(runDir, `trial-${trial}-${artifact.id}.bin`);
                try {
                  await writeFile(path, artifact.bytes, {
                    flag: "wx",
                    mode: 0o600,
                  });
                } catch {
                  throw new Error(
                    `trial persistence failed; fixture retained at ${workspace}`,
                  );
                }
                trialArtifactRefs.push({
                  id: artifact.id,
                  path: pathToFileURL(path).href,
                  sha256: sha256(artifact.bytes),
                });
              }
              semanticObservations.push({
                id: "sevro.observation.semantic.usage",
                source: options.semanticHost!.id,
                completeness: semanticResult.usageComplete
                  ? "complete"
                  : "partial",
                data: usage(semanticResult),
              });
              if (
                semanticResult.finalMessage !== null &&
                Buffer.byteLength(semanticResult.finalMessage, "utf8") <=
                  1024 * 1024
              ) {
                const bytes = Buffer.from(semanticResult.finalMessage, "utf8");
                const path = join(
                  runDir,
                  `trial-${trial}-semantic-verdicts.json`,
                );
                try {
                  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
                } catch {
                  throw new Error(
                    `trial persistence failed; fixture retained at ${workspace}`,
                  );
                }
                trialArtifactRefs.push({
                  id: "sevro.semantic.verdicts",
                  path: pathToFileURL(path).href,
                  sha256: sha256(bytes),
                });
              }
              try {
                if (!semanticResult.complete || !semanticResult.finalMessage)
                  throw new Error("semantic grader result is incomplete");
                const verdicts = parseSemanticVerdicts(
                  semanticResult.finalMessage,
                  preparedSemantic,
                );
                for (const verdict of verdicts) {
                  const observationId = `sevro.observation.semantic.${sha256(verdict.id)}`;
                  semanticObservations.push({
                    id: observationId,
                    source: options.semanticHost!.id,
                    completeness: "complete",
                    data: { verdict: verdict.verdict, reason: verdict.reason },
                  });
                  checks.push({
                    id: verdict.id,
                    grader: "sevro.semantic",
                    status: verdict.verdict === "pass" ? "passed" : "failed",
                    detail: verdict.reason,
                    evidenceRefs: [observationId],
                  });
                }
              } catch {
                graderError = true;
                diagnostic = {
                  code: "sevro.grader.error",
                  message: "semantic grading did not complete",
                };
              }
            }
          }
        }
        if (options.extension && !graderError && execution === "completed") {
          try {
            const extensionResult = await options.extension.session.evaluate({
              caseId: options.case.id,
              execution: { status: execution },
              observations: [
                {
                  ...observation,
                  completeness,
                  data: {
                    ...observation.data,
                    ...(hostResult?.finalMessage == null
                      ? {}
                      : { text: hostResult.finalMessage }),
                  },
                },
                ...shellObservations,
                ...gitHeadObservations,
                ...semanticObservations,
                ...additionalObservations,
              ],
              builtinChecks: checks.map((check) => ({
                id: check.id,
                status: check.status,
                ...(check.detail ? { detail: check.detail } : {}),
                evidenceRefs: check.evidenceRefs ?? [],
              })),
              artifacts: trialArtifactRefs,
              extensionData,
            });
            const declared = new Map(
              extensionDeclarations.map((check) => [check.id, check.grader]),
            );
            if (extensionResult.checks.some((check) => !declared.has(check.id)))
              throw new Error("extension returned an undeclared check");
            checks.push(
              ...extensionResult.checks.map((check) => ({
                id: check.id,
                grader: declared.get(check.id)!,
                status: check.status,
                ...(check.detail ? { detail: check.detail } : {}),
                evidenceRefs: check.evidenceRefs,
              })),
            );
            extensionMetrics = extensionResult.metrics;
            domainOutcomes = extensionResult.domainOutcomes ?? [];
            taskPolicyRecommendation =
              extensionResult.taskVerdictRecommendation ?? null;
          } catch {
            if (options.signal?.aborted) {
              execution = "cancelled";
              diagnostic = {
                code: "sevro.run.cancelled",
                message: "run cancelled",
              };
            } else {
              graderError = true;
              diagnostic = {
                code: "sevro.grader.error",
                message: "extension grading did not complete",
              };
            }
          }
        }
        const declaredOrder = new Map(
          options.case.checks.map((check, index) => [check.id, index]),
        );
        checks.sort(
          (left, right) =>
            declaredOrder.get(left.id)! - declaredOrder.get(right.id)!,
        );
        const defaultAssessment = assessTrial({
          execution,
          declaredChecks: options.case.checks
            .filter((check) => !replaced.has(check.grader))
            .map((check) => check.id),
          checks,
          graderError,
          requiredEvidenceUnavailable: options.case.requiredEvidence.some(
            (id) =>
              !producedArtifacts.some((item) => item.id === id) &&
              ![
                observation,
                ...shellObservations,
                ...gitHeadObservations,
                ...semanticObservations,
                ...additionalObservations,
              ].some(
                (item) => item.id === id && item.completeness === "complete",
              ),
          ),
        });
        const assessment = applyTaskVerdictPolicy(
          defaultAssessment,
          taskPolicyRecommendation,
          Boolean(
            options.extension?.session.identity.selectedTaskVerdictPolicy,
          ),
        );
        let advisoryReview: {
          status: "completed" | "failed" | "not_run";
          assessment: AdvisoryAssessment | null;
          usage: ReturnType<typeof usage>;
          rawResult: {
            source: string;
            path: string | null;
            sha256: string | null;
          };
        } | null = null;
        if (options.advisoryHost) {
          advisoryReview = {
            status: "not_run",
            assessment: null,
            usage: usage(null),
            rawResult: {
              source: options.advisoryHost.id,
              path: null,
              sha256: null,
            },
          };
          if (execution === "completed" && !options.signal?.aborted) {
            let reviewWorkspace: string | null = null;
            try {
              reviewWorkspace = await buildBlindAdvisoryFixture(workspace, {
                baseRevision: advisoryRevision!,
                excludedPaths: options.advisoryExcludedPaths,
              });
              const response = await options.advisoryHost.run({
                prompt: advisoryPrompt(trialPrompt, checks),
                workspace: reviewWorkspace,
                condition: "passive",
                signal: options.signal,
              });
              advisoryReview.usage = usage(response);
              const reviewArtifacts = hostArtifacts(
                {
                  ...response,
                  artifacts: response.artifacts?.map((item) => ({
                    ...item,
                    id: `sevro.advisory.${item.id}`,
                  })),
                },
                new Set([
                  ...trialArtifactRefs.map((item) => item.id),
                  ...options.case.checks.map((item) => item.id),
                  "sevro.advisory.response",
                ]),
              );
              for (const artifact of reviewArtifacts) {
                const path = join(runDir, `trial-${trial}-${artifact.id}.bin`);
                try {
                  await writeFile(path, artifact.bytes, {
                    flag: "wx",
                    mode: 0o600,
                  });
                } catch {
                  throw new Error(
                    `trial persistence failed; fixture retained at ${workspace}`,
                  );
                }
                trialArtifactRefs.push({
                  id: artifact.id,
                  path: pathToFileURL(path).href,
                  sha256: sha256(artifact.bytes),
                });
              }
              if (
                response.finalMessage !== null &&
                Buffer.byteLength(response.finalMessage, "utf8") <= 64 * 1024
              ) {
                const path = join(runDir, `trial-${trial}-advisory.json`);
                try {
                  await writeFile(path, response.finalMessage, {
                    flag: "wx",
                    mode: 0o600,
                  });
                } catch {
                  throw new Error(
                    `trial persistence failed; fixture retained at ${workspace}`,
                  );
                }
                advisoryReview.rawResult = {
                  source: options.advisoryHost.id,
                  path: pathToFileURL(path).href,
                  sha256: sha256(response.finalMessage),
                };
                trialArtifactRefs.push({
                  id: "sevro.advisory.response",
                  path: pathToFileURL(path).href,
                  sha256: sha256(response.finalMessage),
                });
              }
              if (!response.complete || response.finalMessage === null)
                throw new Error("advisory response is incomplete");
              advisoryReview.assessment = parseAdvisoryAssessment(
                response.finalMessage,
              );
              advisoryReview.status = "completed";
            } catch (error) {
              if (
                error instanceof Error &&
                error.message.startsWith("trial persistence failed")
              )
                throw error;
              advisoryReview.status = "failed";
            } finally {
              if (reviewWorkspace) {
                try {
                  await rm(reviewWorkspace, { recursive: true, force: true });
                } catch {
                  console.warn(
                    `advisory fixture cleanup failed; retained at ${reviewWorkspace}`,
                  );
                }
              }
            }
          }
        }
        await verifyRetainedArtifacts(trialArtifactRefs);
        const rawPath =
          hostResult?.finalMessage !== null &&
          hostResult?.finalMessage !== undefined
            ? join(runDir, `trial-${trial}-raw.txt`)
            : null;
        if (rawPath) {
          try {
            await writeFile(rawPath, hostResult!.finalMessage!, {
              flag: "wx",
              mode: 0o600,
            });
          } catch {
            throw new Error(
              `trial persistence failed; fixture retained at ${workspace}`,
            );
          }
        }
        const evidence = {
          caseId: options.case.id,
          trial,
          executionMode: options.dry ? "dry" : "executed",
          candidateDurationMs,
          condition: {
            requested: options.condition,
            actual: hostResult?.actualCondition ?? "unknown",
            appliedInstrumentation,
          },
          observationCompleteness: completeness,
          observations: [
            observation,
            ...shellObservations,
            ...gitHeadObservations,
            ...semanticObservations,
            ...additionalObservations,
          ],
          metrics: extensionMetrics,
          domainOutcomes,
          taskVerdictPolicy: options.extension?.session.identity
            .selectedTaskVerdictPolicy
            ? {
                id: options.extension.session.identity
                  .selectedTaskVerdictPolicy,
                recommendation: taskPolicyRecommendation,
              }
            : null,
          advisoryReview,
          routes,
          usage: usage(hostResult),
          rawResult: {
            source: options.host.id,
            path: rawPath ? pathToFileURL(rawPath).href : null,
            sha256: rawDigest,
          },
          artifactRefs: trialArtifactRefs,
        };
        const artifactPath = join(runDir, `trial-${trial}.json`);
        const trialSummary: TrialSummary = {
          trial,
          ...assessment,
          checks,
          domainOutcomes,
          artifactPath,
        };
        try {
          await atomicWriteJson(artifactPath, {
            format: "sevro.trial-evidence.v1",
            caseId: options.case.id,
            trial,
            result: trialSummary,
            evidence,
          });
        } catch {
          throw new Error(
            `trial persistence failed; fixture retained at ${workspace}`,
          );
        }
        persisted = true;
        trialSummaries.push(trialSummary);
        trialEvidence.push(evidence);
        saveState("active");
        if (
          (execution !== "completed" && execution !== "not_run") ||
          graderError
        )
          break;
      } finally {
        if (persisted) {
          try {
            await rm(workspace, { recursive: true, force: true });
          } catch {
            console.warn(`fixture cleanup failed; retained at ${workspace}`);
          }
        }
      }
    }

    const caseAssessment = summarizeAssessments(
      trialSummaries,
      options.passThreshold,
    );
    const caseResult: CaseSummary = {
      caseId: options.case.id,
      ...caseAssessment,
      trials: trialSummaries,
    };
    const runAssessment = summarizeCases([caseResult]);
    const signalReason = options.signal?.aborted ? options.signal.reason : null;
    const result: CliResult = {
      format: "sevro.cli-result.v1",
      runId,
      ...runAssessment,
      exitCode: exitCodeFor(runAssessment, {
        dryRun: options.dry,
        signal:
          signalReason === "SIGINT" || signalReason === "SIGTERM"
            ? signalReason
            : undefined,
      }),
      evidencePath,
      cases: [caseResult],
    };
    const actualConditions = [
      ...new Set(
        trialEvidence.map(
          (entry) => (entry.condition as { actual: string }).actual,
        ),
      ),
    ];
    const commonAppliedInstrumentation =
      trialEvidence.length === options.trialCount &&
      trialEvidence.every(
        (entry) =>
          canonicalJson(
            (
              entry.condition as {
                appliedInstrumentation: InstrumentationRequest[];
              }
            ).appliedInstrumentation,
          ) === canonicalJson(requestedInstrumentation),
      )
        ? requestedInstrumentation
        : [];
    const runEvidence = {
      format: "sevro.run-evidence.v1",
      runId,
      evaluationIdentity,
      configuration: {
        digest: hashJson(redactedConfig),
        redacted: redactedConfig,
      },
      runner,
      project,
      extension: options.extension
        ? {
            id: options.extension.session.identity.id,
            version: options.extension.session.identity.version,
            sourceDigest: options.extension.session.identity.sourceDigest,
            configurationDigest:
              options.extension.session.identity.configurationDigest,
            protocol: options.extension.session.identity.protocol,
            capabilities: options.extension.session.identity.capabilities,
            replacements: {
              graders: replacedBuiltinGraders,
              taskVerdictPolicy:
                options.extension.session.identity.selectedTaskVerdictPolicy,
            },
          }
        : null,
      condition: {
        requested: options.condition,
        actual: actualConditions.length === 1 ? actualConditions[0] : "unknown",
        requestedInstrumentation,
        appliedInstrumentation: commonAppliedInstrumentation,
      },
      graders: {
        active: activeGraders,
        replacedDefaults: replacedBuiltinGraders,
      },
      routes,
      result,
      trials: trialEvidence,
      ...(diagnostic ? { diagnostic } : {}),
    };
    assertCliResult(result);
    assertRunEvidence(runEvidence);
    await atomicWriteJson(evidencePath, runEvidence);
    saveState(options.signal?.aborted ? "interrupted" : "complete");
    return { result };
  } catch (error) {
    try {
      checkpointRunOwner(
        owner,
        trialSummaries.map((trial) => ({
          trial: trial.trial,
          artifactPath: trial.artifactPath,
        })),
        "diagnostic",
      );
    } catch {
      // Preserve the original failure; retained artifacts remain inspectable.
    }
    throw error;
  }
}
