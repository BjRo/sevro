import { join } from "node:path";
import type { HostAdapter } from "../engine";
import {
  requireCandidateRuntime,
  requireCandidateArtifactRoots,
} from "../candidate-artifacts";
import { requireNativeTranscriptView } from "../native-transcript-state";
import { isOptionalNonblankString } from "../value-guards";

export const MAX_HOST_TIMEOUT_MS = 30 * 60_000;

export function validHostTimeout(timeoutMs: number): boolean {
  return (
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs >= 1 &&
    timeoutMs <= MAX_HOST_TIMEOUT_MS
  );
}

/** Common admission checks run before native state or processes are allocated. */
export async function validateNativeHostRequest(
  request: Parameters<HostAdapter["run"]>[0],
  host: "Codex" | "Claude",
): Promise<void> {
  requireFollowUp(request.followUpPrompt, host);
  await requireNativeTranscriptView(request.candidateTranscriptRoot);
  await requireCandidateRuntime(
    request.candidateRuntimeRoot,
    request.runtimeRole,
  );
  await requireCandidateArtifactRoots(request.candidateArtifactRoots);
  requireFixtureBin(request);
  requirePassiveRequest(request, host);
}

function requireFollowUp(prompt: string | undefined, host: string): void {
  if (!isOptionalNonblankString(prompt))
    throw new Error(`${host} follow-up prompt must be nonempty`);
}

function requireFixtureBin(request: Parameters<HostAdapter["run"]>[0]): void {
  if (
    request.fixtureBinDir !== undefined &&
    request.fixtureBinDir !== join(request.workspace, ".git", "fixture-bin")
  )
    throw new Error("fixture binary path is outside the workspace");
}

function requirePassiveRequest(
  request: Parameters<HostAdapter["run"]>[0],
  host: string,
): void {
  if (request.instrumentation?.length || request.condition !== "passive")
    throw new Error(`${host} enforcement instrumentation is unavailable`);
}
