import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import packageJson from "../package.json";
import {
  gradeOutput,
  prepareOutputChecks,
  type OutputCheckDeclaration,
} from "./graders/output";
import { createEvaluationIdentity, hashJson } from "./identity";
import {
  assessTrial,
  exitCodeFor,
  summarizeAssessments,
  summarizeCases,
  type Assessment,
  type CheckOutcome,
} from "./results";
import { assertCliResult, assertRunEvidence } from "./schema";
import { atomicWriteJson } from "./storage";

const MAX_FINAL_MESSAGE_BYTES = 8 * 1024 * 1024;

export interface HostResult {
  finalMessage: string | null;
  complete: boolean;
  actualCondition?: "passive" | "enforced" | "unknown";
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  usageComplete?: boolean;
}

export interface HostAdapter {
  id: string;
  model: string;
  effort: string;
  run(request: {
    prompt: string;
    workspace: string;
    condition: "passive" | "enforced";
    signal?: AbortSignal;
  }): Promise<HostResult>;
}

export interface ResolvedCase {
  id: string;
  prompt: string;
  fixture: { files: Record<string, string> };
  checks: OutputCheckDeclaration[];
  requiredEvidence: string[];
}

export interface EvaluationOptions {
  projectRoot: string;
  resultsRoot: string;
  case: ResolvedCase;
  host: HostAdapter;
  runnerBuildDigest: string;
  projectDigest: string;
  condition: "passive" | "enforced";
  trialCount: number;
  passThreshold: number;
  signal?: AbortSignal;
}

interface TrialSummary extends Assessment {
  trial: number;
  checks: CheckOutcome[];
  artifactPath: string;
}

interface CaseSummary extends Assessment {
  caseId: string;
  trials: TrialSummary[];
}

export interface CliResult extends Assessment {
  format: "sevro.cli-result.v1";
  runId: string;
  exitCode: number;
  evidencePath: string;
  cases: CaseSummary[];
}

function fixtureParts(relativePath: string): string[] {
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    /:/.test(relativePath)
  )
    throw new Error(`invalid fixture path: ${relativePath}`);
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error(`invalid fixture path: ${relativePath}`);
  return parts;
}

async function createFixture(files: Record<string, string>): Promise<string> {
  const paths = Object.entries(files).map(([path, content]) => ({
    path,
    parts: fixtureParts(path),
    content,
  }));
  const workspace = await mkdtemp(join(tmpdir(), "sevro-case-"));
  try {
    for (const file of paths) {
      const target = join(workspace, ...file.parts);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { flag: "wx", mode: 0o600 });
    }
    return workspace;
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function usage(result: HostResult | null) {
  return {
    inputTokens: result?.inputTokens ?? null,
    outputTokens: result?.outputTokens ?? null,
    costUsd: result?.costUsd ?? null,
    complete: result?.usageComplete ?? false,
  };
}

/** Execute resolved evaluator data through an injected host and retain every trial. */
export async function runEvaluation(
  options: EvaluationOptions,
): Promise<{ result: CliResult }> {
  if (!isAbsolute(options.projectRoot) || !isAbsolute(options.resultsRoot))
    throw new Error("project and results roots must be absolute");
  if (
    !options.case.id ||
    !options.case.prompt ||
    !options.host.id ||
    !options.host.model ||
    !options.host.effort
  )
    throw new Error("case and host identities must be nonempty");
  if (!Number.isSafeInteger(options.trialCount) || options.trialCount < 1)
    throw new Error("trial count must be a positive integer");
  if (
    !Number.isFinite(options.passThreshold) ||
    options.passThreshold <= 0 ||
    options.passThreshold > 1
  )
    throw new Error("pass threshold must be greater than zero and at most one");
  if (options.case.requiredEvidence.length)
    throw new Error(
      "required host evidence is not supported by this engine path",
    );
  const prepared = prepareOutputChecks(options.case.checks);
  for (const path of Object.keys(options.case.fixture.files))
    fixtureParts(path);

  const projectRoot = await realpath(options.projectRoot);
  const runId = randomUUID();
  const route = {
    role: "candidate",
    host: options.host.id,
    model: options.host.model,
    effort: options.host.effort,
  };
  const redactedConfig = {
    condition: options.condition,
    trialCount: options.trialCount,
    passThreshold: options.passThreshold,
  };
  const activeGraders = [
    ...new Set(options.case.checks.map((check) => check.grader)),
  ]
    .sort()
    .map((id) => ({ id, source: "builtin", version: "1.0.0" }));
  const evaluationIdentity = createEvaluationIdentity({
    runnerBuildDigest: options.runnerBuildDigest,
    projectDigest: options.projectDigest,
    configurationDigest: hashJson(redactedConfig),
    extensionDigest: null,
    extensionProtocol: null,
    caseDigest: hashJson({ id: options.case.id, prompt: options.case.prompt }),
    fixtureDigest: hashJson(options.case.fixture.files),
    checksDigest: hashJson(options.case.checks),
    requiredEvidenceDigest: hashJson(options.case.requiredEvidence),
    evaluatorDigest: hashJson({ policy: "sevro.builtin-output.v1" }),
    graderDigest: hashJson(activeGraders),
    instrumentationDigest: hashJson({ requested: [], applied: [] }),
    routeDigest: hashJson(route),
    condition: options.condition,
    trialCount: options.trialCount,
    passThreshold: options.passThreshold,
  });

  await mkdir(options.resultsRoot, { recursive: true, mode: 0o700 });
  const runDir = resolve(await realpath(options.resultsRoot), runId);
  await mkdir(runDir, { mode: 0o700 });

  const trialSummaries: TrialSummary[] = [];
  const trialEvidence: Record<string, unknown>[] = [];
  let diagnostic: { code: string; message: string } | undefined;
  for (let trial = 1; trial <= options.trialCount; trial++) {
    const workspace = await createFixture(options.case.fixture.files);
    let persisted = false;
    try {
      let hostResult: HostResult | null = null;
      let execution: "completed" | "failed" | "cancelled" = "completed";
      try {
        if (options.signal?.aborted) throw new Error("cancelled");
        hostResult = await options.host.run({
          prompt: options.case.prompt,
          workspace,
          condition: options.condition,
          signal: options.signal,
        });
        if (
          hostResult.finalMessage !== null &&
          Buffer.byteLength(hostResult.finalMessage, "utf8") >
            MAX_FINAL_MESSAGE_BYTES
        )
          throw new Error("oversized host result");
      } catch {
        execution = options.signal?.aborted ? "cancelled" : "failed";
        hostResult = null;
        diagnostic = {
          code: "sevro.host.failed",
          message: "host execution did not complete",
        };
      }
      let checks: CheckOutcome[] = [];
      let graderError = false;
      if (execution === "completed") {
        try {
          checks = gradeOutput(
            hostResult!.finalMessage,
            hostResult!.complete,
            prepared,
          );
        } catch {
          graderError = true;
          diagnostic = {
            code: "sevro.grader.error",
            message: "output grading did not complete",
          };
        }
      }
      const assessment = assessTrial({
        execution,
        declaredChecks: options.case.checks.map((check) => check.id),
        checks,
        graderError,
      });
      const rawPath =
        hostResult?.finalMessage !== null &&
        hostResult?.finalMessage !== undefined
          ? join(runDir, `trial-${trial}-raw.txt`)
          : null;
      if (rawPath) {
        try {
          await writeFile(rawPath, hostResult!.finalMessage!, {
            flag: "wx",
            mode: 0o600,
          });
        } catch {
          throw new Error(
            `trial persistence failed; fixture retained at ${workspace}`,
          );
        }
      }
      const rawDigest =
        hostResult?.finalMessage == null
          ? null
          : sha256(hostResult.finalMessage);
      const completeness =
        hostResult?.finalMessage == null
          ? "unavailable"
          : hostResult.complete
            ? "complete"
            : "partial";
      const observation = {
        id: "sevro.observation.final-message",
        source: options.host.id,
        completeness,
        data: rawDigest
          ? {
              sha256: rawDigest,
              byteLength: Buffer.byteLength(hostResult!.finalMessage!, "utf8"),
            }
          : {},
      };
      const evidence = {
        caseId: options.case.id,
        trial,
        executionMode: "executed",
        condition: {
          requested: options.condition,
          actual: hostResult?.actualCondition ?? "unknown",
          appliedInstrumentation: [],
        },
        observationCompleteness: completeness,
        observations: [observation],
        routes: [route],
        usage: usage(hostResult),
        rawResult: {
          source: options.host.id,
          path: rawPath ? pathToFileURL(rawPath).href : null,
          sha256: rawDigest,
        },
        artifactRefs: [],
      };
      const artifactPath = join(runDir, `trial-${trial}.json`);
      const trialSummary: TrialSummary = {
        trial,
        ...assessment,
        checks,
        artifactPath,
      };
      try {
        await atomicWriteJson(artifactPath, {
          format: "sevro.trial-evidence.v1",
          caseId: options.case.id,
          trial,
          result: trialSummary,
          evidence,
        });
      } catch {
        throw new Error(
          `trial persistence failed; fixture retained at ${workspace}`,
        );
      }
      persisted = true;
      trialSummaries.push(trialSummary);
      trialEvidence.push(evidence);
      if (execution !== "completed" || graderError) break;
    } finally {
      if (persisted) {
        try {
          await rm(workspace, { recursive: true, force: true });
        } catch {
          console.warn(`fixture cleanup failed; retained at ${workspace}`);
        }
      }
    }
  }

  const caseAssessment = summarizeAssessments(
    trialSummaries,
    options.passThreshold,
  );
  const caseResult: CaseSummary = {
    caseId: options.case.id,
    ...caseAssessment,
    trials: trialSummaries,
  };
  const runAssessment = summarizeCases([caseResult]);
  const evidencePath = join(runDir, "run.json");
  const result: CliResult = {
    format: "sevro.cli-result.v1",
    runId,
    ...runAssessment,
    exitCode: exitCodeFor(runAssessment),
    evidencePath,
    cases: [caseResult],
  };
  const actualConditions = [
    ...new Set(
      trialEvidence.map(
        (entry) => (entry.condition as { actual: string }).actual,
      ),
    ),
  ];
  const runEvidence = {
    format: "sevro.run-evidence.v1",
    runId,
    evaluationIdentity,
    configuration: {
      digest: hashJson(redactedConfig),
      redacted: redactedConfig,
    },
    runner: {
      source: "package",
      packageName: packageJson.name,
      version: packageJson.version,
      buildDigest: options.runnerBuildDigest,
    },
    project: {
      root: pathToFileURL(projectRoot).href,
      revision: null,
      dirtyPatchDigest: null,
    },
    extension: null,
    condition: {
      requested: options.condition,
      actual: actualConditions.length === 1 ? actualConditions[0] : "unknown",
      requestedInstrumentation: [],
      appliedInstrumentation: [],
    },
    graders: { active: activeGraders, replacedDefaults: [] },
    routes: [route],
    result,
    trials: trialEvidence,
    ...(diagnostic ? { diagnostic } : {}),
  };
  assertCliResult(result);
  assertRunEvidence(runEvidence);
  await atomicWriteJson(evidencePath, runEvidence);
  return { result };
}
