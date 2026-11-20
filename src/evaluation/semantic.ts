import { clearWorkspaceContents } from "../workspace/index";
import type { CandidateArtifactRoots, RuntimePolicy } from "../runtime/index";
import { materializeFixture } from "../fixtures/index";
import {
  usage,
  type TrialEvidenceWriter,
  type TrialObservation,
} from "../evidence/index";
import type { HostAdapter, HostResult } from "../host-contract/index";
import { runJudgeRequest, type JudgeOutcome } from "./judge-request";
import {
  readSemanticArtifact,
  parseSemanticVerdicts,
  semanticCheckGroups,
  semanticPrompt,
  type PreparedSemanticCheck,
  type SemanticVerdict,
} from "../graders/index";
import { sha256, type CheckOutcome } from "../kernel/index";
import type { GradingFailure, GradingResult } from "./grading";

interface SemanticGradingInput {
  readonly checks: readonly PreparedSemanticCheck[];
  readonly declaredChecks: readonly { id: string }[];
  readonly host: HostAdapter | undefined;
  readonly message: string | null;
  readonly candidateWorkspace: string;
  readonly candidateTranscriptRoot?: string;
  readonly candidateArtifactRoots?: CandidateArtifactRoots;
  readonly projectRoot: string;
  readonly reservedWorkspace?: string;
  readonly runtimePolicy?: RuntimePolicy;
  readonly signal?: AbortSignal;
}
interface SemanticGradingEffects {
  readonly evidence: Pick<
    TrialEvidenceWriter,
    "artifactRefs" | "retainArtifacts" | "retainSemanticVerdicts"
  >;
  /** Close admission at detection, before retaining or cleaning auxiliary state. */
  onFailure(failure: GradingFailure): void;
  retainWorkspace(workspace: string): Promise<void>;
}
type SemanticGroup = ReturnType<typeof semanticCheckGroups>[number];

type SemanticInputArtifact = Awaited<
  ReturnType<typeof readSemanticArtifact>
> | null;

function semanticGroupSuffix(pattern: string | undefined): string {
  return pattern === undefined ? "" : "." + sha256(pattern);
}

function semanticSource(
  artifact: SemanticInputArtifact,
): Record<string, unknown> {
  return artifact
    ? {
        kind: "artifact",
        path: artifact.path,
        sha256: sha256(artifact.content),
      }
    : { kind: "response" };
}

function semanticHostPrompt(
  message: string,
  checks: SemanticGroup,
  artifact: SemanticInputArtifact,
): string {
  return semanticPrompt(
    artifact?.content ?? message,
    checks,
    artifact ? "document" : "response",
  );
}
class SemanticGrading {
  private observations: TrialObservation[] = [];
  private checks: CheckOutcome[] = [];
  private failure: GradingFailure | null = null;
  constructor(
    private readonly input: SemanticGradingInput,
    private readonly effects: SemanticGradingEffects,
  ) {}
  async run(): Promise<GradingResult> {
    for (const group of semanticCheckGroups([...this.input.checks]))
      await this.gradeSemanticGroup(group);
    return {
      checks: this.checks,
      observations: this.observations,
      failure: this.failure,
    };
  }
  private failGrading(message: string, cancelable = true): void {
    this.failure = { message, cancelable };
    this.effects.onFailure(this.failure);
  }
  private async semanticInput(
    pattern: string | undefined,
  ): Promise<SemanticInputArtifact> {
    return pattern === undefined
      ? null
      : readSemanticArtifact(this.input.candidateWorkspace, pattern);
  }

  private async semanticWorkspace(): Promise<string> {
    return materializeFixture(
      { kind: "inline", files: {} },
      {
        projectRoot: this.input.projectRoot,
        signal: this.input.signal,
        reservedWorkspace: this.input.reservedWorkspace,
      },
    );
  }

  private recordSemanticVerdict(
    verdict: SemanticVerdict,
    pattern: string | undefined,
    source: Record<string, unknown>,
    hostId: string,
  ): void {
    const id = `sevro.observation.semantic.${sha256(verdict.id)}`;
    this.observations.push({
      id,
      source: hostId,
      completeness: "complete",
      data: {
        verdict: verdict.verdict,
        reason: verdict.reason,
        ...(pattern === undefined ? {} : { source }),
      },
    });
    this.checks.push({
      id: verdict.id,
      grader: "sevro.semantic",
      status: verdict.verdict === "pass" ? "passed" : "failed",
      detail: verdict.reason,
      evidenceRefs: [id],
    });
  }

  private unavailableGroup(group: SemanticGroup): void {
    this.checks.push(
      ...group.map((check) => ({
        id: check.id,
        grader: "sevro.semantic",
        status: "unavailable" as const,
        evidenceRefs: [],
      })),
    );
  }

  private async gradeSemanticGroup(group: SemanticGroup): Promise<void> {
    if (this.failure) return;
    const message = this.input.message;
    if (message === null) {
      this.unavailableGroup(group);
      return;
    }
    const host = this.input.host;
    if (!host) {
      // Unavailable judges still leave an auxiliary workspace for diagnosis.
      await this.effects.retainWorkspace(await this.semanticWorkspace());
      this.failGrading("semantic grading did not complete");
      return;
    }
    const pattern = group[0].artifactPath;
    const judged = await this.judgeGroup(host, group, pattern, message);
    this.recordJudgeOutcome(judged.outcome, pattern, judged.source, host.id);
  }

  private async judgeGroup(
    host: HostAdapter,
    group: SemanticGroup,
    pattern: string | undefined,
    message: string,
  ) {
    const suffix = semanticGroupSuffix(pattern);
    let source: Record<string, unknown> = { kind: "response" };
    const outcome = await runJudgeRequest(
      {
        host,
        role: "semantic",
        artifactPrefix: `sevro.semantic${suffix}.`,
        responseId: `sevro.semantic.verdicts${suffix}`,
        declaredChecks: this.input.declaredChecks,
        runtimePolicy: this.input.runtimePolicy,
        responseOnly: pattern === undefined,
        candidateTranscriptRoot: this.input.candidateTranscriptRoot,
        candidateArtifactRoots: this.input.candidateArtifactRoots,
        signal: this.input.signal,
        createWorkspace: () => this.semanticWorkspace(),
        disposeWorkspace: (workspace) => clearWorkspaceContents(workspace),
        prompt: async () => {
          const artifact = await this.semanticInput(pattern);
          source = semanticSource(artifact);
          return semanticHostPrompt(message, group, artifact);
        },
        parse: (text) => parseSemanticVerdicts(text, group),
      },
      {
        evidence: this.effects.evidence,
        retainResponse: async (_hostId, text) => {
          await this.effects.evidence.retainSemanticVerdicts(text, suffix);
        },
        retainWorkspace: (workspace) => this.effects.retainWorkspace(workspace),
      },
    );
    return { outcome, source };
  }

  private recordJudgeOutcome(
    outcome: JudgeOutcome<SemanticVerdict[]>,
    pattern: string | undefined,
    source: Record<string, unknown>,
    hostId: string,
  ): void {
    if (outcome.response)
      this.recordUsage(outcome.response, semanticGroupSuffix(pattern), hostId);
    if (outcome.status === "answered") {
      for (const verdict of outcome.answer)
        this.recordSemanticVerdict(verdict, pattern, source, hostId);
      return;
    }
    this.failJudgeRequest(outcome.response);
  }

  /** Without a judge result the failure stays cancelable, as before any answer. */
  private failJudgeRequest(response: HostResult | null): void {
    if (response === null) {
      this.failGrading("semantic grading did not complete");
      return;
    }
    this.failGrading(
      response.failureMessage ?? "semantic grading did not complete",
      response.processFailure?.reason === "cancelled",
    );
  }

  private recordUsage(response: HostResult, suffix: string, hostId: string) {
    this.observations.push({
      id: `sevro.observation.semantic.usage${suffix}`,
      source: hostId,
      completeness: response.usageComplete ? "complete" : "partial",
      data: usage(response),
    });
  }
}
export async function gradeSemanticChecks(
  input: SemanticGradingInput,
  effects: SemanticGradingEffects,
) {
  return new SemanticGrading(input, effects).run();
}
