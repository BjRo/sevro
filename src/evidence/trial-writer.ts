import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TrialPersistenceError, type TrialSummary } from "../evaluation/types";
import { sha256 } from "../identity";
import type { Assessment, CheckOutcome } from "../results";
import type {
  ArtifactReference,
  Diagnostic,
  ObservationEvidence,
  RawResultReference,
} from "../contract-types";
import type { RunEvidenceDataTrialEvidence } from "../schema-types";
import { atomicWriteJson } from "../storage";
import type { hostArtifacts } from "./host-results";
import { verifyRetainedArtifacts } from "./retained-artifacts";

type TrialEvidence = RunEvidenceDataTrialEvidence;
export type TrialObservation = ObservationEvidence;

interface TrialWriterInput {
  readonly runDir: string;
  readonly trial: number;
  readonly workspace: string;
  readonly preparationArtifacts: readonly ArtifactReference[];
}

/** Owns private trial files and their references, independently of run collection. */
export class TrialEvidenceWriter {
  private readonly references: ArtifactReference[];
  private rawPath: string | null = null;
  private rawDigest: string | null = null;

  constructor(private readonly input: TrialWriterInput) {
    this.references = [...input.preparationArtifacts];
  }

  get artifactRefs(): ArtifactReference[] {
    return [...this.references];
  }

  get hasCandidateMessage(): boolean {
    return this.rawDigest !== null;
  }

  private async writePrivateFile(
    path: string,
    bytes: string | Uint8Array,
  ): Promise<void> {
    try {
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    } catch (cause) {
      throw new TrialPersistenceError(this.input.workspace, { cause });
    }
  }

  private async retainReference(
    id: string,
    filename: string,
    bytes: string | Uint8Array,
  ): Promise<ArtifactReference> {
    const path = join(
      this.input.runDir,
      `trial-${this.input.trial}-${filename}`,
    );
    await this.writePrivateFile(path, bytes);
    const reference = {
      id,
      path: pathToFileURL(path).href,
      sha256: sha256(bytes),
    };
    this.references.push(reference);
    return reference;
  }

  async retainArtifacts(
    artifacts: readonly ReturnType<typeof hostArtifacts>[number][],
    prefix = "",
  ): Promise<void> {
    for (const artifact of artifacts)
      await this.retainReference(
        artifact.id,
        `${prefix}${artifact.id}.bin`,
        artifact.bytes,
      );
  }

  verifyArtifacts(): Promise<void> {
    return verifyRetainedArtifacts(this.references);
  }

  observeCandidate(
    source: string,
    result: { finalMessage: string | null; complete: boolean } | null,
  ): TrialObservation {
    if (result === null || result.finalMessage == null) {
      this.rawDigest = null;
      return {
        id: "sevro.observation.final-message",
        source,
        completeness: "unavailable",
        data: {},
      };
    }
    this.rawDigest = sha256(result.finalMessage);
    return {
      id: "sevro.observation.final-message",
      source,
      completeness: result.complete ? "complete" : "partial",
      data: {
        sha256: this.rawDigest,
        byteLength: Buffer.byteLength(result.finalMessage, "utf8"),
      },
    };
  }

  async retainSemanticVerdicts(
    message: string | null,
    suffix: string,
  ): Promise<void> {
    if (message === null || Buffer.byteLength(message, "utf8") > 1024 * 1024)
      return;
    await this.retainReference(
      `sevro.semantic.verdicts${suffix}`,
      `semantic-verdicts${suffix}.json`,
      Buffer.from(message, "utf8"),
    );
  }

  async retainAdvisoryResponse(
    source: string,
    message: string | null,
  ): Promise<RawResultReference> {
    if (message === null || Buffer.byteLength(message, "utf8") > 64 * 1024)
      return { source, path: null, sha256: null };
    const reference = await this.retainReference(
      "sevro.advisory.response",
      "advisory.json",
      message,
    );
    return { source, path: reference.path, sha256: reference.sha256 };
  }

  async retainRawCandidate(message: string | null | undefined): Promise<void> {
    await this.verifyArtifacts();
    if (message == null) {
      this.rawPath = null;
      return;
    }
    this.rawPath = join(this.input.runDir, `trial-${this.input.trial}-raw.txt`);
    await this.writePrivateFile(this.rawPath, message);
  }

  candidateRawResult(source: string): RawResultReference {
    return {
      source,
      path: this.rawPath ? pathToFileURL(this.rawPath).href : null,
      sha256: this.rawDigest,
    };
  }

  diagnosticLocation(diagnostic: Diagnostic | undefined) {
    if (!diagnostic) return diagnostic;
    const artifact = this.references.find((ref) =>
      ref.id.endsWith("sevro.host.diagnostics"),
    );
    if (!artifact) return diagnostic;
    const message = `${diagnostic.message}; diagnostics: ${artifact.path}`;
    return message.length <= 4096 ? { ...diagnostic, message } : diagnostic;
  }

  async persistTrial(
    caseId: string,
    assessment: Assessment,
    checks: CheckOutcome[],
    domainOutcomes: TrialSummary["domainOutcomes"],
    evidence: TrialEvidence,
  ): Promise<TrialSummary> {
    const artifactPath = join(
      this.input.runDir,
      `trial-${this.input.trial}.json`,
    );
    const summary: TrialSummary = {
      trial: this.input.trial,
      ...assessment,
      checks,
      domainOutcomes,
      artifactPath,
    };
    try {
      await atomicWriteJson(artifactPath, {
        format: "sevro.trial-evidence.v1",
        caseId,
        trial: this.input.trial,
        result: summary,
        evidence,
      });
    } catch (cause) {
      throw new TrialPersistenceError(this.input.workspace, { cause });
    }
    return summary;
  }
}
