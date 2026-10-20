import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvidenceData } from "./schema-types";
import { canonicalJson, sha256 } from "./identity";
import type { ArtifactReference } from "./contract-types";
import { retainedFile } from "./results-lock";
import { atomicWriteJson } from "./storage";

function transcriptArtifacts(evidence: RunEvidenceData) {
  return evidence.trials.flatMap((trial) =>
    trial.artifactRefs
      .filter((artifact) =>
        /^(?:sevro\.(?:semantic(?:\.[a-f0-9]{64})?|advisory)\.)?sevro\.native-transcripts\.bundle$/.test(
          artifact.id,
        ),
      )
      .map((artifact) => ({
        caseId: trial.caseId,
        trial: trial.trial,
        ...artifact,
      })),
  );
}

function pruningRecord(evidence: RunEvidenceData) {
  return {
    format: "sevro.pruned-native-transcripts.v1",
    runId: evidence.runId,
    artifacts: transcriptArtifacts(evidence),
  };
}

function pruningPath(evidence: RunEvidenceData) {
  if (evidence.result.evidencePath === null)
    throw new Error(
      "native transcript retention requires a retained evidence path",
    );
  return join(
    dirname(evidence.result.evidencePath),
    "native-transcripts-pruned.json",
  );
}

function transcriptPath(
  evidence: RunEvidenceData,
  artifact: ArtifactReference,
) {
  const path = fileURLToPath(artifact.path);
  if (dirname(path) !== dirname(pruningPath(evidence)))
    throw new Error(
      "native transcript artifact is outside its retained result directory",
    );
  return path;
}

async function transcriptPresent(
  evidence: RunEvidenceData,
  artifact: ArtifactReference,
) {
  const path = transcriptPath(evidence, artifact);
  if (!(await retainedFile(path))) return false;
  if (sha256(await readFile(path)) !== artifact.sha256)
    throw new Error("retained native transcript evidence hash differs");
  return true;
}

/** Keep capture evidence immutable; a separate receipt records intentional removal. */
export async function pruneNativeTranscripts(evidence: RunEvidenceData) {
  const artifacts = transcriptArtifacts(evidence);
  if (!artifacts.length) return 0;
  await atomicWriteJson(pruningPath(evidence), pruningRecord(evidence));
  let removed = 0;
  for (const artifact of artifacts) {
    const path = transcriptPath(evidence, artifact);
    if (!(await retainedFile(path))) continue;
    await rm(path);
    removed++;
  }
  return removed;
}

/** Missing native bytes require an exact receipt bound to their original references. */
async function hasPruningRecord(evidence: RunEvidenceData) {
  const path = pruningPath(evidence);
  const marked = await retainedFile(path);
  if (marked) {
    const receipt: unknown = JSON.parse(await readFile(path, "utf8"));
    if (canonicalJson(receipt) !== canonicalJson(pruningRecord(evidence)))
      throw new Error(
        "native transcript pruning record differs from retained evidence",
      );
  }
  return marked !== null;
}

export async function nativeTranscriptRetention(
  evidence: RunEvidenceData | null,
) {
  if (!evidence) return [];
  const marked = await hasPruningRecord(evidence);
  const states = [];
  for (const artifact of transcriptArtifacts(evidence)) {
    const present = await transcriptPresent(evidence, artifact);
    if (!present && !marked)
      throw new Error(
        "retained native transcript evidence is missing without a pruning record",
      );
    states.push({ caseId: artifact.caseId, pruned: !present });
  }
  return states;
}
