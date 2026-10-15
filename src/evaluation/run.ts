import { prepareEvaluation, type PreparedEvaluation } from "./plan";
import { type CliResult, type EvaluationOptions } from "./types";
import { canonicalJson, hashJson } from "../identity";
import { exitCodeFor, summarizeCases } from "../results";
import { runtimePolicySnapshot } from "../runtime/config";
import { cleanupExpiredWorkspaces } from "../fixtures/workspace-state";
import { assertCliResult, assertRunEvidence } from "../schema";
import { atomicWriteJson } from "../storage";
import {
  allocateRunResources,
  retainPreparationArtifacts,
  type RunResources,
} from "./resources";
import type { EvaluationContext } from "./context";
import { ResultCollector, type CollectedResults } from "./collection";
import { executeEvaluationTrials } from "./trial";
import { evaluationProgress } from "./progress";

function evaluationSignal(
  options: EvaluationOptions,
): "SIGINT" | "SIGTERM" | undefined {
  const reason: unknown = options.signal?.aborted
    ? options.signal.reason
    : null;
  return reason === "SIGINT" || reason === "SIGTERM" ? reason : undefined;
}

function finalCliResult(
  options: EvaluationOptions,
  resources: RunResources,
  collected: CollectedResults,
): CliResult {
  const caseResult = collected.caseSummary;
  const assessment = summarizeCases([caseResult]);
  const diagnostic = collected.diagnostic;
  return {
    format: "sevro.cli-result.v1",
    runId: resources.runId,
    ...assessment,
    exitCode: exitCodeFor(assessment, {
      dryRun: options.dry,
      signal: evaluationSignal(options),
    }),
    evidencePath: resources.evidencePath,
    cases: [caseResult],
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function finalConditionEvidence(
  options: Pick<EvaluationOptions, "condition" | "trialCount">,
  requestedInstrumentation: PreparedEvaluation["requestedInstrumentation"],
  trials: CollectedResults["trials"],
) {
  const actualConditions = [
    ...new Set(trials.map((entry) => entry.condition.actual)),
  ];
  const commonAppliedInstrumentation =
    trials.length === options.trialCount &&
    trials.every(
      (entry) =>
        canonicalJson(entry.condition.appliedInstrumentation) ===
        canonicalJson(requestedInstrumentation),
    )
      ? requestedInstrumentation
      : [];
  return {
    requested: options.condition,
    actual: actualConditions.length === 1 ? actualConditions[0] : "unknown",
    requestedInstrumentation,
    appliedInstrumentation: commonAppliedInstrumentation,
  };
}

function finalExtensionEvidence(
  options: EvaluationOptions,
  replacedBuiltinGraders: string[],
) {
  const extension = options.extension;
  if (!extension) return null;
  const identity = extension.session.identity;
  return {
    id: identity.id,
    version: identity.version,
    sourceDigest: identity.sourceDigest,
    configurationDigest: identity.configurationDigest,
    protocol: identity.protocol,
    capabilities: identity.capabilities,
    replacements: {
      graders: replacedBuiltinGraders,
      taskVerdictPolicy: identity.selectedTaskVerdictPolicy,
    },
  };
}

function finalRunEvidence(
  options: EvaluationOptions,
  prepared: PreparedEvaluation,
  resources: RunResources,
  collected: CollectedResults,
  result: CliResult,
) {
  const condition = finalConditionEvidence(
    options,
    prepared.requestedInstrumentation,
    collected.trials,
  );
  const diagnostic = collected.diagnostic;
  return {
    format: "sevro.run-evidence.v1",
    runId: resources.runId,
    evaluationIdentity: prepared.evaluationIdentity,
    configuration: {
      digest: hashJson(prepared.redactedConfig),
      redacted: prepared.redactedConfig,
      ...(options.resolvedRunSettings
        ? { resolved: options.resolvedRunSettings }
        : {}),
    },
    runner: prepared.runner,
    project: prepared.project,
    extension: finalExtensionEvidence(
      options,
      prepared.checks.replacedBuiltinGraders,
    ),
    condition,
    graders: {
      active: prepared.activeGraders,
      replacedDefaults: prepared.checks.replacedBuiltinGraders,
    },
    routes: prepared.routes,
    result,
    trials: collected.trials,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

async function finishEvaluationRun(
  options: EvaluationOptions,
  context: EvaluationContext,
) {
  const collected = context.results.snapshot({
    caseId: options.case.id,
    passThreshold: options.passThreshold,
    cancelled: Boolean(options.signal?.aborted),
  });
  const result = finalCliResult(options, context.resources, collected);
  const evidence = finalRunEvidence(
    options,
    context.prepared,
    context.resources,
    collected,
    result,
  );
  assertCliResult(result);
  assertRunEvidence(evidence);
  evaluationProgress(options, "evidence", "started");
  await atomicWriteJson(context.resources.evidencePath, evidence);
  context.results.checkpoint(
    options.signal?.aborted ? "interrupted" : "complete",
  );
  evaluationProgress(options, "evidence", "completed");
  return { result };
}

/** Execute resolved evaluator data through an injected host and retain every trial. */
export async function runEvaluation(
  options: EvaluationOptions,
): Promise<{ result: CliResult }> {
  options = {
    ...options,
    runtimePolicy: runtimePolicySnapshot(options.runtimePolicy),
  };
  evaluationProgress(options, "preparation", "started");
  await cleanupExpiredWorkspaces();
  const prepared = await prepareEvaluation(options);
  const resources = await allocateRunResources(
    options,
    prepared.evaluationIdentity.digest,
  );
  const results = new ResultCollector(resources.owner);
  try {
    const preparationArtifacts = await retainPreparationArtifacts(
      prepared.fixture.inlineArtifacts,
      resources.runDir,
    );
    await resources.workspaces.reserve({
      count: options.trialCount,
      semantic: prepared.checks.preparedSemantic.length > 0,
      signal: options.signal,
    });
    const context: EvaluationContext = {
      prepared,
      resources,
      results,
      preparationArtifacts,
    };
    await executeEvaluationTrials(options, context);
    return await finishEvaluationRun(options, context);
  } catch (error) {
    results.diagnoseFailure();
    throw error;
  } finally {
    await resources.workspaces.cleanup();
  }
}
