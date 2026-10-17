import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  allocateWorkspace,
  retainWorkspace,
  removeWorkspace,
} from "../fixtures/workspace-state";
import { createFixture } from "../fixtures/create";
import { fixtureBinDirectory } from "../fixtures/bin";
import { fixtureParts } from "../fixtures/preparation";
import { startRunOwner, type RunOwner } from "../run-owner";
import { EvaluationConfigurationError, type EvaluationOptions } from "./types";
import type { PreparedFixture, PreparedInvocation } from "./plan";
import type { ArtifactReference as PreparationArtifactReference } from "../contract-types";
export type { ArtifactReference as PreparationArtifactReference } from "../contract-types";

/** Reservations outlive completed contents until all admitted trials drain. */
export class RunWorkspaceReservations {
  private readonly candidates: string[] = [];
  private readonly semantics: string[] = [];
  private readonly retained = new Set<string>();

  async reserve(input: {
    count: number;
    semantic: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    for (
      let trial = 1;
      trial <= input.count && !input.signal?.aborted;
      trial++
    ) {
      this.candidates.push(await allocateWorkspace());
      if (input.semantic) this.semantics.push(await allocateWorkspace());
    }
  }

  candidate(trial: number): string {
    const reservation = this.candidates[trial - 1];
    if (reservation === undefined)
      throw new Error(`trial ${trial} workspace was not reserved`);
    return reservation;
  }

  semantic(trial: number): string | undefined {
    return this.semantics[trial - 1];
  }

  retain(workspace: string): void {
    this.retained.add(workspace);
  }

  completed(reservation: string): void {
    this.retained.delete(reservation);
  }

  async cleanup(): Promise<void> {
    for (const workspace of this.retained) await retainWorkspace(workspace);
    await Promise.all(
      [...this.candidates, ...this.semantics]
        .filter((workspace) => !this.retained.has(workspace))
        .map(async (workspace) => {
          try {
            await removeWorkspace(workspace);
          } catch {
            console.warn(`fixture cleanup failed; retained at ${workspace}`);
          }
        }),
    );
  }
}

export interface RunResources {
  readonly runId: string;
  readonly runDir: string;
  readonly runStateRoot: string;
  readonly stateDir: string;
  readonly evidencePath: string;
  readonly owner: RunOwner;
  readonly workspaces: RunWorkspaceReservations;
}

export async function allocateRunResources(
  options: Pick<EvaluationOptions, "resultsRoot" | "runStateRoot">,
  evaluationDigest: string,
): Promise<RunResources> {
  const runId = randomUUID();
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
  let owner: RunOwner;
  try {
    owner = startRunOwner({
      stateRoot,
      evaluationDigest,
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
  return {
    runId,
    runDir,
    runStateRoot,
    stateDir,
    evidencePath,
    owner,
    workspaces: new RunWorkspaceReservations(),
  };
}

export async function retainPreparationArtifacts(
  artifacts: PreparedFixture["inlineArtifacts"],
  runDir: string,
): Promise<PreparationArtifactReference[]> {
  const artifactRefs: PreparationArtifactReference[] = [];
  for (const artifact of artifacts) {
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
  return artifactRefs;
}

function renderTrialPrompt(
  prompt: string,
  workspace: string,
  invocation: PreparedInvocation,
): string {
  return prompt
    .replaceAll("{{sevro.workspace}}", workspace)
    .replaceAll(
      invocation.invocationPlaceholder,
      invocation.invocationToken ?? invocation.invocationPlaceholder,
    )
    .replaceAll(
      invocation.legacyCodexPlaceholder,
      invocation.invocationToken ?? invocation.legacyCodexPlaceholder,
    );
}

type TrialPreparationOptions = Pick<
  EvaluationOptions,
  "case" | "preparationSources" | "signal"
>;

export async function prepareTrialWorkspace(
  options: TrialPreparationOptions,
  fixture: PreparedFixture,
  invocation: PreparedInvocation,
  workspaces: RunWorkspaceReservations,
  trial: number,
  candidateRuntimeRoot?: string,
) {
  const reservation = workspaces.candidate(trial);
  workspaces.retain(reservation);
  const workspace = await createFixture(
    options.case.fixture,
    fixture.inlineArtifacts,
    options.preparationSources,
    fixture.repository,
    fixture.repositoryFixture,
    fixture.generated,
    fixture.fixtureSetup,
    fixture.projectRoot,
    options.signal,
    reservation,
    candidateRuntimeRoot,
  ).catch((error: unknown) => {
    if (
      !options.signal?.aborted ||
      error instanceof EvaluationConfigurationError
    )
      throw error;
    return null;
  });
  const details = await trialWorkspaceDetails(
    options.case,
    invocation,
    reservation,
    workspace,
  );
  return { ...details, candidateRuntimeRoot };
}

async function trialWorkspaceDetails(
  caseData: EvaluationOptions["case"],
  invocation: PreparedInvocation,
  reservation: string,
  preparedWorkspace: string | null,
) {
  const workspace = preparedWorkspace ?? reservation;
  const fixtureBinDir =
    preparedWorkspace === null
      ? undefined
      : ((await fixtureBinDirectory(workspace)) ?? undefined);
  const trialPrompt = renderTrialPrompt(caseData.prompt, workspace, invocation);
  const trialFollowUpPrompt =
    caseData.followUpPrompt === undefined
      ? undefined
      : renderTrialPrompt(caseData.followUpPrompt, workspace, invocation);
  return {
    reservation,
    workspace,
    preparationCancelled: preparedWorkspace === null,
    fixtureBinDir,
    trialPrompt,
    trialFollowUpPrompt,
  };
}
