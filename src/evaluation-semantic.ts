import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createFixture, hostArtifacts, usage } from "./evaluation-fixture";
import {
  gradingRuntimePolicy,
  scopedHostArtifacts,
} from "./evaluation-grading-host";
import type { HostAdapter, HostResult, ResolvedCase } from "./evaluation-types";
import { readSemanticArtifact } from "./graders/artifact";
import {
  parseSemanticVerdicts,
  semanticCheckGroups,
  semanticPrompt,
  type PreparedSemanticCheck,
  type SemanticVerdict,
} from "./graders/semantic";
import { sha256 } from "./identity";
import type { CheckOutcome } from "./results";
import type { RuntimePolicy } from "./runtime-config";

interface SemanticObservation {
  id: string;
  source: string;
  completeness: "complete" | "partial";
  data: Record<string, unknown>;
}
interface SemanticGradingInput {
  checks: PreparedSemanticCheck[];
  declaredChecks: ResolvedCase["checks"];
  host: HostAdapter | undefined;
  message: string | null;
  candidateWorkspace: string;
  candidateTranscriptRoot?: string;
  projectRoot: string;
  reservedWorkspace?: string;
  runDir: string;
  trial: number;
  runtimePolicy?: RuntimePolicy;
  signal?: AbortSignal;
}
interface SemanticGradingEffects {
  artifactRefs: { id: string; path: string; sha256: string }[];
  canGrade(): boolean;
  failGrading(message: string, cancelable?: boolean): void;
  retainArtifacts(artifacts: ReturnType<typeof hostArtifacts>): Promise<void>;
  writeTrialFile(path: string, bytes: string | Uint8Array): Promise<void>;
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
  private observations: SemanticObservation[] = [];
  private checks: CheckOutcome[] = [];
  constructor(
    private readonly input: SemanticGradingInput,
    private readonly effects: SemanticGradingEffects,
  ) {}
  async run() {
    for (const group of semanticCheckGroups(this.input.checks))
      await this.gradeSemanticGroup(group);
    return { checks: this.checks, observations: this.observations };
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
      { files: {} },
      [],
      undefined,
      null,
      null,
      null,
      null,
      this.input.projectRoot,
      this.input.signal,
      this.input.reservedWorkspace,
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
      const response = await host.run({
        candidateTranscriptRoot: this.input.candidateTranscriptRoot,
        prompt: semanticHostPrompt(message, group, artifact),
        runtimePolicy: gradingRuntimePolicy(this.input.runtimePolicy),
        runtimeRole: "semantic",
        workspace,
        condition: "passive",
        signal: this.input.signal,
      });
      const artifacts = scopedHostArtifacts(
        response,
        `sevro.semantic${suffix}.`,
        this.effects.artifactRefs,
        this.input.declaredChecks,
        `sevro.semantic.verdicts${suffix}`,
      );
      return { result: response, artifacts, source, hostId: host.id };
    } catch {
      this.effects.failGrading("semantic grading did not complete");
      return { result: null, artifacts: [], source, hostId: null };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  private async retainSemanticVerdicts(
    result: HostResult,
    suffix: string,
  ): Promise<void> {
    if (
      result.finalMessage !== null &&
      Buffer.byteLength(result.finalMessage, "utf8") <= 1024 * 1024
    ) {
      const bytes = Buffer.from(result.finalMessage, "utf8");
      const path = join(
        this.input.runDir,
        `trial-${this.input.trial}-semantic-verdicts${suffix}.json`,
      );
      await this.effects.writeTrialFile(path, bytes);
      this.effects.artifactRefs.push({
        id: `sevro.semantic.verdicts${suffix}`,
        path: pathToFileURL(path).href,
        sha256: sha256(bytes),
      });
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
  ): void {
    try {
      const message = this.completeSemanticGraderMessage(result);
      const verdicts = parseSemanticVerdicts(message, group);
      for (const verdict of verdicts)
        this.recordSemanticVerdict(verdict, pattern, source, hostId);
    } catch {
      this.effects.failGrading("semantic grading did not complete", false);
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
    if (!this.effects.canGrade()) return;
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
    const outcome = await this.runSemanticHost(
      group,
      pattern,
      suffix,
      workspace,
      message,
    );
    if (outcome.result === null) return;
    await this.effects.retainArtifacts(outcome.artifacts);
    this.observations.push({
      id: `sevro.observation.semantic.usage${suffix}`,
      source: outcome.hostId,
      completeness: outcome.result.usageComplete ? "complete" : "partial",
      data: usage(outcome.result),
    });
    await this.retainSemanticVerdicts(outcome.result, suffix);
    this.parseSemanticResults(
      outcome.result,
      group,
      pattern,
      outcome.source,
      outcome.hostId,
    );
  }
}
export async function gradeSemanticChecks(
  input: SemanticGradingInput,
  effects: SemanticGradingEffects,
) {
  return new SemanticGrading(input, effects).run();
}
