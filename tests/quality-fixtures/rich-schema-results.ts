import type {
  CliResultData,
  RunEvidenceData,
  ReportData,
} from "../../src/schema-types";

const digest = "a".repeat(64);
const route = {
  role: "semantic" as const,
  host: "synthetic",
  model: "fixture",
  effort: "low",
};
const outcomes = [
  {
    id: "example.outcome",
    status: "unavailable" as const,
    detail: "unknown",
    evidenceRefs: ["first", "second"],
    data: { measured: null },
  },
];

export function richCli(source: CliResultData): CliResultData {
  const value = structuredClone(source);
  const selected = value.cases[0];
  const trial = selected?.trials[0];
  if (!selected || !trial)
    throw new Error("Expected an executed schema fixture");
  value.diagnostic = {
    code: "example.partial",
    message: "A measured outcome remains unavailable.",
  };
  trial.domainOutcomes = outcomes;
  trial.checks.push({
    id: "optional",
    grader: "example.grader",
    status: "unavailable",
    detail: "not measured",
    evidenceRefs: ["first", "second"],
  });
  for (const result of [value, selected, trial]) {
    result.execution = { status: "failed", errorCode: "example.execution" };
    result.grading = { status: "error", errorCode: "example.grading" };
    result.task = { verdict: "not_assessed" };
  }
  return value;
}

export function richEvidence(source: RunEvidenceData): RunEvidenceData {
  const value = structuredClone(source);
  const trial = value.trials[0];
  if (!trial) throw new Error("Expected retained trial evidence");
  value.runner = {
    source: "checkout",
    root: "file:///tmp/checkout",
    revision: "revision",
    dirtyPatchDigest: digest,
    buildDigest: digest,
  };
  value.project = {
    root: "file:///tmp/project",
    revision: "revision",
    dirtyPatchDigest: digest,
  };
  value.extension = {
    id: "example.extension",
    version: "1.0.0",
    sourceDigest: digest,
    configurationDigest: digest,
    protocol: "sevro.extension.v1",
    capabilities: ["example.first", "example.second"],
    replacements: {
      graders: ["example.grader"],
      taskVerdictPolicy: "example.policy",
    },
  };
  value.condition.requestedInstrumentation = [
    { id: "example.enforcement", configuration: { active: true } },
  ];
  value.condition.appliedInstrumentation =
    value.condition.requestedInstrumentation;
  value.graders.active.push({
    id: "example.grader",
    source: "extension",
    version: "1.0.0",
  });
  value.graders.replacedDefaults = ["sevro.regex"];
  value.routes.push(route);
  value.diagnostic = {
    code: "example.notice",
    message: "Retained rich evidence",
  };
  enrichTrial(trial);
  return value;
}

function enrichTrial(trial: RunEvidenceData["trials"][number]): void {
  trial.candidateDurationMs = 0.5;
  trial.observations.push({
    id: "example.observation",
    source: "extension",
    completeness: "partial",
    data: { partial: true },
  });
  trial.metrics = [
    { id: "example.duration", value: 0.5, unit: "seconds" },
    { id: "example.unknown", value: null, unit: "count" },
  ];
  trial.domainOutcomes = outcomes;
  trial.taskVerdictPolicy = {
    id: "example.policy",
    recommendation: "not_assessed",
  };
  trial.routes.push(route);
  trial.rawResult = { source: "host", path: "file:///tmp/raw", sha256: digest };
  trial.artifactRefs = [
    {
      id: "first",
      path: "file:///tmp/artifact",
      sha256: digest,
      gitExclude: true,
      executable: false,
    },
  ];
  trial.advisoryReview = {
    status: "completed",
    assessment: {
      verdict: "pass",
      overallScore: 5,
      dimensions: {
        correctness: 5,
        maintainability: 5,
        testQuality: 5,
        scopeDiscipline: 5,
      },
      strengths: ["clear", "focused"],
      weaknesses: ["bounded"],
      summary: "Independent review",
    },
    usage: { inputTokens: 0, outputTokens: 1, costUsd: 0.001, complete: true },
    rawResult: {
      source: "advisory",
      path: "file:///tmp/review",
      sha256: digest,
    },
  };
}

export function richReport(source: ReportData): ReportData {
  const value = structuredClone(source);
  const row = value.rows[0];
  if (!row) throw new Error("Expected a report row");
  row.runnerBuildDigest = digest;
  row.evaluationDigest = digest;
  row.candidateRoute = { host: "synthetic", model: "fixture", effort: "low" };
  row.routes.push(route);
  row.domainOutcomes = [
    { trial: 1, id: "example.outcome", status: "unavailable" },
    { trial: 2, id: "example.other", status: "failed" },
  ];
  return value;
}
