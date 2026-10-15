import { join } from "node:path";
import type { HostAdapter } from "../engine";
import type { PreparedInvocation } from "./preparation";

type NativeRoute = { binary: string; timeoutMs?: number } | undefined;

function nativeSettings(native: NativeRoute) {
  if (!native) return { executable: null, timeoutMs: null };
  return { executable: native.binary, timeoutMs: native.timeoutMs ?? 600_000 };
}

function routeSettings(host: HostAdapter | undefined, native: NativeRoute) {
  if (!host) return null;
  return {
    host: host.id,
    model: host.model,
    effort: host.effort,
    ...nativeSettings(native),
  };
}

/** A whitelist of resolved operator settings; never copy credentials or runtime environment. */
export function effectiveSettings(prepared: PreparedInvocation) {
  const { invocation, host, semanticHost, advisoryHost } = prepared;
  return {
    format: "sevro.resolved-run-settings.v1",
    ...sourceSettings(prepared),
    ...extensionSettings(invocation.extension),
    ...adapterSettings(invocation),
    ...legacyRuntimeSettings(invocation),
    protectedRoots: invocation.protectedRoots,
    condition: invocation.condition,
    trials: invocation.trialCount,
    threshold: invocation.passThreshold,
    jobs: invocation.jobs,
    dry: invocation.dry,
    projectRoot: invocation.projectRoot,
    configRoot: invocation.configRoot,
    resultsRoot: invocation.resultsRoot,
    runStateRoot: invocation.runStateRoot,
    runtimeConfigFile: selectedRuntimeFile(prepared),
    candidate: routeSettings(host, invocation.codex ?? invocation.claude),
    semantic: routeSettings(semanticHost, invocation.semanticCodex),
    advisory: routeSettings(advisoryHost, invocation.advisoryCodex),
    codexEntrypoint: selectedEntrypoint(invocation),
    agentConcurrencyLimit: prepared.agentConcurrencyLimit,
    shellIsolation: Boolean(invocation.shellIsolation),
    retainHostDiagnostics: retainedDiagnostics(invocation),
    claudeProjectSettings: projectSettings(invocation),
    shellCheckDefaults: { expectedExitCode: 0, timeoutMs: 30_000 },
  };
}

function selectedCaseId(prepared: PreparedInvocation): string | null {
  if (prepared.caseData) return prepared.caseData.id;
  return prepared.invocation.extension?.caseId ?? null;
}

function sourceSettings(prepared: PreparedInvocation) {
  const { invocation } = prepared;
  return {
    runManifestFile: invocation.runManifestFile ?? null,
    caseFile: invocation.caseFile ?? null,
    caseId: selectedCaseId(prepared),
    caseSourceMapping: Boolean(invocation.caseSourceRoot),
  };
}

function extensionSettings(
  extension: PreparedInvocation["invocation"]["extension"],
) {
  if (!extension)
    return {
      extensionCommandFile: null,
      extensionSourceFileCount: 0,
      taskVerdictPolicy: null,
      replaceBuiltinGraders: [],
    };
  return {
    extensionCommandFile: extension.commandFile,
    extensionSourceFileCount: extension.sourceFiles.length,
    taskVerdictPolicy: extension.taskVerdictPolicy ?? null,
    replaceBuiltinGraders: extension.replaceBuiltinGraders,
  };
}

function adapterSettings(invocation: PreparedInvocation["invocation"]) {
  return {
    adapterModule: invocation.adapterModule ?? null,
    semanticAdapterModule: invocation.semanticAdapterModule ?? null,
    advisoryAdapterModule: invocation.advisoryAdapterModule ?? null,
    advisoryExcludedPaths: invocation.advisoryExcludedPaths,
  };
}

function selectedEntrypoint(invocation: PreparedInvocation["invocation"]) {
  return invocation.codex ? (invocation.codex.entrypoint ?? "exec") : null;
}

function projectSettings(
  invocation: PreparedInvocation["invocation"],
): boolean {
  return invocation.claude?.projectSettings ?? false;
}

function legacyRuntimeSettings(invocation: PreparedInvocation["invocation"]) {
  return {
    toolchainBinDir: selectedToolchain(invocation),
    claudeUvCacheDir: invocation.claude?.uvCacheDir ?? null,
  };
}

function selectedToolchain(invocation: PreparedInvocation["invocation"]) {
  return (
    invocation.shellIsolation?.toolchainBinDir ??
    invocation.claude?.toolchainBinDir ??
    null
  );
}

function retainedDiagnostics(
  invocation: PreparedInvocation["invocation"],
): boolean {
  return [
    invocation.codex,
    invocation.claude,
    invocation.semanticCodex,
    invocation.advisoryCodex,
  ].some((host) => host?.retainHostDiagnostics === true);
}

/** Assessment-affecting CLI settings absent from the engine's other identity inputs. */
export function assessmentSettings(prepared: PreparedInvocation) {
  const { invocation } = prepared;
  return {
    shellIsolation: Boolean(invocation.shellIsolation),
    protectedRoots: invocation.protectedRoots,
    ...legacyRuntimeSettings(invocation),
    candidateTimeoutMs: nativeSettings(invocation.codex ?? invocation.claude)
      .timeoutMs,
    semanticTimeoutMs: nativeSettings(invocation.semanticCodex).timeoutMs,
    advisoryTimeoutMs: nativeSettings(invocation.advisoryCodex).timeoutMs,
    claudeProjectSettings: invocation.claude?.projectSettings ?? false,
  };
}

function selectedRuntimeFile(prepared: PreparedInvocation): string | null {
  return (
    prepared.invocation.runtimeConfigFile ??
    (prepared.runtimePolicy
      ? join(prepared.invocation.projectRoot, "sevro.json")
      : null)
  );
}

export function displayEffectiveSettings(prepared: PreparedInvocation): void {
  process.stderr.write(
    `sevro: effective settings ${JSON.stringify(effectiveSettings(prepared))}\n`,
  );
}
