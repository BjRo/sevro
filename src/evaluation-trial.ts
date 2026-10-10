import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  checkpointEvaluation,
  prepareTrialWorkspace,
  type EvaluationContext,
} from "./evaluation-context";
import {
  hostArtifacts,
  hostObservations,
  sha256,
  usage,
  verifyRetainedArtifacts,
} from "./evaluation-fixture";
import {
  gradingRuntimePolicy,
  scopedHostArtifacts,
} from "./evaluation-grading-host";
import { gradeSemanticChecks } from "./evaluation-semantic";
import {
  type EvaluationOptions,
  type HostAdapter,
  type HostResult,
  type TrialSummary,
} from "./evaluation-types";
import type { EvaluationResult } from "./extension-session";
import { clearFixtureContents } from "./fixture-cleanup";
import {
  assessGitHeadCheck,
  gitHeadRevision,
  gitHeadState,
} from "./graders/git-head";
import { gradeOutput } from "./graders/output";
import { assessShellCheck, runShellCheck } from "./graders/shell";
import { evaluationProtectedRoots } from "./hosts/isolation-roots";
import {
  InstrumentationEvidenceError,
  snapshotInstrumentation,
  verifyAppliedInstrumentation,
  type InstrumentationRequest,
} from "./instrumentation";
import { materializeNativeTranscriptView } from "./native-transcript-view";
import {
  applyTaskVerdictPolicy,
  assessTrial,
  type Assessment,
  type CheckOutcome,
} from "./results";
import type { RunEvidenceData } from "./schema-types";
import { atomicWriteJson } from "./storage";
import { scheduleTrials } from "./trial-scheduler";

const MAX_FINAL_MESSAGE_BYTES = 8 * 1024 * 1024;

interface TrialObservation {
  id: string;
  source: string;
  completeness: "complete" | "partial" | "unavailable";
  data: Record<string, unknown>;
}
function candidateMarketplaceRequest(context: EvaluationContext) {
  const marketplace = context.codexMarketplace;
  if (!marketplace) return {};
  return {
    codexMarketplace: {
      ...marketplace,
      artifactPaths: context.inlineArtifacts
        .filter((artifact) =>
          artifact.relativePath.startsWith(`${marketplace.artifactRoot}/`),
        )
        .map((artifact) => artifact.relativePath),
    },
  };
}

function candidatePluginDirectoriesRequest(context: EvaluationContext) {
  const directories = context.claudePluginDirs;
  if (!directories) return {};
  return {
    claudePluginDirs: {
      ...directories,
      artifactPaths: context.inlineArtifacts
        .filter((artifact) =>
          directories.artifactRoots.some((root) =>
            artifact.relativePath.startsWith(`${root}/`),
          ),
        )
        .map((artifact) => artifact.relativePath),
    },
  };
}

function candidateInvocationRequest(context: EvaluationContext) {
  if (context.invocation === undefined || context.invocationToken === null)
    return {};
  return {
    explicitSkillInvocation: {
      ...context.invocation,
      token: context.invocationToken,
    },
  };
}

function ensureNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("cancelled");
}

function hostFailureDiagnostic(execution: string, error: unknown) {
  if (execution === "cancelled")
    return { code: "sevro.run.cancelled", message: "run cancelled" };
  if (error instanceof InstrumentationEvidenceError)
    return { code: "sevro.instrumentation.mismatch", message: error.message };
  return {
    code: "sevro.host.failed",
    message: "host execution did not complete",
  };
}

type AdvisoryReview = {
  status: "completed" | "failed" | "not_run";
  assessment: AdvisoryAssessment | null;
  usage: ReturnType<typeof usage>;
  rawResult: {
    source: string;
    path: string | null;
    sha256: string | null;
  };
};

function defaultAdvisoryReview(host: HostAdapter): AdvisoryReview {
  return {
    status: "not_run",
    assessment: null,
    usage: usage(null),
    rawResult: { source: host.id, path: null, sha256: null },
  };
}

function isTrialPersistenceFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("trial persistence failed")
  );
}

function completeAdvisoryAssessment(response: HostResult): AdvisoryAssessment {
  if (
    response.executionFailed ||
    !response.complete ||
    response.finalMessage === null
  )
    throw new Error("advisory response is incomplete");
  return parseAdvisoryAssessment(response.finalMessage);
}

function extensionFinalMessageData(result: HostResult | null) {
  return result?.finalMessage == null ? {} : { text: result.finalMessage };
}

function extensionCheckResult(
  check: EvaluationResult["checks"][number],
  declared: Map<string, string>,
): CheckOutcome {
  const grader = declared.get(check.id);
  if (grader === undefined)
    throw new Error("extension returned an undeclared check");
  return {
    id: check.id,
    grader,
    status: check.status,
    ...(check.detail ? { detail: check.detail } : {}),
    evidenceRefs: check.evidenceRefs,
  };
}

function compareDeclaredChecks(
  left: CheckOutcome,
  right: CheckOutcome,
  order: Map<string, number>,
): number {
  const leftIndex = order.get(left.id);
  const rightIndex = order.get(right.id);
  // Match the stable NaN comparator fallback; assessment reports undeclared IDs.
  if (leftIndex === undefined || rightIndex === undefined) return 0;
  return leftIndex - rightIndex;
}

function selectedTrialTaskPolicy(
  options: EvaluationOptions,
  recommendation: "passed" | "failed" | "not_assessed" | null,
) {
  const id = options.extension?.session.identity.selectedTaskVerdictPolicy;
  return id ? { id, recommendation } : null;
}

class EvaluationTrial {
  private candidateTranscriptRoot?: string;
  private diagnostic: { code: string; message: string } | undefined = undefined;
  private persisted: boolean = false;
  private gitHeadBase: string | null = null;
  private advisoryRevision: string | null = null;
  private hostResult: HostResult | null = null;
  private appliedInstrumentation: InstrumentationRequest[] = [];
  private additionalObservations: ReturnType<typeof hostObservations> = [];
  private producedArtifacts: ReturnType<typeof hostArtifacts> = [];
  private execution: "completed" | "failed" | "cancelled" | "not_run";
  private candidateDurationMs: number | null = null;
  private trialArtifactRefs: EvaluationContext["artifactRefs"] = [];
  private rawDigest: string | null = null;
  private completeness: "complete" | "partial" | "unavailable" = "unavailable";
  private observation: TrialObservation = {
    id: "sevro.observation.final-message",
    source: "",
    completeness: "unavailable",
    data: {},
  };
  private shellObservations: TrialObservation[] = [];
  private gitHeadObservations: TrialObservation[] = [];
  private semanticObservations: TrialObservation[] = [];
  private checks: CheckOutcome[] = [];
  private extensionMetrics: EvaluationResult["metrics"] = [];
  private domainOutcomes: NonNullable<EvaluationResult["domainOutcomes"]> = [];
  private taskPolicyRecommendation:
    "passed" | "failed" | "not_assessed" | null = null;
  private graderError: boolean = false;
  private assessment: Assessment = {
    execution: { status: "not_run" },
    grading: { status: "not_requested" },
    task: { verdict: "not_assessed" },
  };
  private advisoryReview: AdvisoryReview | null = null;
  private rawPath: string | null = null;
  constructor(
    private readonly options: EvaluationOptions,
    private readonly context: EvaluationContext,
    private readonly trial: number,
    private readonly stopAdmission: () => void,
    private readonly fixture: Awaited<ReturnType<typeof prepareTrialWorkspace>>,
  ) {
    this.execution = options.dry ? "not_run" : "completed";
  }
  async run(): Promise<boolean> {
    try {
      if (this.fixture.preparationCancelled)
        return await this.cancelPreparation();
      await this.initializeGradingBases();
      await this.runCandidate();
      await this.retainCandidateArtifacts();
      this.observeCandidate();
      this.gradeOutput();
      await this.gradeShell();
      await this.gradeGitHead();
      await this.gradeSemantic();
      await this.gradeExtension();
      this.assess();
      await this.runAdvisory();
      await this.retainRawCandidate();
      return await this.persistTrial();
    } finally {
      await this.cleanup();
    }
  }
  private async cancelPreparation(): Promise<boolean> {
    this.failCandidate(undefined);
    await this.retainCandidateArtifacts();
    this.observeCandidate();
    this.assess();
    return this.persistTrial();
  }
  private async initializeGradingBases(): Promise<void> {
    this.gitHeadBase = this.context.preparedGitHead.length
      ? await gitHeadRevision(this.fixture.workspace, this.options.signal)
      : null;
    this.advisoryRevision = this.options.advisoryHost
      ? await advisoryBaseRevision(this.fixture.workspace)
      : null;
  }
  private candidateRequest(): Parameters<HostAdapter["run"]>[0] {
    return {
      prompt: this.fixture.trialPrompt,
      ...(this.fixture.trialFollowUpPrompt !== undefined
        ? { followUpPrompt: this.fixture.trialFollowUpPrompt }
        : {}),
      workspace: this.fixture.workspace,
      condition: this.options.condition,
      fixtureBinDir: this.fixture.fixtureBinDir,
      runtimePolicy: this.options.runtimePolicy,
      instrumentation: snapshotInstrumentation(
        this.context.requestedInstrumentation,
      ),
      ...candidateMarketplaceRequest(this.context),
      ...candidatePluginDirectoriesRequest(this.context),
      ...candidateInvocationRequest(this.context),
      signal: this.options.signal,
    };
  }

  private candidateReservedIds(): Set<string> {
    return new Set([
      "sevro.observation.final-message",
      ...this.context.artifactRefs.map((item) => item.id),
      ...this.additionalObservations.map((item) => item.id),
      ...this.options.case.checks.map((item) => item.id),
      ...this.context.preparedShell.map(
        (item) => `sevro.observation.shell.${item.id}`,
      ),
      ...(this.context.preparedGitHead.length
        ? ["sevro.observation.git-head"]
        : []),
      ...(this.context.preparedSemantic.length
        ? ["sevro.semantic.verdicts"]
        : []),
    ]);
  }

  private acceptCandidateResult(response: HostResult): void {
    this.appliedInstrumentation = verifyAppliedInstrumentation(
      this.context.requestedInstrumentation,
      response.appliedInstrumentation,
      this.options.condition,
      response.actualCondition,
    );
    if (
      response.finalMessage !== null &&
      Buffer.byteLength(response.finalMessage, "utf8") > MAX_FINAL_MESSAGE_BYTES
    )
      throw new Error("oversized host result");
    this.additionalObservations = hostObservations(
      response,
      this.options.host.id,
      new Set([
        ...this.context.artifactRefs.map((item) => item.id),
        ...this.options.case.checks.map((item) => item.id),
      ]),
    );
    this.producedArtifacts = hostArtifacts(
      response,
      this.candidateReservedIds(),
    );
    if (response.executionFailed) {
      this.execution = "failed";
      this.stopAdmission();
      this.diagnostic = {
        code: "sevro.host.failed",
        message: "host execution did not complete",
      };
    }
  }

  private failCandidate(error: unknown): void {
    this.execution = this.options.signal?.aborted ? "cancelled" : "failed";
    this.stopAdmission();
    this.hostResult = null;
    this.diagnostic = hostFailureDiagnostic(this.execution, error);
  }

  private async runCandidate(): Promise<void> {
    if (this.options.dry) return;
    const started = performance.now();
    try {
      ensureNotCancelled(this.options.signal);
      this.hostResult = await this.options.host.run(this.candidateRequest());
      this.acceptCandidateResult(this.hostResult);
      if (this.options.signal?.aborted) {
        this.execution = "cancelled";
        this.stopAdmission();
        this.diagnostic = hostFailureDiagnostic("cancelled", undefined);
      }
    } catch (error) {
      this.failCandidate(error);
    } finally {
      this.candidateDurationMs = Math.max(0, performance.now() - started);
    }
  }

  private async writeTrialFile(
    path: string,
    bytes: string | Uint8Array,
  ): Promise<void> {
    try {
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    } catch (cause) {
      throw new Error(
        `trial persistence failed; fixture retained at ${this.fixture.workspace}`,
        { cause },
      );
    }
  }

  private async retainArtifacts(
    artifacts: ReturnType<typeof hostArtifacts>,
    prefix = "",
  ): Promise<void> {
    for (const artifact of artifacts) {
      const path = join(
        this.context.runDir,
        `trial-${this.trial}-${prefix}${artifact.id}.bin`,
      );
      await this.writeTrialFile(path, artifact.bytes);
      this.trialArtifactRefs.push({
        id: artifact.id,
        path: pathToFileURL(path).href,
        sha256: sha256(artifact.bytes),
      });
    }
  }

  private async retainCandidateArtifacts(): Promise<void> {
    this.trialArtifactRefs = [...this.context.artifactRefs];
    await this.retainArtifacts(this.producedArtifacts, "host-");
    await verifyRetainedArtifacts(this.trialArtifactRefs);
    const bundle = this.producedArtifacts.find(
      (item) => item.id === "sevro.native-transcripts.bundle",
    );
    if (this.options.runtimePolicy?.nativeTranscripts && bundle)
      this.candidateTranscriptRoot = await materializeNativeTranscriptView(
        bundle.bytes,
      );
  }

  private observeCandidate(): void {
    const result = this.hostResult;
    if (result === null || result.finalMessage == null) {
      this.rawDigest = null;
      this.completeness = "unavailable";
      this.observation = {
        id: "sevro.observation.final-message",
        source: this.options.host.id,
        completeness: this.completeness,
        data: {},
      };
      return;
    }
    this.rawDigest = sha256(result.finalMessage);
    this.completeness = result.complete ? "complete" : "partial";
    this.observation = {
      id: "sevro.observation.final-message",
      source: this.options.host.id,
      completeness: this.completeness,
      data: {
        sha256: this.rawDigest,
        byteLength: Buffer.byteLength(result.finalMessage, "utf8"),
      },
    };
  }

  private failGrading(message: string, cancelable = true): void {
    if (cancelable && this.options.signal?.aborted) {
      this.execution = "cancelled";
      this.diagnostic = {
        code: "sevro.run.cancelled",
        message: "run cancelled",
      };
      return;
    }
    this.graderError = true;
    this.diagnostic = { code: "sevro.grader.error", message };
    this.stopAdmission();
  }

  private canGrade(): boolean {
    return this.execution === "completed" && !this.graderError;
  }

  private gradeOutput(): void {
    if (this.execution !== "completed") return;
    try {
      const result = this.hostResult;
      if (!result) throw new Error("host result is unavailable");
      this.checks = gradeOutput(
        result.finalMessage,
        result.complete,
        this.context.prepared,
      ).map((check) => ({
        ...check,
        evidenceRefs: this.rawDigest ? [this.observation.id] : [],
      }));
    } catch {
      this.failGrading("output grading did not complete", false);
    }
  }

  private async shellProtectedRoots(): Promise<string[]> {
    const isolation = this.options.shellIsolation;
    if (!isolation)
      throw new Error("shell checks require explicit protected source roots");
    return evaluationProtectedRoots({
      workspace: this.fixture.workspace,
      projectRoot: this.context.projectRoot,
      resultsRoot: this.options.resultsRoot,
      additionalRoots: [
        ...isolation.protectedRoots,
        ...(this.options.preparationSources
          ? [this.options.preparationSources.root]
          : []),
        ...(this.context.repository ? [this.context.repository.path] : []),
        this.context.runStateRoot,
      ],
    });
  }

  private async gradeShellCheck(
    check: EvaluationContext["preparedShell"][number],
    protectedRoots: string[],
  ): Promise<void> {
    const result = await runShellCheck(check, {
      candidateTranscriptRoot: this.candidateTranscriptRoot,
      workspace: this.fixture.workspace,
      fixtureBinDir: this.fixture.fixtureBinDir,
      toolchainBinDir: this.options.shellIsolation?.toolchainBinDir,
      runtimePolicy: this.options.runtimePolicy,
      uvRuntimeCache: this.options.shellIsolation?.uvRuntimeCache,
      protectedRoots,
      protectedRootsCanonical: true,
      privateStateRoot: join(this.context.stateDir, "shell-sandbox"),
      signal: this.options.signal,
    });
    const graded = assessShellCheck(check, result);
    const id = `sevro.observation.shell.${check.id}`;
    this.shellObservations.push({
      id,
      source: "sevro.shell",
      completeness: "complete",
      data: {
        exitCode: result.exitCode,
        expectedExitCode: check.expectedExitCode,
        ...(result.stdout === null
          ? {}
          : {
              stdoutSha256: sha256(result.stdout),
              stdoutByteLength: Buffer.byteLength(result.stdout, "utf8"),
            }),
      },
    });
    this.checks.push({
      id: check.id,
      grader: "sevro.shell",
      status: graded.passed ? "passed" : "failed",
      detail: graded.detail,
      evidenceRefs: [id],
    });
  }

  private async gradeShell(): Promise<void> {
    if (!this.canGrade() || this.context.preparedShell.length === 0) return;
    try {
      const protectedRoots = await this.shellProtectedRoots();
      for (const check of this.context.preparedShell)
        await this.gradeShellCheck(check, protectedRoots);
    } catch {
      this.failGrading("shell grading did not complete");
    }
  }

  private async gradeGitHead(): Promise<void> {
    if (!this.canGrade() || this.context.preparedGitHead.length === 0) return;
    try {
      const base = this.gitHeadBase;
      if (base === null)
        throw new Error("Git HEAD base revision is unavailable");
      const state = await gitHeadState(
        this.fixture.workspace,
        base,
        this.options.signal,
      );
      const id = "sevro.observation.git-head";
      this.gitHeadObservations.push({
        id,
        source: "sevro.git-head",
        completeness: "complete",
        data: {
          baseRevision: base,
          currentRevision: state.currentRevision,
          baseAncestor: state.baseAncestor,
        },
      });
      this.checks.push(
        ...this.context.preparedGitHead.map((check) => {
          const graded = assessGitHeadCheck(check, base, state);
          return {
            id: check.id,
            grader: "sevro.git-head",
            status: graded.passed ? ("passed" as const) : ("failed" as const),
            detail: graded.detail,
            evidenceRefs: [id],
          };
        }),
      );
    } catch {
      this.failGrading("Git HEAD grading did not complete");
    }
  }

  private completeCandidateMessage(): string | null {
    const result = this.hostResult;
    if (result?.finalMessage == null || !result.complete) return null;
    return result.finalMessage;
  }

  private async gradeSemantic(): Promise<void> {
    const graded = await gradeSemanticChecks(
      {
        checks: this.context.preparedSemantic,
        declaredChecks: this.options.case.checks,
        host: this.options.semanticHost,
        message: this.completeCandidateMessage(),
        candidateWorkspace: this.fixture.workspace,
        candidateTranscriptRoot: this.candidateTranscriptRoot,
        projectRoot: this.context.projectRoot,
        reservedWorkspace:
          this.context.reservedSemanticWorkspaces[this.trial - 1],
        runDir: this.context.runDir,
        trial: this.trial,
        runtimePolicy: this.options.runtimePolicy,
        signal: this.options.signal,
      },
      {
        artifactRefs: this.trialArtifactRefs,
        canGrade: () => this.canGrade(),
        failGrading: (message, cancelable) => {
          this.failGrading(message, cancelable);
        },
        retainArtifacts: (artifacts) => this.retainArtifacts(artifacts),
        writeTrialFile: (path, bytes) => this.writeTrialFile(path, bytes),
      },
    );
    this.semanticObservations.push(...graded.observations);
    this.checks.push(...graded.checks);
  }

  private trialObservations(): TrialObservation[] {
    return [
      this.observation,
      ...this.shellObservations,
      ...this.gitHeadObservations,
      ...this.semanticObservations,
      ...this.additionalObservations,
    ];
  }

  private extensionEvaluationRequest(): Parameters<
    NonNullable<EvaluationOptions["extension"]>["session"]["evaluate"]
  >[0] {
    return {
      caseId: this.options.case.id,
      execution: { status: this.execution },
      observations: this.trialObservations().map((observation) =>
        observation === this.observation
          ? {
              ...observation,
              completeness: this.completeness,
              data: {
                ...observation.data,
                ...extensionFinalMessageData(this.hostResult),
              },
            }
          : observation,
      ),
      builtinChecks: this.checks.map((check) => ({
        id: check.id,
        status: check.status,
        ...(check.detail ? { detail: check.detail } : {}),
        evidenceRefs: check.evidenceRefs ?? [],
      })),
      artifacts: this.trialArtifactRefs,
      extensionData: this.context.extensionData,
    };
  }

  private acceptExtensionResult(result: EvaluationResult): void {
    const declared = new Map(
      this.context.extensionDeclarations.map((check) => [
        check.id,
        check.grader,
      ]),
    );
    this.checks.push(
      ...result.checks.map((check) => extensionCheckResult(check, declared)),
    );
    this.extensionMetrics = result.metrics;
    this.domainOutcomes = result.domainOutcomes ?? [];
    this.taskPolicyRecommendation = result.taskVerdictRecommendation ?? null;
  }

  private async gradeExtension(): Promise<void> {
    const extension = this.options.extension;
    if (!extension || !this.canGrade()) return;
    try {
      this.acceptExtensionResult(
        await extension.session.evaluate(this.extensionEvaluationRequest()),
      );
    } catch {
      this.failGrading("extension grading did not complete");
    }
  }

  private assess(): void {
    const declaredOrder = new Map(
      this.options.case.checks.map((check, index) => [check.id, index]),
    );
    this.checks.sort((left, right) =>
      compareDeclaredChecks(left, right, declaredOrder),
    );
    const defaultAssessment = assessTrial({
      execution: this.execution,
      declaredChecks: this.options.case.checks
        .filter((check) => !this.context.replaced.has(check.grader))
        .map((check) => check.id),
      checks: this.checks,
      graderError: this.graderError,
      requiredEvidenceUnavailable: this.options.case.requiredEvidence.some(
        (id) =>
          !this.producedArtifacts.some((item) => item.id === id) &&
          !this.trialObservations().some(
            (item) => item.id === id && item.completeness === "complete",
          ),
      ),
    });
    this.assessment = applyTaskVerdictPolicy(
      defaultAssessment,
      this.taskPolicyRecommendation,
      Boolean(
        this.options.extension?.session.identity.selectedTaskVerdictPolicy,
      ),
    );
  }
  private async retainAdvisoryResponse(
    host: HostAdapter,
    response: HostResult,
    review: AdvisoryReview,
  ): Promise<void> {
    if (
      response.finalMessage !== null &&
      Buffer.byteLength(response.finalMessage, "utf8") <= 64 * 1024
    ) {
      const path = join(
        this.context.runDir,
        `trial-${this.trial}-advisory.json`,
      );
      await this.writeTrialFile(path, response.finalMessage);
      review.rawResult = {
        source: host.id,
        path: pathToFileURL(path).href,
        sha256: sha256(response.finalMessage),
      };
      this.trialArtifactRefs.push({
        id: "sevro.advisory.response",
        path: pathToFileURL(path).href,
        sha256: sha256(response.finalMessage),
      });
    }
  }

  private async cleanupAdvisoryWorkspace(
    workspace: string | null,
  ): Promise<void> {
    if (!workspace) return;
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch {
      console.warn(`advisory fixture cleanup failed; retained at ${workspace}`);
    }
  }

  private async executeAdvisoryReview(
    host: HostAdapter,
    review: AdvisoryReview,
  ): Promise<void> {
    let workspace: string | null = null;
    try {
      const baseRevision = this.advisoryRevision;
      if (baseRevision === null)
        throw new Error("advisory base revision is unavailable");
      workspace = await buildBlindAdvisoryFixture(this.fixture.workspace, {
        baseRevision,
        excludedPaths: this.options.advisoryExcludedPaths,
      });
      const response = await host.run({
        candidateTranscriptRoot: this.candidateTranscriptRoot,
        prompt: advisoryPrompt(this.fixture.trialPrompt, this.checks),
        runtimePolicy: gradingRuntimePolicy(this.options.runtimePolicy),
        runtimeRole: "advisory",
        workspace,
        condition: "passive",
        signal: this.options.signal,
      });
      review.usage = usage(response);
      const artifacts = scopedHostArtifacts(
        response,
        "sevro.advisory.",
        this.trialArtifactRefs,
        this.options.case.checks,
        "sevro.advisory.response",
      );
      await this.retainArtifacts(artifacts);
      await this.retainAdvisoryResponse(host, response, review);
      review.assessment = completeAdvisoryAssessment(response);
      review.status = "completed";
    } catch (error) {
      if (isTrialPersistenceFailure(error)) throw error;
      review.status = "failed";
    } finally {
      await this.cleanupAdvisoryWorkspace(workspace);
    }
  }

  private async runAdvisory(): Promise<void> {
    const host = this.options.advisoryHost;
    if (!host) return;
    const review = defaultAdvisoryReview(host);
    this.advisoryReview = review;
    if (this.execution !== "completed" || this.options.signal?.aborted) return;
    await this.executeAdvisoryReview(host, review);
  }

  private async retainRawCandidate(): Promise<void> {
    await verifyRetainedArtifacts(this.trialArtifactRefs);
    const message = this.hostResult?.finalMessage;
    if (message == null) {
      this.rawPath = null;
      return;
    }
    this.rawPath = join(this.context.runDir, `trial-${this.trial}-raw.txt`);
    await this.writeTrialFile(this.rawPath, message);
  }

  private trialEvidenceRecord(): RunEvidenceData["trials"][number] {
    return {
      caseId: this.options.case.id,
      trial: this.trial,
      executionMode: this.options.dry ? "dry" : "executed",
      candidateDurationMs: this.candidateDurationMs,
      condition: {
        requested: this.options.condition,
        actual: this.hostResult?.actualCondition ?? "unknown",
        appliedInstrumentation: this.appliedInstrumentation,
      },
      observationCompleteness: this.completeness,
      observations: this.trialObservations(),
      metrics: this.extensionMetrics,
      domainOutcomes: this.domainOutcomes,
      taskVerdictPolicy: selectedTrialTaskPolicy(
        this.options,
        this.taskPolicyRecommendation,
      ),
      advisoryReview: this.advisoryReview,
      routes: this.context.routes,
      usage: usage(this.hostResult),
      rawResult: {
        source: this.options.host.id,
        path: this.rawPath ? pathToFileURL(this.rawPath).href : null,
        sha256: this.rawDigest,
      },
      artifactRefs: this.trialArtifactRefs,
    };
  }

  private async persistTrial(): Promise<boolean> {
    const evidence = this.trialEvidenceRecord();
    const artifactPath = join(this.context.runDir, `trial-${this.trial}.json`);
    const trialSummary: TrialSummary = {
      trial: this.trial,
      ...this.assessment,
      checks: this.checks,
      domainOutcomes: this.domainOutcomes,
      artifactPath,
    };
    try {
      await atomicWriteJson(artifactPath, {
        format: "sevro.trial-evidence.v1",
        caseId: this.options.case.id,
        trial: this.trial,
        result: trialSummary,
        evidence,
      });
    } catch {
      throw new Error(
        `trial persistence failed; fixture retained at ${this.fixture.workspace}`,
      );
    }
    this.persisted = true;
    this.context.trialSummaries.push(trialSummary);
    this.context.trialSummaries.sort((left, right) => left.trial - right.trial);
    this.context.trialEvidence.push(evidence);
    this.context.trialEvidence.sort((left, right) => left.trial - right.trial);
    if (this.diagnostic)
      this.context.diagnostics.push({
        trial: this.trial,
        diagnostic: this.diagnostic,
      });
    checkpointEvaluation(this.context, "active");
    return !(
      (this.execution !== "completed" && this.execution !== "not_run") ||
      this.graderError
    );
  }
  private async cleanup(): Promise<void> {
    if (this.candidateTranscriptRoot)
      await rm(this.candidateTranscriptRoot, { recursive: true, force: true });
    if (this.persisted) {
      try {
        await clearFixtureContents(this.fixture.workspace);
        this.context.retainedWorkspaces.delete(this.fixture.reservation);
      } catch {
        console.warn(
          `fixture cleanup failed; retained at ${this.fixture.workspace}`,
        );
      }
    }
  }
}
export async function executeEvaluationTrials(
  options: EvaluationOptions,
  context: EvaluationContext,
): Promise<void> {
  await scheduleTrials(
    { count: options.trialCount, jobs: context.jobs, signal: options.signal },
    async (trial, stopAdmission) => {
      const fixture = await prepareTrialWorkspace(options, context, trial);
      return new EvaluationTrial(
        options,
        context,
        trial,
        stopAdmission,
        fixture,
      ).run();
    },
  );
}
