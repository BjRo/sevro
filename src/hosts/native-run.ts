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
  runtimeObservations,
  candidateCodexStateRetained,
} from "../runtime/index";
import { validateNativeHostRequest } from "./native-request";
import { join } from "node:path";
import {
  failedNativeTranscripts,
  retainEnabledNativeTranscripts,
} from "../transcripts/index";

export type NativeRunRequest = Parameters<HostAdapter["run"]>[0];
type Observation = NonNullable<HostResult["observations"]>[number];

/** Owned resources are registered as soon as preparation creates them. */
export interface NativeRunContext {
  request: NativeRunRequest;
  stateRoot: string;
  diagnostics: HostDiagnostics;
  /** Assigned immediately after preparation; released before deleting native state. */
  hooks?: HookMounts;
  /** Additional disposable roots, deleted in registration order after native state. */
  cleanupRoots: string[];
}

export interface NativeRunOutcome {
  result: Omit<HostResult, "observations" | "actualCondition">;
  beforeRuntime?: Observation[];
  observations: Observation[];
  rootSessionId?: string;
}

/** Host adapters supply only admission, preparation, and native turn interpretation. */
export interface NativeRunAdapter<Admission, State> {
  host: "claude" | "codex";
  credentialFile?: string;
  retainHostDiagnostics?: boolean;
  transcriptDirectory: string;
  /** Preserve each host's evidence order and diagnostic snapshot timing. */
  hookPosition: "first" | "last";
  validate: (request: NativeRunRequest) => Promise<Admission>;
  prepare: (context: NativeRunContext, admission: Admission) => Promise<State>;
  execute: (
    context: NativeRunContext,
    state: State,
  ) => Promise<NativeRunOutcome>;
}

/** Own admission, diagnostics, evidence retention and cleanup for one native run. */
export async function runNativeRun<Admission, State>(
  adapter: NativeRunAdapter<Admission, State>,
  request: NativeRunRequest,
): Promise<HostResult> {
  const diagnostics = createHostDiagnostics(
    adapter.host,
    adapter.retainHostDiagnostics,
    request,
  );
  return diagnoseHostRequest(diagnostics, async () => {
    diagnostics.stage = "request-validation";
    await diagnostics.readCredentials(adapter.credentialFile);
    await validateNativeHostRequest(request, hostLabel(adapter.host));
    const admission = await adapter.validate(request);
    diagnostics.stage = "state-allocation";
    const stateRoot = await allocateNativeState(
      `${adapter.host}-`,
      request.runtimePolicy ? request.workspace : undefined,
    );
    return executeNativeRun(
      adapter,
      { request, stateRoot, diagnostics, cleanupRoots: [] },
      admission,
    );
  });
}

async function executeNativeRun<Admission, State>(
  adapter: NativeRunAdapter<Admission, State>,
  context: NativeRunContext,
  admission: Admission,
): Promise<HostResult> {
  const { request, stateRoot, diagnostics } = context;
  try {
    diagnostics.stage = "state-preparation";
    const state = await adapter.prepare(context, admission);
    const outcome = await adapter.execute(context, state);
    const result: HostResult = {
      ...outcome.result,
      actualCondition: "passive",
      observations: nativeObservations(context, outcome),
    };
    if (adapter.hookPosition === "first")
      await incorporateHooks(result, context, "first");
    await diagnostics.retainFailure(
      result,
      `${hostLabel(adapter.host)} host execution did not complete`,
    );
    if (adapter.hookPosition === "last")
      await incorporateHooks(result, context, "last");
    await retainEnabledNativeTranscripts(
      result,
      request.runtimePolicy,
      join(stateRoot, adapter.transcriptDirectory),
      adapter.host,
      request.runtimeRole,
      outcome.rootSessionId,
    );
    return result;
  } catch (cause) {
    return await failedNativeTranscripts(
      cause,
      request.runtimePolicy,
      join(stateRoot, adapter.transcriptDirectory),
      adapter.host,
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
  context: NativeRunContext,
  outcome: NativeRunOutcome,
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
  context: NativeRunContext,
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
