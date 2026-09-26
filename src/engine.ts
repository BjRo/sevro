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
import { evaluationProtectedRoots } from "./hosts/isolation-roots";
import { createEvaluationIdentity, hashJson } from "./identity";
import {
  fixtureParts,
  prepareArtifacts,
  type InlineArtifact,
  type PreparationSources,
} from "./preparation";
import type { ExtensionCase } from "./extension-session";
import { openExtensionSession } from "./extension-session";
import {
  assessTrial,
  exitCodeFor,
  summarizeAssessments,
  summarizeCases,
  type Assessment,
  type CheckOutcome,
} from "./results";
import { assertCliResult, assertRunEvidence } from "./schema";
import { atomicWriteJson } from "./storage";
import { runnerProvenance } from "./provenance";

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
  fixture: { files: Record<string, string> };
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
  runnerBuildDigest: string;
  projectDigest: string;
  condition: "passive" | "enforced";
  trialCount: number;
  passThreshold: number;
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
  files: Record<string, string>,
  artifacts: InlineArtifact[],
): Promise<string> {
  const paths = Object.entries(files).map(([path, content]) => ({
    path,
    parts: fixtureParts(path),
    content,
  }));
  const workspace = await mkdtemp(join(tmpdir(), "sevro-case-"));
  try {
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
  if (options.case.requiredEvidence.length)
    throw new EvaluationConfigurationError(
      "required host evidence is not supported by this engine path",
    );
  if (options.extension?.session.identity.selectedTaskVerdictPolicy)
    throw new EvaluationConfigurationError(
      "extension task policy replacement is not supported by this engine path",
    );
  const builtinDeclarations = options.case.checks.filter((check) =>
    isOutputGrader(check.grader),
  ) as OutputCheckDeclaration[];
  const shellDeclarations = options.case.checks.filter(
    (check) => check.grader === "sevro.shell",
  ) as ShellCheckDeclaration[];
  const extensionDeclarations = options.case.checks.filter(
    (check) => !isOutputGrader(check.grader) && check.grader !== "sevro.shell",
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
    if (
      resolved.fixture.kind !== "inline" ||
      hashJson({
        id: resolved.id,
        prompt: resolved.prompt,
        files: resolved.fixture.files,
        checks: resolved.checks,
        requiredEvidence: resolved.requiredEvidence,
      }) !==
        hashJson({
          id: options.case.id,
          prompt: options.case.prompt,
          files: options.case.fixture.files,
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
  try {
    prepared = prepareOutputChecks(builtinDeclarations);
    preparedShell = prepareShellChecks(shellDeclarations);
    for (const path of Object.keys(options.case.fixture.files))
      fixtureParts(path);
  } catch (error) {
    throw new EvaluationConfigurationError(
      error instanceof Error ? error.message : "invalid case configuration",
    );
  }

  const projectRoot = await realpath(options.projectRoot).catch(() => {
    throw new EvaluationConfigurationError("project root is unreadable");
  });
  const runner = await runnerProvenance(options.runnerBuildDigest);
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
      Object.keys(options.case.fixture.files),
      options.preparationSources,
    );
  } catch (error) {
    throw new EvaluationConfigurationError(
      error instanceof Error ? error.message : "invalid preparation artifacts",
    );
  }
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
  const redactedConfig = {
    condition: options.condition,
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
      [...builtinDeclarations, ...shellDeclarations].map(
        (check) => check.grader,
      ),
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
        files: options.case.fixture.files,
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
      routeDigest: hashJson(route),
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
  const artifactRefs: { id: string; path: string; sha256: string }[] = [];
  for (const artifact of inlineArtifacts) {
    const retainedPath = join(
      runDir,
      "prepared",
      ...fixtureParts(artifact.relativePath),
    );
    await mkdir(dirname(retainedPath), { recursive: true, mode: 0o700 });
    await writeFile(retainedPath, artifact.bytes, { flag: "wx", mode: 0o600 });
    artifactRefs.push({
      id: artifact.id,
      path: pathToFileURL(retainedPath).href,
      sha256: artifact.sha256,
    });
  }

  const trialSummaries: TrialSummary[] = [];
  const trialEvidence: Record<string, unknown>[] = [];
  async function saveState(status: "running" | "complete"): Promise<void> {
    const completedTrials = trialSummaries.map((trial) => ({
      trial: trial.trial,
      artifactPath: trial.artifactPath,
    }));
    await atomicWriteJson(checkpointPath, {
      format: "sevro.run-checkpoint.v1",
      runId,
      completedTrials,
    });
    await atomicWriteJson(activePath, {
      format: "sevro.active-run.v1",
      runId,
      status,
      artifactPath: evidencePath,
      evidenceDirectory: stateDir,
      checkpointPath,
      completedTrials,
    });
  }
  await saveState("running");
  let diagnostic: { code: string; message: string } | undefined;
  for (let trial = 1; trial <= options.trialCount; trial++) {
    const workspace = await createFixture(
      options.case.fixture.files,
      inlineArtifacts,
    );
    let persisted = false;
    try {
      let hostResult: HostResult | null = null;
      let execution: "completed" | "failed" | "cancelled" = "completed";
      try {
        if (options.signal?.aborted) throw new Error("cancelled");
        hostResult = await options.host.run({
          prompt: options.case.prompt,
          workspace,
          condition: options.condition,
          signal: options.signal,
        });
        if (
          hostResult.finalMessage !== null &&
          Buffer.byteLength(hostResult.finalMessage, "utf8") >
            MAX_FINAL_MESSAGE_BYTES
        )
          throw new Error("oversized host result");
      } catch {
        execution = options.signal?.aborted ? "cancelled" : "failed";
        hostResult = null;
        diagnostic = {
          code: "sevro.host.failed",
          message: "host execution did not complete",
        };
      }
      await verifyRetainedArtifacts(artifactRefs);
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
              byteLength: Buffer.byteLength(hostResult!.finalMessage!, "utf8"),
            }
          : {},
      };
      const shellObservations: {
        id: string;
        source: string;
        completeness: "complete";
        data: Record<string, unknown>;
      }[] = [];
      let checks: CheckOutcome[] = [];
      let extensionMetrics: {
        id: string;
        value: number | null;
        unit: string;
      }[] = [];
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
              runStateRoot,
            ],
          });
          for (const check of preparedShell) {
            const exitCode = await runShellCheck(check, {
              workspace,
              protectedRoots,
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
              status: exitCode === check.expectedExitCode ? "passed" : "failed",
              detail: `exit code ${exitCode}`,
              evidenceRefs: [observationId],
            });
          }
        } catch {
          graderError = true;
          diagnostic = {
            code: "sevro.grader.error",
            message: "shell grading did not complete",
          };
        }
      }
      if (options.extension && !graderError) {
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
            ],
            builtinChecks: checks.map((check) => ({
              id: check.id,
              status: check.status,
              ...(check.detail ? { detail: check.detail } : {}),
              evidenceRefs: check.evidenceRefs ?? [],
            })),
            artifacts: artifactRefs,
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
        } catch {
          graderError = true;
          diagnostic = {
            code: "sevro.grader.error",
            message: "extension grading did not complete",
          };
        }
      }
      const assessment = assessTrial({
        execution,
        declaredChecks: options.case.checks.map((check) => check.id),
        checks,
        graderError,
      });
      await verifyRetainedArtifacts(artifactRefs);
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
        executionMode: "executed",
        condition: {
          requested: options.condition,
          actual: hostResult?.actualCondition ?? "unknown",
          appliedInstrumentation: [],
        },
        observationCompleteness: completeness,
        observations: [observation, ...shellObservations],
        metrics: extensionMetrics,
        routes: [route],
        usage: usage(hostResult),
        rawResult: {
          source: options.host.id,
          path: rawPath ? pathToFileURL(rawPath).href : null,
          sha256: rawDigest,
        },
        artifactRefs,
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
      await saveState("running");
      if (execution !== "completed" || graderError) break;
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
  const result: CliResult = {
    format: "sevro.cli-result.v1",
    runId,
    ...runAssessment,
    exitCode: exitCodeFor(runAssessment),
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
    project: {
      root: pathToFileURL(projectRoot).href,
      revision: null,
      dirtyPatchDigest: null,
    },
    extension: options.extension
      ? {
          id: options.extension.session.identity.id,
          version: options.extension.session.identity.version,
          sourceDigest: options.extension.session.identity.sourceDigest,
          configurationDigest:
            options.extension.session.identity.configurationDigest,
          protocol: options.extension.session.identity.protocol,
          capabilities: options.extension.session.identity.capabilities,
          replacements: { graders: [], taskVerdictPolicy: null },
        }
      : null,
    condition: {
      requested: options.condition,
      actual: actualConditions.length === 1 ? actualConditions[0] : "unknown",
      requestedInstrumentation: [],
      appliedInstrumentation: [],
    },
    graders: { active: activeGraders, replacedDefaults: [] },
    routes: [route],
    result,
    trials: trialEvidence,
    ...(diagnostic ? { diagnostic } : {}),
  };
  assertCliResult(result);
  assertRunEvidence(runEvidence);
  await atomicWriteJson(evidencePath, runEvidence);
  await saveState("complete");
  return { result };
}
