import { prepareEvaluation } from "./evaluation-plan";
import {
  type CaseSummary,
  type CliResult,
  type EvaluationOptions,
} from "./evaluation-types";
import { canonicalJson, hashJson } from "./identity";
import {
  exitCodeFor,
  summarizeAssessments,
  summarizeCases,
  type Assessment,
} from "./results";
import { runtimePolicySnapshot } from "./runtime-config";
import { assertCliResult, assertRunEvidence } from "./schema";
import { atomicWriteJson } from "./storage";
import {
  allocateEvaluationRun,
  checkpointEvaluation,
  cleanupEvaluationWorkspaces,
  diagnoseEvaluationFailure,
  reserveEvaluationWorkspaces,
  retainPreparationArtifacts,
  type EvaluationContext,
} from "./evaluation-context";
import { executeEvaluationTrials } from "./evaluation-trial";

function evaluationCaseSummary(
  options: EvaluationOptions,
  context: EvaluationContext,
): CaseSummary {
  const assessment: Assessment =
    !context.trialSummaries.length && options.signal?.aborted
      ? {
          execution: { status: "cancelled" },
          grading: { status: "not_requested" },
          task: { verdict: "not_assessed" },
        }
      : summarizeAssessments(context.trialSummaries, options.passThreshold);
  return {
    caseId: options.case.id,
    ...assessment,
    trials: context.trialSummaries,
  };
}

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
  context: EvaluationContext,
): CliResult {
  const caseResult = evaluationCaseSummary(options, context);
  const assessment = summarizeCases([caseResult]);
  const diagnostic = context.diagnostics.sort(
    (left, right) => left.trial - right.trial,
  )[0]?.diagnostic;
  return {
    format: "sevro.cli-result.v1",
    runId: context.runId,
    ...assessment,
    exitCode: exitCodeFor(assessment, {
      dryRun: options.dry,
      signal: evaluationSignal(options),
    }),
    evidencePath: context.evidencePath,
    cases: [caseResult],
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function finalConditionEvidence(
  options: EvaluationOptions,
  context: EvaluationContext,
) {
  const actualConditions = [
    ...new Set(context.trialEvidence.map((entry) => entry.condition.actual)),
  ];
  const commonAppliedInstrumentation =
    context.trialEvidence.length === options.trialCount &&
    context.trialEvidence.every(
      (entry) =>
        canonicalJson(entry.condition.appliedInstrumentation) ===
        canonicalJson(context.requestedInstrumentation),
    )
      ? context.requestedInstrumentation
      : [];
  return {
    requested: options.condition,
    actual: actualConditions.length === 1 ? actualConditions[0] : "unknown",
    requestedInstrumentation: context.requestedInstrumentation,
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
  context: EvaluationContext,
  result: CliResult,
  diagnostic: { code: string; message: string } | undefined,
) {
  const condition = finalConditionEvidence(options, context);
  return {
    format: "sevro.run-evidence.v1",
    runId: context.runId,
    evaluationIdentity: context.evaluationIdentity,
    configuration: {
      digest: hashJson(context.redactedConfig),
      redacted: context.redactedConfig,
    },
    runner: context.runner,
    project: context.project,
    extension: finalExtensionEvidence(options, context.replacedBuiltinGraders),
    condition,
    graders: {
      active: context.activeGraders,
      replacedDefaults: context.replacedBuiltinGraders,
    },
    routes: context.routes,
    result,
    trials: context.trialEvidence,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

async function finishEvaluationRun(
  options: EvaluationOptions,
  context: EvaluationContext,
) {
  const diagnostic = context.diagnostics.sort(
    (left, right) => left.trial - right.trial,
  )[0]?.diagnostic;
  const result = finalCliResult(options, context);
  const evidence = finalRunEvidence(options, context, result, diagnostic);
  assertCliResult(result);
  assertRunEvidence(evidence);
  await atomicWriteJson(context.evidencePath, evidence);
  checkpointEvaluation(
    context,
    options.signal?.aborted ? "interrupted" : "complete",
  );
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
  const plan = await prepareEvaluation(options);
  const runtime = await allocateEvaluationRun(options, plan);
  try {
    const artifacts = await retainPreparationArtifacts({ ...plan, ...runtime });
    const records = await reserveEvaluationWorkspaces(options, {
      ...plan,
      ...runtime,
    });
    const context = { ...plan, ...runtime, ...artifacts, ...records };
    await executeEvaluationTrials(options, context);
    return await finishEvaluationRun(options, context);
  } catch (error) {
    diagnoseEvaluationFailure(runtime);
    throw error;
  } finally {
    await cleanupEvaluationWorkspaces(runtime);
  }
}
