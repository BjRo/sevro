import type { HostAdapter, HostResult } from "../host-contract/index";
import {
  createHostDiagnostics,
  cleanupNativeState,
  diagnoseHostRequest,
  type HostDiagnostics,
} from "../diagnostics/index";
import { rm } from "node:fs/promises";
import {
  releaseRuntimeHooks,
  runtimeHookObservation,
  type HookMounts,
} from "../hooks/index";
import {
  allocateNativeState,
  candidateCodexStateRetained,
  requireCandidateArtifactRoots,
  requireCandidateRuntime,
  requireNativeTranscriptView,
  runtimeObservations,
} from "../runtime/index";
import { join } from "node:path";
import { isOptionalNonblankString } from "../kernel/index";
import {
  failedNativeTranscripts,
  retainEnabledNativeTranscripts,
} from "../transcripts/index";

export type NativeHostRequest = Parameters<HostAdapter["run"]>[0];
type Observation = NonNullable<HostResult["observations"]>[number];

/** Owned resources are registered as soon as preparation creates them. */
export interface NativeHostRequestContext {
  request: NativeHostRequest;
  stateRoot: string;
  diagnostics: HostDiagnostics;
  /** Assigned immediately after preparation; released before deleting native state. */
  hooks?: HookMounts;
  /** Additional disposable roots, deleted in registration order after native state. */
  cleanupRoots: string[];
}

export interface NativeHostRequestOutcome {
  result: Omit<HostResult, "observations" | "actualCondition">;
  beforeRuntime?: Observation[];
  observations: Observation[];
  rootSessionId?: string;
}

/** A native host supplies only its admission, preparation, and turn interpretation. */
export interface NativeHost<Admission, State> {
  host: "claude" | "codex";
  credentialFile?: string;
  retainHostDiagnostics?: boolean;
  transcriptDirectory: string;
  /** Preserve each host's evidence order and diagnostic snapshot timing. */
  hookPosition: "first" | "last";
  validate: (request: NativeHostRequest) => Promise<Admission>;
  prepare: (
    context: NativeHostRequestContext,
    admission: Admission,
  ) => Promise<State>;
  execute: (
    context: NativeHostRequestContext,
    state: State,
  ) => Promise<NativeHostRequestOutcome>;
}

/** Own admission, diagnostics, evidence retention and cleanup for one native host request. */
export async function runNativeHostRequest<Admission, State>(
  nativeHost: NativeHost<Admission, State>,
  request: NativeHostRequest,
): Promise<HostResult> {
  const diagnostics = createHostDiagnostics(
    nativeHost.host,
    nativeHost.retainHostDiagnostics,
    request,
  );
  return diagnoseHostRequest(diagnostics, async () => {
    diagnostics.stage = "request-validation";
    await diagnostics.readCredentials(nativeHost.credentialFile);
    await validateNativeHostRequest(request, hostLabel(nativeHost.host));
    const admission = await nativeHost.validate(request);
    diagnostics.stage = "state-allocation";
    const stateRoot = await allocateNativeState(
      `${nativeHost.host}-`,
      request.runtimePolicy ? request.workspace : undefined,
    );
    return executeNativeHostRequest(
      nativeHost,
      { request, stateRoot, diagnostics, cleanupRoots: [] },
      admission,
    );
  });
}

async function executeNativeHostRequest<Admission, State>(
  nativeHost: NativeHost<Admission, State>,
  context: NativeHostRequestContext,
  admission: Admission,
): Promise<HostResult> {
  const { request, stateRoot, diagnostics } = context;
  try {
    diagnostics.stage = "state-preparation";
    const state = await nativeHost.prepare(context, admission);
    const outcome = await nativeHost.execute(context, state);
    const result: HostResult = {
      ...outcome.result,
      actualCondition: "passive",
      observations: nativeObservations(context, outcome),
    };
    if (nativeHost.hookPosition === "first")
      await incorporateHooks(result, context, "first");
    await diagnostics.retainFailure(
      result,
      `${hostLabel(nativeHost.host)} host execution did not complete`,
    );
    if (nativeHost.hookPosition === "last")
      await incorporateHooks(result, context, "last");
    await retainEnabledNativeTranscripts(
      result,
      request.runtimePolicy,
      join(stateRoot, nativeHost.transcriptDirectory),
      nativeHost.host,
      request.runtimeRole,
      outcome.rootSessionId,
    );
    return result;
  } catch (cause) {
    return await failedNativeTranscripts(
      cause,
      request.runtimePolicy,
      join(stateRoot, nativeHost.transcriptDirectory),
      nativeHost.host,
      request.runtimeRole,
      diagnostics,
    );
  } finally {
    await cleanupNativeState(diagnostics, async () => {
      await releaseRuntimeHooks(context.hooks);
      if (!candidateCodexStateRetained(request.candidateRuntimeRoot, stateRoot))
        await rm(stateRoot, { recursive: true, force: true });
      for (const root of context.cleanupRoots)
        await rm(root, { recursive: true, force: true });
    });
  }
}

function nativeObservations(
  context: NativeHostRequestContext,
  outcome: NativeHostRequestOutcome,
): Observation[] {
  return [
    ...(outcome.beforeRuntime ?? []),
    ...runtimeObservations(
      context.request.runtimePolicy,
      context.request.runtimeRole,
    ),
    ...outcome.observations,
  ];
}

async function incorporateHooks(
  result: HostResult,
  context: NativeHostRequestContext,
  position: "first" | "last",
): Promise<void> {
  if (!context.hooks || !context.request.runtimePolicy) return;
  const observation = await runtimeHookObservation(context.hooks);
  const observations = result.observations ?? [];
  result.observations =
    position === "first"
      ? [observation, ...observations]
      : [...observations, observation];
}

function hostLabel(host: "claude" | "codex"): "Claude" | "Codex" {
  return host === "claude" ? "Claude" : "Codex";
}

async function validateNativeHostRequest(
  request: NativeHostRequest,
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

function requireFixtureBin(request: NativeHostRequest): void {
  if (
    request.fixtureBinDir !== undefined &&
    request.fixtureBinDir !== join(request.workspace, ".git", "fixture-bin")
  )
    throw new Error("fixture binary path is outside the workspace");
}

function requirePassiveRequest(request: NativeHostRequest, host: string): void {
  if (request.instrumentation?.length || request.condition !== "passive")
    throw new Error(`${host} enforcement instrumentation is unavailable`);
}
