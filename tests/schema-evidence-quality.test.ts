import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import schema from "../schemas/run-evidence-v1.schema.json";
import { runEvaluation } from "../src/engine";
import { assertRunEvidence } from "../src/schema";
import type { RunEvidenceData } from "../src/schema-types";
import { defined, parseRunEvidence } from "./fixtures/assertions";
import { richCli, richEvidence } from "./quality-fixtures/rich-schema-results";
import { forbiddenJsonTypes } from "./quality-fixtures/quality-evidence-boundaries";
import {
  requiredMutationPaths,
  constraintMutations,
  optionalMutationPaths,
  remove,
  replace,
  type Path,
} from "./quality-fixtures/schema-boundaries";

let root = "";
const documents: { name: string; value: RunEvidenceData }[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sevro-evidence-contract-"));
  const outcome = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    case: {
      id: "ready",
      prompt: "Return ready.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "ready",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
    },
    host: {
      id: "example.host",
      model: "fixture",
      effort: "none",
      run: () => Promise.resolve({ finalMessage: "ready", complete: true }),
    },
  });
  const retained = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  const rich = richEvidence(retained);
  rich.result = richCli(retained.result);
  rich.evaluationIdentity.dimensions.extensionDigest = "d".repeat(64);
  rich.evaluationIdentity.dimensions.extensionProtocol = "sevro.extension.v1";
  const packageEvidence = structuredClone(rich);
  packageEvidence.runner = {
    source: "package",
    packageName: "sevro",
    version: "1.0.0",
    buildDigest: "c".repeat(64),
  };
  for (const [name, value] of [
    ["retained", retained],
    ["rich checkout", rich],
    ["rich package", packageEvidence],
  ] as const) {
    assertRunEvidence(value);
    const path = join(root, `${name.replaceAll(" ", "-")}.json`);
    await writeFile(path, JSON.stringify(value));
    documents.push({
      name,
      value: parseRunEvidence(await readFile(path, "utf8")),
    });
  }
}, 15000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function richBaseline(): RunEvidenceData {
  return defined(
    documents.find((document) => document.name === "rich checkout"),
  ).value;
}

function refuses(value: unknown, context: string): void {
  expect(() => {
    assertRunEvidence(value);
  }, context).toThrow();
}

test("run-evidence files refuse every forbidden JSON type at populated published type boundaries", () => {
  for (const document of documents) {
    assertRunEvidence(document.value);
    for (const mutation of forbiddenJsonTypes(schema, document.value)) {
      const value = replace(
        document.value,
        mutation.path,
        mutation.replacement,
      );
      refuses(
        value,
        `${document.name}:${JSON.stringify(mutation.path)}:${mutation.type}`,
      );
    }
  }
});

test("run-evidence files preserve declared required, scalar, array and closed-object constraints in rich modes", () => {
  for (const document of documents) {
    assertRunEvidence(document.value);
    for (const path of requiredMutationPaths(schema, document.value)) {
      const value = remove(document.value, path);
      refuses(value, `${document.name}:required:${JSON.stringify(path)}`);
    }
    for (const mutation of constraintMutations(schema, document.value)) {
      const value = replace(
        document.value,
        mutation.path,
        mutation.replacement,
      );
      refuses(
        value,
        `${document.name}:constraint:${JSON.stringify(mutation.path)}`,
      );
    }
  }
});

test("run-evidence files allow declared optional evidence to be absent", () => {
  for (const document of documents) {
    assertRunEvidence(document.value);
    for (const path of optionalMutationPaths(schema, document.value)) {
      const value = remove(document.value, path);
      assertRunEvidence(value);
    }
  }
});

interface Boundary {
  name: string;
  path: Path;
  valid: unknown[];
  invalid: unknown[];
}
const numericBoundaries: Boundary[] = [
  {
    name: "positive trial count",
    path: ["evaluationIdentity", "dimensions", "trialCount"],
    valid: [1, 2],
    invalid: [0, -1, 1.5],
  },
  {
    name: "threshold in (0,1]",
    path: ["evaluationIdentity", "dimensions", "passThreshold"],
    valid: [0.001, 1],
    invalid: [0, -0.001, 1.001],
  },
  {
    name: "nonnegative candidate duration",
    path: ["trials", 0, "candidateDurationMs"],
    valid: [null, 0, 0.001],
    invalid: [-0.001],
  },
  {
    name: "nonnegative integer input tokens",
    path: ["trials", 0, "usage", "inputTokens"],
    valid: [null, 0, 1],
    invalid: [-1, 0.5],
  },
  {
    name: "nonnegative integer output tokens",
    path: ["trials", 0, "usage", "outputTokens"],
    valid: [null, 0, 1],
    invalid: [-1, 0.5],
  },
  {
    name: "nonnegative cost",
    path: ["trials", 0, "usage", "costUsd"],
    valid: [null, 0, 0.001],
    invalid: [-0.001],
  },
  {
    name: "integer advisory rating",
    path: ["trials", 0, "advisoryReview", "assessment", "overallScore"],
    valid: [1, 5],
    invalid: [0, 6, 1.5],
  },
];

for (const boundary of numericBoundaries) {
  test(`run-evidence enforces ${boundary.name}`, () => {
    const baseline = richBaseline();
    assertRunEvidence(baseline);
    for (const value of boundary.valid)
      assertRunEvidence(replace(baseline, boundary.path, value));
    for (const invalid of boundary.invalid) {
      const value = replace(baseline, boundary.path, invalid);
      refuses(value, boundary.name);
    }
  });
}

const alternatives: { name: string; path: Path; values: unknown[] }[] = [
  {
    name: "candidate, semantic and advisory routes",
    path: ["routes", 0, "role"],
    values: ["candidate", "semantic", "advisory"],
  },
  {
    name: "domain outcome states",
    path: ["trials", 0, "domainOutcomes", 0, "status"],
    values: ["passed", "failed", "unavailable"],
  },
  {
    name: "unknown and dry execution",
    path: ["trials", 0, "executionMode"],
    values: ["executed", "dry", "unknown"],
  },
  {
    name: "actual condition",
    path: ["condition", "actual"],
    values: ["passive", "enforced", "unknown"],
  },
  {
    name: "nullable policy recommendation",
    path: ["trials", 0, "taskVerdictPolicy", "recommendation"],
    values: ["passed", "failed", "not_assessed", null],
  },
  {
    name: "missing advisory assessment",
    path: ["trials", 0, "advisoryReview", "assessment"],
    values: [null],
  },
  {
    name: "advisory failure states",
    path: ["trials", 0, "advisoryReview", "status"],
    values: ["completed", "failed", "not_run"],
  },
  {
    name: "observation completeness",
    path: ["trials", 0, "observations", 0, "completeness"],
    values: ["complete", "partial", "unavailable"],
  },
  {
    name: "signed metrics and unknown values",
    path: ["trials", 0, "metrics", 0, "value"],
    values: [null, -1, 0, 1.5],
  },
  {
    name: "nullable raw result",
    path: ["trials", 0, "rawResult", "path"],
    values: [null, "file:///tmp/raw"],
  },
  {
    name: "nullable raw digest",
    path: ["trials", 0, "rawResult", "sha256"],
    values: [null, "a".repeat(64)],
  },
  {
    name: "opaque extension observation payload",
    path: ["trials", 0, "observations", 0, "data"],
    values: [
      {
        nativeControl: { requested: true, observed: false },
        records: [null, "private", 1, false, {}],
      },
    ],
  },
];

for (const alternative of alternatives) {
  test(`run-evidence accepts published ${alternative.name} variants`, () => {
    const baseline = richBaseline();
    assertRunEvidence(baseline);
    for (const replacement of alternative.values) {
      const value = replace(baseline, alternative.path, replacement);
      assertRunEvidence(value);
    }
  });
}

test("run-evidence preserves complete and unknown native-control receipts without tool arguments", () => {
  const baseline = richBaseline();
  assertRunEvidence(baseline);
  for (const receipt of [
    {
      completeness: "complete",
      data: {
        method: "native_control_calls",
        calls: [{ ordinal: 1, namespace: "codex", name: "spawn_agent" }],
        acceptedAgentCount: 1,
        submittedExecCalls: 0,
        truncated: false,
      },
    },
    {
      completeness: "partial",
      data: {
        method: "native_control_calls",
        calls: [],
        acceptedAgentCount: null,
        submittedExecCalls: null,
        truncated: null,
      },
    },
  ]) {
    const value = replace(
      baseline,
      ["trials", 0, "observations"],
      [
        {
          id: "sevro.host.native-controls",
          source: "example.host",
          ...receipt,
        },
      ],
    );
    assertRunEvidence(value);
  }
});

test("run-evidence permits redacted host configuration maps and secret-presence markers", () => {
  const baseline = richBaseline();
  assertRunEvidence(baseline);
  const value = replace(baseline, ["configuration", "redacted"], {
    jobs: 3,
    credentialPresent: true,
    hostConfiguration: {
      candidate: { "sevro.codex.agent-concurrency-limit": 2 },
      semantic: { "sevro.codex.agent-concurrency-limit": null },
    },
  });
  assertRunEvidence(value);
});

function assessmentDocument(
  path: Path,
  execution: string,
  grading: string,
  verdict: string,
): unknown {
  const executionValue = replace(richBaseline(), [...path, "execution"], {
    status: execution,
  });
  const gradingValue = replace(executionValue, [...path, "grading"], {
    status: grading,
  });
  return replace(gradingValue, [...path, "task"], { verdict });
}

const assessmentPaths: { name: string; path: Path }[] = [
  { name: "run", path: ["result"] },
  { name: "case", path: ["result", "cases", 0] },
  { name: "trial", path: ["result", "cases", 0, "trials", 0] },
];
const nonPassingStates = [
  { execution: "failed", grading: "completed" },
  { execution: "cancelled", grading: "completed" },
  { execution: "not_run", grading: "completed" },
  { execution: "completed", grading: "error" },
  { execution: "completed", grading: "unavailable" },
  { execution: "completed", grading: "not_requested" },
];

for (const assessment of assessmentPaths) {
  test(`run-evidence allows completed ${assessment.name} assessments to pass`, () => {
    assertRunEvidence(richBaseline());
    const value = assessmentDocument(
      assessment.path,
      "completed",
      "completed",
      "passed",
    );
    assertRunEvidence(value);
  });
  for (const state of nonPassingStates) {
    test(`run-evidence refuses a passed ${assessment.name} task with ${state.execution}/${state.grading}`, () => {
      const valid = assessmentDocument(
        assessment.path,
        state.execution,
        state.grading,
        "not_assessed",
      );
      assertRunEvidence(valid);
      const invalid = replace(
        valid,
        [...assessment.path, "task", "verdict"],
        "passed",
      );
      refuses(
        invalid,
        `${assessment.name}:${state.execution}/${state.grading}`,
      );
    });
  }
}

const nullableRecordBoundaries: Boundary[] = [
  {
    name: "extension ID",
    path: ["extension", "id"],
    valid: ["example.extension"],
    invalid: [""],
  },
  {
    name: "extension version",
    path: ["extension", "version"],
    valid: ["1.0.0"],
    invalid: [""],
  },
  {
    name: "extension protocol",
    path: ["extension", "protocol"],
    valid: ["sevro.extension.v1"],
    invalid: ["foreign.extension.v1"],
  },
  {
    name: "unique negotiated capabilities",
    path: ["extension", "capabilities"],
    valid: [[], ["example.first", "example.second"]],
    invalid: [[""], ["example.first", "example.first"]],
  },
  {
    name: "unique replacement graders",
    path: ["extension", "replacements", "graders"],
    valid: [[], ["example.first", "example.second"]],
    invalid: [[""], ["example.first", "example.first"]],
  },
  {
    name: "selected policy ID",
    path: ["trials", 0, "taskVerdictPolicy", "id"],
    valid: ["example.policy"],
    invalid: [""],
  },
  {
    name: "selected policy recommendation",
    path: ["trials", 0, "taskVerdictPolicy", "recommendation"],
    valid: [null, "not_assessed"],
    invalid: ["unknown"],
  },
  {
    name: "advisory status",
    path: ["trials", 0, "advisoryReview", "status"],
    valid: ["failed"],
    invalid: ["unavailable"],
  },
  {
    name: "advisory verdict",
    path: ["trials", 0, "advisoryReview", "assessment", "verdict"],
    valid: ["pass", "fail"],
    invalid: ["passed"],
  },
  {
    name: "advisory summary",
    path: ["trials", 0, "advisoryReview", "assessment", "summary"],
    valid: ["Reviewed"],
    invalid: [""],
  },
  {
    name: "advisory source",
    path: ["trials", 0, "advisoryReview", "rawResult", "source"],
    valid: ["advisory"],
    invalid: [""],
  },
  ...["correctness", "maintainability", "testQuality", "scopeDiscipline"].map(
    (dimension) => ({
      name: `advisory ${dimension} rating`,
      path: [
        "trials",
        0,
        "advisoryReview",
        "assessment",
        "dimensions",
        dimension,
      ],
      valid: [1, 5],
      invalid: [0, 6, 1.5],
    }),
  ),
  ...["inputTokens", "outputTokens", "costUsd"].map((measurement) => ({
    name: `advisory ${measurement} measurement`,
    path: ["trials", 0, "advisoryReview", "usage", measurement],
    valid: [null, 0, 1],
    invalid: [-1],
  })),
  ...[
    ["extension", "sourceDigest"],
    ["extension", "configurationDigest"],
    ["runner", "dirtyPatchDigest"],
    ["project", "dirtyPatchDigest"],
    ["evaluationIdentity", "dimensions", "extensionDigest"],
    ["trials", 0, "rawResult", "sha256"],
    ["trials", 0, "advisoryReview", "rawResult", "sha256"],
  ].map((path) => ({
    name: `digest spelling at ${path.join("/")}`,
    path,
    valid: ["a".repeat(64)],
    invalid: ["A".repeat(64), "a".repeat(63)],
  })),
  ...[
    ["trials", 0, "rawResult", "path"],
    ["trials", 0, "advisoryReview", "rawResult", "path"],
  ].map((path) => ({
    name: `absolute artifact URL at ${path.join("/")}`,
    path,
    valid: [null, "file:///tmp/raw"],
    invalid: ["https://example.com/private", "file://relative"],
  })),
  {
    name: "trial applied instrumentation declaration",
    path: ["trials", 0, "condition", "appliedInstrumentation"],
    valid: [[], [{ id: "example.instrumentation", configuration: {} }]],
    invalid: [
      [{ configuration: {} }],
      [{ id: "", configuration: {} }],
      [{ id: 42, configuration: {} }],
      [{ id: "example.instrumentation", configuration: [] }],
      [{ id: "example.instrumentation", configuration: {}, extra: true }],
      [null],
    ],
  },
];

test.each(
  nullableRecordBoundaries.map(
    (boundary) => [boundary.name, boundary] as const,
  ),
)("retained nullable records enforce %s", (_name, boundary) => {
  const baseline = richBaseline();
  for (const value of boundary.valid)
    assertRunEvidence(replace(baseline, boundary.path, value));
  for (const value of boundary.invalid)
    refuses(replace(baseline, boundary.path, value), boundary.name);
});

function advisoryBaseline(value: RunEvidenceData) {
  return defined(defined(value.trials[0]).advisoryReview);
}

function advisoryAssessment(value: RunEvidenceData) {
  return defined(advisoryBaseline(value).assessment);
}

const closedEvidenceRecords: {
  name: string;
  path: Path;
  select: (value: RunEvidenceData) => Record<string, unknown>;
}[] = [
  {
    name: "extension",
    path: ["extension"],
    select: (value) => defined(value.extension),
  },
  {
    name: "extension replacements",
    path: ["extension", "replacements"],
    select: (value) => defined(value.extension).replacements,
  },
  {
    name: "task policy",
    path: ["trials", 0, "taskVerdictPolicy"],
    select: (value) => defined(defined(value.trials[0]).taskVerdictPolicy),
  },
  {
    name: "advisory review",
    path: ["trials", 0, "advisoryReview"],
    select: advisoryBaseline,
  },
  {
    name: "advisory assessment",
    path: ["trials", 0, "advisoryReview", "assessment"],
    select: advisoryAssessment,
  },
  {
    name: "advisory dimensions",
    path: ["trials", 0, "advisoryReview", "assessment", "dimensions"],
    select: (value) => advisoryAssessment(value).dimensions,
  },
  {
    name: "advisory usage",
    path: ["trials", 0, "advisoryReview", "usage"],
    select: (value) => advisoryBaseline(value).usage,
  },
  {
    name: "advisory provenance",
    path: ["trials", 0, "advisoryReview", "rawResult"],
    select: (value) => advisoryBaseline(value).rawResult,
  },
];

test.each(
  closedEvidenceRecords.map((boundary) => [boundary.name, boundary] as const),
)(
  "retained %s refuses undeclared fields inside nullable alternatives",
  (_name, boundary) => {
    const baseline = richBaseline();
    const record = boundary.select(baseline);
    assertRunEvidence(replace(baseline, boundary.path, record));
    refuses(
      replace(baseline, boundary.path, { ...record, extra: true }),
      boundary.name,
    );
  },
);

test("retained nullable identities preserve explicitly unknown digests and absent policies", () => {
  const baseline = richBaseline();
  for (const path of [
    ["extension"],
    ["trials", 0, "taskVerdictPolicy"],
    ["trials", 0, "advisoryReview"],
    ["runner", "dirtyPatchDigest"],
    ["project", "dirtyPatchDigest"],
    ["evaluationIdentity", "dimensions", "extensionDigest"],
  ])
    assertRunEvidence(replace(baseline, path, null));
});
