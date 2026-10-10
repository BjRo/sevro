import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFixture } from "./evaluation-fixture";
import { type EvaluationPlan } from "./evaluation-plan";
import {
  EvaluationConfigurationError,
  type EvaluationOptions,
  type TrialSummary,
} from "./evaluation-types";
import { fixtureBinDirectory } from "./fixture-bin";
import { fixtureParts } from "./preparation";
import { checkpointRunOwner, startRunOwner } from "./run-owner";
import type { RunEvidenceData } from "./schema-types";

export async function allocateEvaluationRun(
  options: EvaluationOptions,
  context: EvaluationPlan,
) {
  const { runId, evaluationIdentity } = context;
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
  const reservedWorkspaces: string[] = [];
  const reservedSemanticWorkspaces: string[] = [];
  const retainedWorkspaces = new Set<string>();
  return {
    runDir,
    runStateRoot,
    stateRoot,
    stateDir,
    activePath,
    checkpointPath,
    evidencePath,
    trialSummaries,
    owner,
    reservedWorkspaces,
    reservedSemanticWorkspaces,
    retainedWorkspaces,
  };
}

export type EvaluationRuntime = Awaited<
  ReturnType<typeof allocateEvaluationRun>
>;
export async function retainPreparationArtifacts(
  context: EvaluationPlan & EvaluationRuntime,
) {
  const { inlineArtifacts, runDir } = context;
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

  return { artifactRefs };
}

export async function reserveEvaluationWorkspaces(
  options: EvaluationOptions,
  context: EvaluationPlan & EvaluationRuntime,
) {
  const { reservedWorkspaces, preparedSemantic, reservedSemanticWorkspaces } =
    context;
  const trialEvidence: RunEvidenceData["trials"] = [];
  for (
    let trial = 1;
    trial <= options.trialCount && !options.signal?.aborted;
    trial++
  ) {
    reservedWorkspaces.push(
      await realpath(await mkdtemp(join(tmpdir(), "sevro-case-"))),
    );
    if (preparedSemantic.length)
      reservedSemanticWorkspaces.push(
        await realpath(await mkdtemp(join(tmpdir(), "sevro-case-"))),
      );
  }
  const diagnostics: {
    trial: number;
    diagnostic: { code: string; message: string };
  }[] = [];
  return { trialEvidence, diagnostics };
}

export type EvaluationContext = EvaluationPlan &
  EvaluationRuntime &
  Awaited<ReturnType<typeof retainPreparationArtifacts>> &
  Awaited<ReturnType<typeof reserveEvaluationWorkspaces>>;
export function checkpointEvaluation(
  context: EvaluationRuntime,
  status: "active" | "complete" | "interrupted",
): void {
  checkpointRunOwner(
    context.owner,
    context.trialSummaries.map((trial) => ({
      trial: trial.trial,
      artifactPath: trial.artifactPath,
    })),
    status,
  );
}
function renderTrialPrompt(
  prompt: string,
  workspace: string,
  context: EvaluationContext,
): string {
  return prompt
    .replaceAll("{{sevro.workspace}}", workspace)
    .replaceAll(
      context.invocationPlaceholder,
      context.invocationToken ?? context.invocationPlaceholder,
    )
    .replaceAll(
      context.legacyCodexPlaceholder,
      context.invocationToken ?? context.legacyCodexPlaceholder,
    );
}

export async function prepareTrialWorkspace(
  options: EvaluationOptions,
  context: EvaluationContext,
  trial: number,
) {
  const reservation = context.reservedWorkspaces[trial - 1];
  if (reservation === undefined)
    throw new Error(`trial ${trial} workspace was not reserved`);
  context.retainedWorkspaces.add(reservation);
  const workspace = await createFixture(
    options.case.fixture,
    context.inlineArtifacts,
    options.preparationSources,
    context.repository,
    context.repositoryFixture,
    context.generated,
    context.fixtureSetup,
    context.projectRoot,
    options.signal,
    reservation,
  ).catch((error: unknown) => {
    if (
      !options.signal?.aborted ||
      error instanceof EvaluationConfigurationError
    )
      throw error;
    return null;
  });
  return trialWorkspaceDetails(options, context, reservation, workspace);
}

async function trialWorkspaceDetails(
  options: EvaluationOptions,
  context: EvaluationContext,
  reservation: string,
  preparedWorkspace: string | null,
) {
  const workspace = preparedWorkspace ?? reservation;
  const fixtureBinDir =
    preparedWorkspace === null
      ? undefined
      : ((await fixtureBinDirectory(workspace)) ?? undefined);
  const trialPrompt = renderTrialPrompt(
    options.case.prompt,
    workspace,
    context,
  );
  const trialFollowUpPrompt =
    options.case.followUpPrompt === undefined
      ? undefined
      : renderTrialPrompt(options.case.followUpPrompt, workspace, context);

  return {
    reservation,
    workspace,
    preparationCancelled: preparedWorkspace === null,
    fixtureBinDir,
    trialPrompt,
    trialFollowUpPrompt,
  };
}
export function diagnoseEvaluationFailure(context: EvaluationRuntime): void {
  try {
    checkpointRunOwner(
      context.owner,
      context.trialSummaries.map((trial) => ({
        trial: trial.trial,
        artifactPath: trial.artifactPath,
      })),
      "diagnostic",
    );
  } catch {
    /* Preserve the original failure and retained artifacts. */
  }
}
export async function cleanupEvaluationWorkspaces(
  context: EvaluationRuntime,
): Promise<void> {
  await Promise.all(
    [...context.reservedWorkspaces, ...context.reservedSemanticWorkspaces]
      .filter((workspace) => !context.retainedWorkspaces.has(workspace))
      .map(async (workspace) => {
        try {
          await rm(workspace, { recursive: true, force: true });
        } catch {
          console.warn(`fixture cleanup failed; retained at ${workspace}`);
        }
      }),
  );
}
