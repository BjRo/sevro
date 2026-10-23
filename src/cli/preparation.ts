import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configurationRoot } from "../hosts/codex-configuration";
import {
  InvocationError,
  parseInvocation,
  nativeRoutes,
  type Invocation,
} from "./invocation";
import {
  loadRuntimeConfiguration,
  runtimeNativeGoalEnabled,
} from "../runtime/config";
import {
  canonicalRuntimeRoot,
  requireRuntimeReadRoots,
} from "../runtime/paths";
import { loadCase, loadPreparationSources } from "./loading";
import { candidateHost, secondaryHost, selectedConcurrency } from "./hosts";

type PreparationSources = Awaited<ReturnType<typeof loadPreparationSources>>;

function protectMappedSources(
  invocation: Invocation,
  preparationSources: PreparationSources,
): void {
  const sourceRoots = mappedSourceRoots(preparationSources);
  for (const native of nativeRoutes(invocation)) {
    native.additionalProtectedRoots = [
      ...native.additionalProtectedRoots,
      ...sourceRoots,
    ];
  }
  invocation.shellIsolation?.protectedRoots.push(...sourceRoots);
}

export async function prepareRunInvocation(argv: string[]) {
  const invocation = await parseInvocation(argv);
  warnDeprecatedRuntimeOptions(invocation);
  const preparationSources = await loadPreparationSources(invocation);
  protectMappedSources(invocation, preparationSources);
  const protectedRoots = await invocationProtectedRuntimeRoots(invocation);
  const runtimePolicy = await loadRuntimeConfiguration(
    invocation.projectRoot,
    invocation.runtimeConfigFile,
    protectedRoots,
  );
  requireRuntimeOptionCompatibility(invocation, runtimePolicy);
  selectRuntimeTransport(invocation, runtimePolicy);
  const configRoot = await configurationRoot(invocation.configRoot);
  validateInvocationRuntime(protectedRoots, runtimePolicy);
  const agentConcurrencyLimit = await selectedConcurrency(
    invocation,
    configRoot,
  );
  const caseData = invocation.caseFile
    ? await loadCase(invocation.caseFile)
    : undefined;
  const host = await candidateHost(invocation, agentConcurrencyLimit);
  const semanticHost = await secondaryHost(
    invocation.semanticAdapterModule,
    invocation.semanticCodex,
    agentConcurrencyLimit,
  );
  const advisoryHost = await secondaryHost(
    invocation.advisoryAdapterModule,
    invocation.advisoryCodex,
    agentConcurrencyLimit,
  );
  return {
    invocation,
    runtimePolicy,
    preparationSources,
    caseData,
    host,
    semanticHost,
    advisoryHost,
    agentConcurrencyLimit,
  };
}

function selectRuntimeTransport(
  invocation: Invocation,
  policy: Awaited<ReturnType<typeof loadRuntimeConfiguration>>,
): void {
  if (!runtimeNativeGoalEnabled(policy)) return;
  if (invocation.codex) selectCodexGoalTransport(invocation.codex);
}

function selectCodexGoalTransport(
  codex: NonNullable<Invocation["codex"]>,
): void {
  if (codex.entrypoint === "exec")
    throw new InvocationError(
      "native-goal runtime policy requires Codex app-server",
    );
  codex.entrypoint = "app-server";
}

function warnDeprecatedRuntimeOptions(invocation: Invocation): void {
  for (const option of invocation.deprecatedRuntimeOptions)
    console.warn(
      `--${option} is deprecated; declare the runtime in sevro.json or --runtime-config-file instead`,
    );
}

function requireRuntimeOptionCompatibility(
  invocation: Invocation,
  policy: Awaited<ReturnType<typeof loadRuntimeConfiguration>>,
): void {
  if (policy && invocation.deprecatedRuntimeOptions.length)
    throw new InvocationError(
      "runtime configuration cannot be combined with deprecated runtime options",
    );
}

export type PreparedInvocation = Awaited<
  ReturnType<typeof prepareRunInvocation>
>;

function validateInvocationRuntime(
  protectedRoots: string[],
  policy: Awaited<ReturnType<typeof loadRuntimeConfiguration>>,
): void {
  if (!policy) return;
  requireRuntimeReadRoots(policy.readOnlyRoots, protectedRoots);
  requireRuntimeReadRoots(
    (policy.seeds ?? []).map((seed) => seed.source),
    protectedRoots,
  );
}

async function invocationProtectedRuntimeRoots(
  invocation: Invocation,
): Promise<string[]> {
  const protectedRoots = [
    join(import.meta.dir, "..", ".."),
    invocation.projectRoot,
    invocation.configRoot,
    invocation.resultsRoot,
    invocation.runStateRoot,
    ...nativeRoutes(invocation).flatMap(
      (host) => host.additionalProtectedRoots,
    ),
    ...(invocation.shellIsolation?.protectedRoots ?? []),
  ];
  return Promise.all(protectedRoots.map(canonicalRuntimeRoot));
}

function mappedSourceRoots(preparationSources: PreparationSources): string[] {
  return Object.values(preparationSources?.refs ?? {}).map((url) =>
    fileURLToPath(url),
  );
}
