import { clearFixtureContents } from "../fixtures/cleanup";
import type { CandidateArtifactRoots } from "../candidate-artifacts";
import { createFixture } from "../fixtures/create";
import { hostArtifacts } from "../evidence/host-results";
import { usage } from "../evidence/usage";
import { gradingRuntimePolicy, scopedHostArtifacts } from "./grading-host";
import {
  HostExecutionFailure,
  type HostAdapter,
  type HostResult,
} from "./types";
import { readSemanticArtifact } from "../graders/artifact";
import {
  parseSemanticVerdicts,
  semanticCheckGroups,
  semanticPrompt,
  type PreparedSemanticCheck,
  type SemanticVerdict,
} from "../graders/semantic";
import { sha256 } from "../identity";
import type { CheckOutcome } from "../results";
import type {
  TrialEvidenceWriter,
  TrialObservation,
} from "../evidence/trial-writer";
import type { GradingFailure, GradingResult } from "./grading";
import type { RuntimePolicy } from "../runtime/config";
import { HostDiagnosticPersistenceError } from "../host-diagnostics";

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

type SemanticHostOutcome =
  | {
      result: HostResult;
      artifacts: ReturnType<typeof hostArtifacts>;
      source: Record<string, unknown>;
      hostId: string;
    }
  | {
      result: null;
      artifacts: ReturnType<typeof hostArtifacts>;
      source: Record<string, unknown>;
      hostId: null;
    };

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
    return createFixture(
      { kind: "inline", files: {} },
      {
        projectRoot: this.input.projectRoot,
        signal: this.input.signal,
        reservedWorkspace: this.input.reservedWorkspace,
      },
    );
  }

  private async runSemanticHost(
    group: SemanticGroup,
    pattern: string | undefined,
    suffix: string,
    workspace: string,
    message: string,
  ): Promise<SemanticHostOutcome> {
    let source: Record<string, unknown> = { kind: "response" };
    try {
      const artifact = await this.semanticInput(pattern);
      source = semanticSource(artifact);
      const host = this.input.host;
      if (!host) throw new Error("semantic host is unavailable");
      const response = await host
        .run({
          retainHostDiagnostics: (bytes) =>
            this.effects.evidence.retainArtifacts([
              {
                id: `sevro.semantic${suffix}.sevro.host.diagnostics`,
                bytes: Buffer.from(bytes),
              },
            ]),
          candidateTranscriptRoot: this.input.candidateTranscriptRoot,
          candidateArtifactRoots: this.input.candidateArtifactRoots,
          prompt: semanticHostPrompt(message, group, artifact),
          runtimePolicy: gradingRuntimePolicy(
            this.input.runtimePolicy,
            pattern === undefined,
          ),
          runtimeRole: "semantic",
          workspace,
          condition: "passive",
          signal: this.input.signal,
        })
        .catch((cause: unknown) => {
          if (cause instanceof HostExecutionFailure) return cause.result;
          throw cause;
        });
      const artifacts = scopedHostArtifacts(
        response,
        `sevro.semantic${suffix}.`,
        this.effects.evidence.artifactRefs,
        this.input.declaredChecks,
        `sevro.semantic.verdicts${suffix}`,
      );
      return { result: response, artifacts, source, hostId: host.id };
    } catch (cause) {
      if (cause instanceof HostDiagnosticPersistenceError) throw cause;
      this.failGrading("semantic grading did not complete");
      return { result: null, artifacts: [], source, hostId: null };
    }
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

  private parseSemanticResults(
    result: HostResult,
    group: SemanticGroup,
    pattern: string | undefined,
    source: Record<string, unknown>,
    hostId: string,
  ): boolean {
    try {
      const message = this.completeSemanticGraderMessage(result);
      const verdicts = parseSemanticVerdicts(message, group);
      for (const verdict of verdicts)
        this.recordSemanticVerdict(verdict, pattern, source, hostId);
      return true;
    } catch {
      this.failGrading(
        result.failureMessage ?? "semantic grading did not complete",
        result.processFailure?.reason === "cancelled",
      );
      return false;
    }
  }

  private completeSemanticGraderMessage(result: HostResult): string {
    if (result.executionFailed || !result.complete || !result.finalMessage)
      throw new Error("semantic grader result did not complete");
    return result.finalMessage;
  }

  private async gradeSemanticGroup(group: SemanticGroup): Promise<void> {
    const pattern = group[0].artifactPath;
    const suffix = semanticGroupSuffix(pattern);
    if (this.failure) return;
    const message = this.input.message;
    if (message === null) {
      this.checks.push(
        ...group.map((check) => ({
          id: check.id,
          grader: "sevro.semantic",
          status: "unavailable" as const,
          evidenceRefs: [],
        })),
      );
      return;
    }
    const workspace = await this.semanticWorkspace();
    let successful = false;
    try {
      const outcome = await this.runSemanticHost(
        group,
        pattern,
        suffix,
        workspace,
        message,
      );
      if (outcome.result === null) return;
      await this.effects.evidence.retainArtifacts(outcome.artifacts);
      this.observations.push({
        id: `sevro.observation.semantic.usage${suffix}`,
        source: outcome.hostId,
        completeness: outcome.result.usageComplete ? "complete" : "partial",
        data: usage(outcome.result),
      });
      await this.effects.evidence.retainSemanticVerdicts(
        outcome.result.finalMessage,
        suffix,
      );
      successful = this.parseSemanticResults(
        outcome.result,
        group,
        pattern,
        outcome.source,
        outcome.hostId,
      );
    } finally {
      await this.finishWorkspace(workspace, successful);
    }
  }
  private async finishWorkspace(
    workspace: string,
    successful: boolean,
  ): Promise<void> {
    if (successful) await clearFixtureContents(workspace);
    else await this.effects.retainWorkspace(workspace);
  }
}
export async function gradeSemanticChecks(
  input: SemanticGradingInput,
  effects: SemanticGradingEffects,
) {
  return new SemanticGrading(input, effects).run();
}
