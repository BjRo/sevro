import { runEvaluation } from "../engine";
import {
  packageBuildDigest,
  projectIdentityDigest,
  projectProvenance,
} from "../provenance";
import { selectedCase } from "./extension";
import type { PreparedInvocation } from "./preparation";
import { assessmentSettings, effectiveSettings } from "./settings";
import { displayProgress } from "./progress";

export async function evaluateInvocation(
  prepared: PreparedInvocation,
  signal: AbortSignal,
) {
  const { invocation, preparationSources, host, semanticHost, advisoryHost } =
    prepared;
  const { caseData, extension } = await selectedCase(prepared, signal);
  return runEvaluation({
    onProgress: displayProgress,
    resolvedRunSettings: effectiveSettings(prepared),
    assessmentSettings: assessmentSettings(prepared),
    runtimePolicy: prepared.runtimePolicy,
    projectRoot: invocation.projectRoot,
    resultsRoot: invocation.resultsRoot,
    runStateRoot: invocation.runStateRoot,
    case: caseData,
    extension,
    preparationSources,
    host,
    semanticHost,
    advisoryHost,
    advisoryExcludedPaths: invocation.advisoryExcludedPaths,
    shellIsolation: invocation.shellIsolation,
    runnerBuildDigest:
      invocation.runnerBuildDigest ?? (await packageBuildDigest()),
    runnerCheckoutRoot: invocation.runnerCheckoutRoot,
    projectDigest:
      invocation.projectDigest ??
      (await projectIdentityDigest(
        invocation.projectRoot,
        await projectProvenance(invocation.projectRoot, [
          invocation.resultsRoot,
          invocation.runStateRoot,
        ]),
        [invocation.resultsRoot, invocation.runStateRoot],
      )),
    condition: invocation.condition,
    trialCount: invocation.trialCount,
    jobs: invocation.jobs,
    passThreshold: invocation.passThreshold,
    dry: invocation.dry,
    signal,
  });
}
