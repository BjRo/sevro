import { createHash, randomUUID } from "node:crypto";
import {
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
import {
  fixtureParts,
  prepareArtifacts,
  type InlineArtifact,
  type PreparationSources,
} from "./preparation";
import {
  cloneRepositorySource,
  resolveRepositorySource,
  type RepositorySource,
} from "./repository-fixture";
import type { ExtensionCase } from "./extension-session";
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
  artifacts?: { id: string; bytes: Uint8Array }[];
  observations?: {
    id: string;
    completeness: "complete" | "partial" | "unavailable";
    data: Record<string, unknown>;
  }[];
  actualCondition?: "passive" | "enforced" | "unknown";
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  usageComplete?: boolean;
}

export interface HostAdapter {
  id: string;
  model: string;
  effort: string;
  run(request: {
    prompt: string;
    workspace: string;
    condition: "passive" | "enforced";
    signal?: AbortSignal;
  }): Promise<HostResult>;
}

export interface ResolvedCase {
  id: string;
  prompt: string;
  fixture:
    | { files: Record<string, string>; sourceRef?: never }
    | { sourceRef: string; files?: never };
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
  runnerBuildDigest: string;
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
  shellIsolation?: { protectedRoots: string[] };
}

interface TrialSummary extends Assessment {
  trial: number;
  checks: CheckOutcome[];
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
): Promise<string> {
  const paths = Object.entries(fixture.files ?? {}).map(([path, content]) => ({
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
    for (const file of paths) {
      const target = join(workspace, ...file.parts);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { flag: "wx", mode: 0o600 });
    }
    for (const artifact of artifacts) {
      const target = join(workspace, ...fixtureParts(artifact.relativePath));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, artifact.bytes, { flag: "wx", mode: 0o600 });
    }
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
    !options.case.fixture ||
    typeof options.case.fixture !== "object" ||
    Array.isArray(options.case.fixture)
  )
    throw new EvaluationConfigurationError("invalid fixture declaration");
  const inlineFixture = Object.hasOwn(options.case.fixture, "files");
  if (
    inlineFixture === Object.hasOwn(options.case.fixture, "sourceRef") ||
    (inlineFixture &&
      (options.case.fixture.files === null ||
        typeof options.case.fixture.files !== "object" ||
        Array.isArray(options.case.fixture.files) ||
        Object.values(options.case.fixture.files).some(
          (content) => typeof content !== "string",
        ))) ||
    (!inlineFixture &&
      (typeof options.case.fixture.sourceRef !== "string" ||
        !options.case.fixture.sourceRef))
  )
    throw new EvaluationConfigurationError(
      "fixture must declare inline files or a repository source",
    );
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
  const builtinDeclarations = options.case.checks.filter((check) =>
    isOutputGrader(check.grader),
  ) as OutputCheckDeclaration[];
  const shellDeclarations = options.case.checks.filter(
    (check) => check.grader === "sevro.shell",
  ) as ShellCheckDeclaration[];
  const semanticDeclarations = options.case.checks.filter(
    (check) => check.grader === "sevro.semantic",
  ) as SemanticCheckDeclaration[];
  const extensionDeclarations = options.case.checks.filter(
    (check) =>
      !isOutputGrader(check.grader) &&
      check.grader !== "sevro.shell" &&
      check.grader !== "sevro.semantic",
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
  if (shellDeclarations.length && !options.shellIsolation)
    throw new EvaluationConfigurationError(
      "shell checks require explicit protected source roots",
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
        : { sourceRef: resolved.fixture.sourceRef };
    if (
      hashJson({
        id: resolved.id,
        prompt: resolved.prompt,
        fixture,
        checks: resolved.checks,
        requiredEvidence: resolved.requiredEvidence,
      }) !==
      hashJson({
        id: options.case.id,
        prompt: options.case.prompt,
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
  let preparedSemantic: ReturnType<typeof prepareSemanticChecks>;
  try {
    prepared = prepareOutputChecks(builtinDeclarations);
    preparedShell = prepareShellChecks(shellDeclarations);
    preparedSemantic = prepareSemanticChecks(semanticDeclarations);
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
    runnerProvenance(options.runnerBuildDigest),
    projectProvenance(projectRoot),
  ]);
  const extensionPreparation = options.extension
    ? await options.extension.session.prepare(
        options.extension.resolvedCase,
        { id: options.host.id, capabilities: [] },
        options.condition,
      )
    : null;
  if (extensionPreparation?.requestedInstrumentation.length)
    throw new EvaluationConfigurationError(
      "extension preparation requested unsupported instrumentation",
    );
  let inlineArtifacts: InlineArtifact[];
  try {
    inlineArtifacts = await prepareArtifacts(
      extensionPreparation?.artifacts ?? [],
      Object.keys(options.case.fixture.files ?? {}),
      options.preparationSources,
    );
  } catch (error) {
    throw new EvaluationConfigurationError(
      error instanceof Error ? error.message : "invalid preparation artifacts",
    );
  }
  if (
    repository &&
    inlineArtifacts.some(
      (artifact) => fixtureParts(artifact.relativePath)[0] === ".git",
    )
  )
    throw new EvaluationConfigurationError(
      "preparation artifacts cannot modify repository metadata",
    );
  if (
    semanticDeclarations.length &&
    inlineArtifacts.some((item) => item.id === "sevro.semantic.verdicts")
  )
    throw new EvaluationConfigurationError(
      "preparation artifact uses a reserved semantic evidence ID",
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
  ];
  const redactedConfig = {
    condition: options.condition,
    executionMode: options.dry ? "dry" : "executed",
    trialCount: options.trialCount,
    passThreshold: options.passThreshold,
    extensionConfigurationDigest:
      options.extension?.session.identity.configurationDigest ?? null,
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
        extensionData,
      }),
      fixtureDigest: hashJson({
        ...(repository
          ? {
              sourceRef: options.case.fixture.sourceRef,
              revision: repository.revision,
            }
          : { files: options.case.fixture.files }),
        artifacts: inlineArtifacts.map(({ id, relativePath, sha256 }) => ({
          id,
          relativePath,
          sha256,
        })),
      }),
      checksDigest: hashJson(options.case.checks),
      requiredEvidenceDigest: hashJson(options.case.requiredEvidence),
      evaluatorDigest: hashJson({
        policy: "sevro.builtin-output.v1",
        extension: options.extension?.session.identity ?? null,
        extensionData,
      }),
      graderDigest: hashJson(activeGraders),
      instrumentationDigest: hashJson({ requested: [], applied: [] }),
      routeDigest: hashJson(preparedSemantic.length ? routes : route),
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
    const artifactRefs: { id: string; path: string; sha256: string }[] = [];
    for (const artifact of inlineArtifacts) {
      const retainedPath = join(
        runDir,
        "prepared",
        ...fixtureParts(artifact.relativePath),
      );
      await mkdir(dirname(retainedPath), { recursive: true, mode: 0o700 });
      await writeFile(retainedPath, artifact.bytes, {
        flag: "wx",
        mode: 0o600,
      });
      artifactRefs.push({
        id: artifact.id,
        path: pathToFileURL(retainedPath).href,
        sha256: artifact.sha256,
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
      );
      let persisted = false;
      try {
        let hostResult: HostResult | null = null;
        let additionalObservations: ReturnType<typeof hostObservations> = [];
        let producedArtifacts: ReturnType<typeof hostArtifacts> = [];
        let execution: "completed" | "failed" | "cancelled" | "not_run" =
          options.dry ? "not_run" : "completed";
        if (!options.dry) {
          try {
            if (options.signal?.aborted) throw new Error("cancelled");
            hostResult = await options.host.run({
              prompt: options.case.prompt,
              workspace,
              condition: options.condition,
              signal: options.signal,
            });
            if (options.signal?.aborted) throw new Error("cancelled");
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
                ...(preparedSemantic.length ? ["sevro.semantic.verdicts"] : []),
              ]),
            );
          } catch {
            execution = options.signal?.aborted ? "cancelled" : "failed";
            hostResult = null;
            diagnostic = {
              code:
                execution === "cancelled"
                  ? "sevro.run.cancelled"
                  : "sevro.host.failed",
              message:
                execution === "cancelled"
                  ? "run cancelled"
                  : "host execution did not complete",
            };
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
              const exitCode = await runShellCheck(check, {
                workspace,
                protectedRoots,
                protectedRootsCanonical: true,
                privateStateRoot: join(stateDir, "shell-sandbox"),
                signal: options.signal,
              });
              const observationId = `sevro.observation.shell.${check.id}`;
              shellObservations.push({
                id: observationId,
                source: "sevro.shell",
                completeness: "complete",
                data: { exitCode, expectedExitCode: check.expectedExitCode },
              });
              checks.push({
                id: check.id,
                grader: "sevro.shell",
                status:
                  exitCode === check.expectedExitCode ? "passed" : "failed",
                detail: `exit code ${exitCode}`,
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
        const defaultAssessment = assessTrial({
          execution,
          declaredChecks: options.case.checks.map((check) => check.id),
          checks,
          graderError,
          requiredEvidenceUnavailable: options.case.requiredEvidence.some(
            (id) =>
              !producedArtifacts.some((item) => item.id === id) &&
              ![
                observation,
                ...shellObservations,
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
          condition: {
            requested: options.condition,
            actual: hostResult?.actualCondition ?? "unknown",
            appliedInstrumentation: [],
          },
          observationCompleteness: completeness,
          observations: [
            observation,
            ...shellObservations,
            ...semanticObservations,
            ...additionalObservations,
          ],
          metrics: extensionMetrics,
          taskVerdictPolicy: options.extension?.session.identity
            .selectedTaskVerdictPolicy
            ? {
                id: options.extension.session.identity
                  .selectedTaskVerdictPolicy,
                recommendation: taskPolicyRecommendation,
              }
            : null,
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
              graders: [],
              taskVerdictPolicy:
                options.extension.session.identity.selectedTaskVerdictPolicy,
            },
          }
        : null,
      condition: {
        requested: options.condition,
        actual: actualConditions.length === 1 ? actualConditions[0] : "unknown",
        requestedInstrumentation: [],
        appliedInstrumentation: [],
      },
      graders: { active: activeGraders, replacedDefaults: [] },
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
