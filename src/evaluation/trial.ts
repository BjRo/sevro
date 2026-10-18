import { rm } from "node:fs/promises";
import { hashJson } from "../identity";
import {
  allocateCandidateRuntime,
  candidateArtifactRoots,
  releaseCandidateRuntime,
  type CandidateArtifactRoots,
} from "../candidate-artifacts";
import { join } from "node:path";
import { advisoryBaseRevision } from "../fixtures/advisory";
import type { EvaluationContext } from "./context";
import { prepareTrialWorkspace } from "./resources";
import type { PreparedFixture, PreparedInvocation } from "./plan";
import { hostArtifacts, hostObservations } from "../evidence/host-results";
import {
  TrialEvidenceWriter,
  type TrialObservation,
} from "../evidence/trial-writer";
import { usage } from "../evidence/usage";
import { runAdvisoryReview, type AdvisoryReview } from "./advisory";
import {
  gradeCandidateOutput,
  gradeShellChecks,
  gradeGitHeadChecks,
  gradeExtensionChecks,
  type GradingFailure,
} from "./grading";
import { gradeSemanticChecks } from "./semantic";
import {
  HostExecutionFailure,
  type EvaluationOptions,
  type HostAdapter,
  type HostResult,
} from "./types";
import type { EvaluationResult } from "../extension-session";
import type {
  Diagnostic,
  ExecutionStatus,
  ObservationCompleteness,
  TaskVerdict,
} from "../contract-types";
import {
  clearFixtureContents,
  removeDisposableDirectory,
} from "../fixtures/cleanup";
import { retainWorkspace } from "../fixtures/workspace-state";
import { gitHeadRevision } from "../graders/git-head";
import {
  InstrumentationEvidenceError,
  snapshotInstrumentation,
  verifyAppliedInstrumentation,
  type InstrumentationRequest,
} from "../instrumentation";
import { materializeNativeTranscriptView } from "../native-transcript-view";
import {
  applyTaskVerdictPolicy,
  assessTrial,
  type Assessment,
  type CheckOutcome,
} from "../results";
import type { RunEvidenceDataTrialEvidence } from "../schema-types";
import { scheduleTrials } from "./scheduler";
import { rethrowDiagnosticPersistenceError } from "../host-diagnostics";
import { evaluationProgress } from "./progress";

const MAX_FINAL_MESSAGE_BYTES = 8 * 1024 * 1024;

function candidateMarketplaceRequest(
  invocation: PreparedInvocation,
  artifacts: PreparedFixture["inlineArtifacts"],
) {
  const marketplace = invocation.codexMarketplace;
  if (!marketplace) return {};
  return {
    codexMarketplace: {
      ...marketplace,
      artifactPaths: artifacts
        .filter((artifact) =>
          artifact.relativePath.startsWith(`${marketplace.artifactRoot}/`),
        )
        .map((artifact) => artifact.relativePath),
    },
  };
}

function candidatePluginDirectoriesRequest(
  invocation: PreparedInvocation,
  artifacts: PreparedFixture["inlineArtifacts"],
) {
  const directories = invocation.claudePluginDirs;
  if (!directories) return {};
  return {
    claudePluginDirs: {
      ...directories,
      artifactPaths: artifacts
        .filter((artifact) =>
          directories.artifactRoots.some((root) =>
            artifact.relativePath.startsWith(`${root}/`),
          ),
        )
        .map((artifact) => artifact.relativePath),
    },
  };
}

function candidateInvocationRequest(invocation: PreparedInvocation) {
  if (
    invocation.invocation === undefined ||
    invocation.invocationToken === null
  )
    return {};
  return {
    explicitSkillInvocation: {
      ...invocation.invocation,
      token: invocation.invocationToken,
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
  if (error instanceof HostExecutionFailure)
    return { code: "sevro.host.failed", message: error.message };
  return {
    code: "sevro.host.failed",
    message: "host execution did not complete",
  };
}

function extensionFinalMessageData(result: HostResult | null) {
  return result?.finalMessage == null ? {} : { text: result.finalMessage };
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
  recommendation: TaskVerdict | null,
) {
  const id = options.extension?.session.identity.selectedTaskVerdictPolicy;
  return id ? { id, recommendation } : null;
}

interface TrialRuntimeState {
  candidateTranscriptRoot?: string;
  candidateRuntimeRoot?: string;
  candidateArtifacts?: CandidateArtifactRoots;
  diagnostic: Diagnostic | undefined;
  persisted: boolean;
  gitHeadBase: string | null;
  advisoryRevision: string | null;
  hostResult: HostResult | null;
  appliedInstrumentation: InstrumentationRequest[];
  additionalObservations: ReturnType<typeof hostObservations>;
  producedArtifacts: ReturnType<typeof hostArtifacts>;
  execution: ExecutionStatus;
  candidateDurationMs: number | null;
  completeness: ObservationCompleteness;
  observation: TrialObservation;
  shellObservations: TrialObservation[];
  gitHeadObservations: TrialObservation[];
  semanticObservations: TrialObservation[];
  checks: CheckOutcome[];
  extensionMetrics: EvaluationResult["metrics"];
  domainOutcomes: NonNullable<EvaluationResult["domainOutcomes"]>;
  taskPolicyRecommendation: TaskVerdict | null;
  graderError: boolean;
  assessment: Assessment;
  advisoryReview: AdvisoryReview | null;
  retainedAuxiliaryWorkspaces: string[];
}

function initialTrialState(dry: boolean | undefined): TrialRuntimeState {
  return {
    diagnostic: undefined,
    persisted: false,
    gitHeadBase: null,
    advisoryRevision: null,
    hostResult: null,
    appliedInstrumentation: [],
    additionalObservations: [],
    producedArtifacts: [],
    execution: dry ? "not_run" : "completed",
    candidateDurationMs: null,
    completeness: "unavailable",
    observation: {
      id: "sevro.observation.final-message",
      source: "",
      completeness: "unavailable",
      data: {},
    },
    shellObservations: [],
    gitHeadObservations: [],
    semanticObservations: [],
    checks: [],
    extensionMetrics: [],
    domainOutcomes: [],
    taskPolicyRecommendation: null,
    graderError: false,
    assessment: {
      execution: { status: "not_run" },
      grading: { status: "not_requested" },
      task: { verdict: "not_assessed" },
    },
    advisoryReview: null,
    retainedAuxiliaryWorkspaces: [],
  };
}

class EvaluationTrial {
  private readonly state: TrialRuntimeState;
  private readonly evidence: TrialEvidenceWriter;
  constructor(
    private readonly options: EvaluationOptions,
    private readonly context: EvaluationContext,
    private readonly trial: number,
    private readonly stopAdmission: () => void,
    private readonly fixture: Awaited<ReturnType<typeof prepareTrialWorkspace>>,
  ) {
    this.state = initialTrialState(options.dry);
    this.state.candidateRuntimeRoot = fixture.candidateRuntimeRoot;
    this.evidence = new TrialEvidenceWriter({
      runDir: context.resources.runDir,
      trial,
      workspace: fixture.workspace,
      preparationArtifacts: context.preparationArtifacts,
    });
  }
  async run(): Promise<boolean> {
    try {
      if (this.fixture.preparationCancelled)
        return await this.cancelPreparation();
      await this.initializeGradingBases();
      await this.runCandidate();
      await this.retainCandidateArtifacts();
      this.observeCandidate();
      await this.prepareCandidateArtifacts();
      this.progress(
        "grading",
        this.state.execution === "completed" ? "started" : "skipped",
      );
      this.gradeOutput();
      await this.gradeShell();
      await this.gradeGitHead();
      await this.gradeSemantic();
      await this.gradeExtension();
      this.assess();
      if (this.state.execution === "completed")
        this.progress("grading", "completed");
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
    this.state.gitHeadBase = this.context.prepared.checks.preparedGitHead.length
      ? await gitHeadRevision(this.fixture.workspace, this.options.signal)
      : null;
    this.state.advisoryRevision = this.options.advisoryHost
      ? await advisoryBaseRevision(this.fixture.workspace)
      : null;
  }
  private candidateRequest(): Parameters<HostAdapter["run"]>[0] {
    return {
      retainHostDiagnostics: (bytes) =>
        this.evidence.retainArtifacts(
          [{ id: "sevro.host.diagnostics", bytes: Buffer.from(bytes) }],
          "host-",
        ),
      candidateRuntimeRoot: this.state.candidateRuntimeRoot,
      prompt: this.fixture.trialPrompt,
      ...(this.fixture.trialFollowUpPrompt !== undefined
        ? { followUpPrompt: this.fixture.trialFollowUpPrompt }
        : {}),
      workspace: this.fixture.workspace,
      condition: this.options.condition,
      fixtureBinDir: this.fixture.fixtureBinDir,
      runtimePolicy: this.candidateRuntimePolicy(),
      instrumentation: snapshotInstrumentation(
        this.context.prepared.requestedInstrumentation,
      ),
      ...candidateMarketplaceRequest(
        this.context.prepared.invocation,
        this.context.prepared.fixture.inlineArtifacts,
      ),
      ...candidatePluginDirectoriesRequest(
        this.context.prepared.invocation,
        this.context.prepared.fixture.inlineArtifacts,
      ),
      ...candidateInvocationRequest(this.context.prepared.invocation),
      signal: this.options.signal,
    };
  }

  private candidateRuntimePolicy() {
    if (this.options.runtimePolicy) return this.options.runtimePolicy;
    if (!this.context.prepared.fixture.fixtureSetup) return undefined;
    return {
      format: "sevro.runtime.v1" as const,
      environment: {},
      readOnlyRoots: [],
    };
  }

  private candidateReservedIds(): Set<string> {
    return new Set([
      "sevro.observation.final-message",
      "sevro.observation.workspaces",
      ...this.context.preparationArtifacts.map((item) => item.id),
      ...this.state.additionalObservations.map((item) => item.id),
      ...this.options.case.checks.map((item) => item.id),
      ...this.context.prepared.checks.preparedShell.map(
        (item) => `sevro.observation.shell.${item.id}`,
      ),
      ...(this.context.prepared.checks.preparedGitHead.length
        ? ["sevro.observation.git-head"]
        : []),
      ...(this.context.prepared.checks.preparedSemantic.length
        ? ["sevro.semantic.verdicts"]
        : []),
    ]);
  }

  private acceptCandidateResult(response: HostResult): void {
    this.state.appliedInstrumentation = verifyAppliedInstrumentation(
      this.context.prepared.requestedInstrumentation,
      response.appliedInstrumentation,
      this.options.condition,
      response.actualCondition,
    );
    if (
      response.finalMessage !== null &&
      Buffer.byteLength(response.finalMessage, "utf8") > MAX_FINAL_MESSAGE_BYTES
    )
      throw new Error("oversized host result");
    this.state.additionalObservations = hostObservations(
      response,
      this.options.host.id,
      new Set([
        ...this.context.preparationArtifacts.map((item) => item.id),
        ...this.options.case.checks.map((item) => item.id),
      ]),
    );
    this.state.producedArtifacts = hostArtifacts(
      response,
      this.candidateReservedIds(),
    );
    if (response.executionFailed) {
      this.state.execution = "failed";
      this.stopAdmission();
      this.state.diagnostic = {
        code: "sevro.host.failed",
        message: response.failureMessage ?? "host execution did not complete",
      };
    }
  }

  private failCandidate(error: unknown): void {
    this.stopAdmission();
    this.state.hostResult =
      error instanceof HostExecutionFailure ? error.result : null;
    if (this.state.hostResult)
      this.acceptCandidateResult(this.state.hostResult);
    this.state.execution = this.options.signal?.aborted
      ? "cancelled"
      : "failed";
    this.state.diagnostic = hostFailureDiagnostic(this.state.execution, error);
  }

  private async runCandidate(): Promise<void> {
    if (this.options.dry) {
      this.progress("candidate", "skipped");
      return;
    }
    this.progress("candidate", "started");
    const started = performance.now();
    try {
      ensureNotCancelled(this.options.signal);
      this.state.hostResult = await this.options.host.run(
        this.candidateRequest(),
      );
      this.acceptCandidateResult(this.state.hostResult);
      if (this.options.signal?.aborted) {
        this.state.execution = "cancelled";
        this.stopAdmission();
        this.state.diagnostic = hostFailureDiagnostic("cancelled", undefined);
      }
    } catch (error) {
      rethrowDiagnosticPersistenceError(error);
      this.failCandidate(error);
    } finally {
      this.state.candidateDurationMs = Math.max(0, performance.now() - started);
      this.progress("candidate", "completed");
    }
  }

  private async retainCandidateArtifacts(): Promise<void> {
    await this.evidence.retainArtifacts(this.state.producedArtifacts, "host-");
    await this.evidence.verifyArtifacts();
    const bundle = this.state.producedArtifacts.find(
      (item) => item.id === "sevro.native-transcripts.bundle",
    );
    if (this.options.runtimePolicy?.nativeTranscripts && bundle)
      this.state.candidateTranscriptRoot =
        await materializeNativeTranscriptView(bundle.bytes);
  }

  private observeCandidate(): void {
    this.state.observation = this.evidence.observeCandidate(
      this.options.host.id,
      this.state.hostResult,
    );
    this.state.completeness = this.state.observation.completeness;
  }

  private failGrading(message: string, cancelable = true): void {
    if (cancelable && this.options.signal?.aborted) {
      this.state.execution = "cancelled";
      this.state.diagnostic = {
        code: "sevro.run.cancelled",
        message: "run cancelled",
      };
      return;
    }
    this.state.graderError = true;
    this.state.diagnostic = { code: "sevro.grader.error", message };
    this.stopAdmission();
  }

  private canGrade(): boolean {
    return this.state.execution === "completed" && !this.state.graderError;
  }

  private async prepareCandidateArtifacts(): Promise<void> {
    if (this.state.execution !== "completed") return;
    try {
      this.state.candidateArtifacts = await candidateArtifactRoots(
        this.state.candidateRuntimeRoot,
      );
    } catch {
      this.failGrading("candidate artifact directories are missing or unsafe");
    }
  }

  private acceptGradingFailure(failure: GradingFailure | null): void {
    if (failure) this.failGrading(failure.message, failure.cancelable);
  }

  private gradingFailureEffects() {
    return {
      onFailure: (failure: GradingFailure) => {
        this.acceptGradingFailure(failure);
      },
    };
  }

  private gradeOutput(): void {
    if (this.state.execution !== "completed") return;
    const graded = gradeCandidateOutput({
      result: this.state.hostResult,
      checks: this.context.prepared.checks.prepared,
      evidenceRefs: this.evidence.hasCandidateMessage
        ? [this.state.observation.id]
        : [],
    });
    this.state.checks = graded.checks;
    this.acceptGradingFailure(graded.failure);
  }

  private shellRootRequest() {
    const isolation = this.options.shellIsolation;
    if (!isolation) return null;
    return {
      workspace: this.fixture.workspace,
      projectRoot: this.context.prepared.fixture.projectRoot,
      resultsRoot: this.options.resultsRoot,
      additionalRoots: [
        ...isolation.protectedRoots,
        ...(this.options.preparationSources
          ? [this.options.preparationSources.root]
          : []),
        ...(this.context.prepared.fixture.repository
          ? [this.context.prepared.fixture.repository.path]
          : []),
        this.context.resources.runStateRoot,
      ],
    };
  }

  private async gradeShell(): Promise<void> {
    if (
      !this.canGrade() ||
      this.context.prepared.checks.preparedShell.length === 0
    )
      return;
    const graded = await gradeShellChecks(
      {
        checks: this.context.prepared.checks.preparedShell,
        protectedRoots: this.shellRootRequest(),
        execution: {
          candidateTranscriptRoot: this.state.candidateTranscriptRoot,
          candidateArtifactRoots: this.state.candidateArtifacts,
          workspace: this.fixture.workspace,
          fixtureBinDir: this.fixture.fixtureBinDir,
          toolchainBinDir: this.options.shellIsolation?.toolchainBinDir,
          runtimePolicy: this.options.runtimePolicy,
          uvRuntimeCache: this.options.shellIsolation?.uvRuntimeCache,
          privateStateRoot: join(
            this.context.resources.stateDir,
            "shell-sandbox",
          ),
          signal: this.options.signal,
        },
      },
      this.gradingFailureEffects(),
    );
    this.state.shellObservations.push(...graded.observations);
    this.state.checks.push(...graded.checks);
  }

  private async gradeGitHead(): Promise<void> {
    if (
      !this.canGrade() ||
      this.context.prepared.checks.preparedGitHead.length === 0
    )
      return;
    const graded = await gradeGitHeadChecks(
      {
        checks: this.context.prepared.checks.preparedGitHead,
        base: this.state.gitHeadBase,
        workspace: this.fixture.workspace,
        signal: this.options.signal,
      },
      this.gradingFailureEffects(),
    );
    this.state.gitHeadObservations.push(...graded.observations);
    this.state.checks.push(...graded.checks);
  }

  private completeCandidateMessage(): string | null {
    const result = this.state.hostResult;
    if (result?.finalMessage == null || !result.complete) return null;
    return result.finalMessage;
  }

  private async gradeSemantic(): Promise<void> {
    if (!this.canGrade()) return;
    const graded = await gradeSemanticChecks(
      {
        checks: this.context.prepared.checks.preparedSemantic,
        declaredChecks: this.options.case.checks,
        host: this.options.semanticHost,
        message: this.completeCandidateMessage(),
        candidateWorkspace: this.fixture.workspace,
        candidateTranscriptRoot: this.state.candidateTranscriptRoot,
        candidateArtifactRoots: this.state.candidateArtifacts,
        projectRoot: this.context.prepared.fixture.projectRoot,
        reservedWorkspace: this.context.resources.workspaces.semantic(
          this.trial,
        ),
        runtimePolicy: this.options.runtimePolicy,
        signal: this.options.signal,
      },
      {
        evidence: this.evidence,
        ...this.gradingFailureEffects(),
        retainWorkspace: (workspace) =>
          this.retainAuxiliaryWorkspace(workspace),
      },
    );
    this.state.semanticObservations.push(...graded.observations);
    this.state.checks.push(...graded.checks);
  }

  private trialObservations(): TrialObservation[] {
    return [
      this.state.observation,
      ...this.state.shellObservations,
      ...this.state.gitHeadObservations,
      ...this.state.semanticObservations,
      ...this.state.additionalObservations,
      {
        id: "sevro.observation.workspaces",
        source: "sevro.runner",
        completeness: "complete",
        data: {
          candidate: this.fixture.workspace,
          retainedAuxiliary: this.state.retainedAuxiliaryWorkspaces,
        },
      },
    ];
  }

  private extensionEvaluationRequest(): Parameters<
    NonNullable<EvaluationOptions["extension"]>["session"]["evaluate"]
  >[0] {
    return {
      caseId: this.options.case.id,
      execution: { status: this.state.execution },
      observations: this.trialObservations().map((observation) =>
        observation === this.state.observation
          ? {
              ...observation,
              completeness: this.state.completeness,
              data: {
                ...observation.data,
                ...extensionFinalMessageData(this.state.hostResult),
              },
            }
          : observation,
      ),
      builtinChecks: this.state.checks.map((check) => ({
        id: check.id,
        status: check.status,
        ...(check.detail ? { detail: check.detail } : {}),
        evidenceRefs: check.evidenceRefs ?? [],
      })),
      artifacts: this.evidence.artifactRefs,
      extensionData: this.context.prepared.extensionData,
    };
  }

  private async gradeExtension(): Promise<void> {
    const extension = this.options.extension;
    if (!extension || !this.canGrade()) return;
    const graded = await gradeExtensionChecks(
      {
        evaluate: (request) => extension.session.evaluate(request),
        request: this.extensionEvaluationRequest(),
        declarations: this.context.prepared.checks.extensionDeclarations,
      },
      this.gradingFailureEffects(),
    );
    this.state.checks.push(...graded.checks);
    this.state.extensionMetrics = graded.metrics;
    this.state.domainOutcomes = graded.domainOutcomes;
    this.state.taskPolicyRecommendation = graded.recommendation;
  }

  private assess(): void {
    const declaredOrder = new Map(
      this.options.case.checks.map((check, index) => [check.id, index]),
    );
    this.state.checks.sort((left, right) =>
      compareDeclaredChecks(left, right, declaredOrder),
    );
    const defaultAssessment = assessTrial({
      execution: this.state.execution,
      declaredChecks: this.options.case.checks
        .filter(
          (check) => !this.context.prepared.checks.replaced.has(check.grader),
        )
        .map((check) => check.id),
      checks: this.state.checks,
      graderError: this.state.graderError,
      requiredEvidenceUnavailable: this.options.case.requiredEvidence.some(
        (id) =>
          !this.state.producedArtifacts.some((item) => item.id === id) &&
          !this.trialObservations().some(
            (item) => item.id === id && item.completeness === "complete",
          ),
      ),
    });
    this.state.assessment = applyTaskVerdictPolicy(
      defaultAssessment,
      this.state.taskPolicyRecommendation,
      Boolean(
        this.options.extension?.session.identity.selectedTaskVerdictPolicy,
      ),
    );
  }
  private retainAuxiliaryWorkspace(workspace: string): Promise<void> {
    this.state.retainedAuxiliaryWorkspaces.push(workspace);
    this.context.resources.workspaces.retain(workspace);
    return retainWorkspace(workspace);
  }

  private async runAdvisory(): Promise<void> {
    const host = this.options.advisoryHost;
    if (!host) return;
    this.state.advisoryReview = await runAdvisoryReview(
      {
        host,
        candidateCompleted: this.state.execution === "completed",
        candidateWorkspace: this.fixture.workspace,
        candidateTranscriptRoot: this.state.candidateTranscriptRoot,
        candidateArtifactRoots: this.state.candidateArtifacts,
        baseRevision: this.state.advisoryRevision,
        excludedPaths: this.options.advisoryExcludedPaths,
        task: this.fixture.trialPrompt,
        checks: this.state.checks,
        declaredChecks: this.options.case.checks,
        runtimePolicy: this.options.runtimePolicy,
        signal: this.options.signal,
      },
      {
        evidence: this.evidence,
        retainWorkspace: (workspace) =>
          this.retainAuxiliaryWorkspace(workspace),
      },
    );
  }

  private retainRawCandidate(): Promise<void> {
    return this.evidence.retainRawCandidate(
      this.state.hostResult?.finalMessage,
    );
  }

  private trialEvidenceRecord(): RunEvidenceDataTrialEvidence {
    return {
      caseId: this.options.case.id,
      trial: this.trial,
      executionMode: this.options.dry ? "dry" : "executed",
      candidateDurationMs: this.state.candidateDurationMs,
      condition: {
        requested: this.options.condition,
        actual: this.state.hostResult?.actualCondition ?? "unknown",
        appliedInstrumentation: this.state.appliedInstrumentation,
      },
      observationCompleteness: this.state.completeness,
      observations: this.trialObservations(),
      metrics: this.state.extensionMetrics,
      domainOutcomes: this.state.domainOutcomes,
      taskVerdictPolicy: selectedTrialTaskPolicy(
        this.options,
        this.state.taskPolicyRecommendation,
      ),
      advisoryReview: this.state.advisoryReview,
      routes: this.context.prepared.routes,
      usage: usage(this.state.hostResult),
      rawResult: this.evidence.candidateRawResult(this.options.host.id),
      artifactRefs: this.evidence.artifactRefs,
    };
  }

  private async persistTrial(): Promise<boolean> {
    const evidence = this.trialEvidenceRecord();
    this.progress("evidence", "started");
    const trialSummary = await this.evidence.persistTrial(
      this.options.case.id,
      this.state.assessment,
      this.state.checks,
      this.state.domainOutcomes,
      evidence,
    );
    this.state.persisted = true;
    this.state.diagnostic = this.evidence.diagnosticLocation(
      this.state.diagnostic,
    );
    this.context.results.complete({
      summary: trialSummary,
      evidence,
      diagnostic: this.state.diagnostic,
    });
    this.progress("evidence", "completed");
    return !(
      (this.state.execution !== "completed" &&
        this.state.execution !== "not_run") ||
      this.state.graderError
    );
  }
  private progress(
    stage: "candidate" | "grading" | "evidence",
    status: "started" | "completed" | "skipped",
  ): void {
    evaluationProgress(this.options, stage, status, this.trial);
  }
  private async cleanup(): Promise<void> {
    await removeDisposableDirectory(
      join(
        this.context.resources.stateDir,
        "shell-sandbox/runtime",
        hashJson(this.fixture.workspace),
      ),
    );
    if (this.state.candidateTranscriptRoot)
      await rm(this.state.candidateTranscriptRoot, {
        recursive: true,
        force: true,
      });
    if (this.state.persisted && !this.retainFailedWorkspace()) {
      try {
        await clearFixtureContents(this.fixture.workspace);
        this.context.resources.workspaces.completed(this.fixture.reservation);
      } catch {
        console.warn(
          `fixture cleanup failed; retained at ${this.fixture.workspace}`,
        );
      }
    }
  }
  private retainFailedWorkspace(): boolean {
    return (
      this.state.execution === "failed" ||
      this.state.execution === "cancelled" ||
      this.state.graderError ||
      this.state.assessment.grading.status === "unavailable" ||
      this.state.assessment.task.verdict === "failed"
    );
  }
}
export async function executeEvaluationTrials(
  options: EvaluationOptions,
  context: EvaluationContext,
): Promise<void> {
  await scheduleTrials(
    {
      count: options.trialCount,
      jobs: context.prepared.jobs,
      signal: options.signal,
    },
    async (trial, stopAdmission) => {
      const candidateRuntimeRoot = await allocateCandidateRuntime(
        options.runtimePolicy,
        Boolean(context.prepared.fixture.fixtureSetup),
      );
      try {
        const fixture = await prepareTrialWorkspace(
          options,
          context.prepared.fixture,
          context.prepared.invocation,
          context.resources.workspaces,
          trial,
          candidateRuntimeRoot,
        );
        evaluationProgress(options, "preparation", "completed", trial);
        return await new EvaluationTrial(
          options,
          context,
          trial,
          stopAdmission,
          fixture,
        ).run();
      } finally {
        await releaseCandidateRuntime(candidateRuntimeRoot);
      }
    },
  );
}
