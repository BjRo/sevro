export {};

import { createHash } from "node:crypto";

const scenario = process.argv[2] ?? "echo";
const request = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;

if (scenario === "wait") {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

if (scenario === "nonzero") {
  process.stderr.write("private diagnostic\n");
  process.exit(7);
}

if (scenario === "malformed") {
  process.stdout.write("{broken");
  process.exit(0);
}

const discovery = {
  extension: { id: "example.extension", version: "1.0.0" },
  protocols: ["sevro.extension.v1"],
  requiredCapabilities: ["sevro.host.exec"],
  optionalCapabilities: [
    "sevro.host.extra",
    ...(scenario === "lifecycle-instrumentation-supported"
      ? ["example.extension.guard"]
      : []),
    ...(scenario === "lifecycle-instrumentation-observational"
      ? ["example.extension.trace"]
      : []),
    ...(scenario === "lifecycle-setup" ? ["sevro.fixture.setup"] : []),
  ],
  graders: ["example.extension"],
  taskVerdictPolicies: scenario.startsWith("lifecycle-policy")
    ? ["example.policy"]
    : [],
};
let hostArtifactReady = true;
if (scenario === "lifecycle-host-artifact" && request.method === "evaluate") {
  const params = request.params as {
    artifacts?: { id: string; path: string }[];
  };
  const trace = params.artifacts?.find(
    (item) => item.id === "example.host.trace",
  );
  hostArtifactReady = Boolean(
    trace &&
    (await Bun.file(new URL(trace.path))
      .text()
      .catch(() => "")) === "host trace\n",
  );
}
const builtinCheck =
  scenario === "lifecycle-replace-shell"
    ? { id: "ready", grader: "sevro.shell", configuration: { run: "exit 0" } }
    : scenario === "lifecycle-replace-semantic"
      ? {
          id: "ready",
          grader: "sevro.semantic",
          configuration: { proposition: "The response promises readiness." },
        }
      : {
          id: "ready",
          grader: "sevro.regex",
          configuration: {
            pattern:
              scenario.startsWith("lifecycle-policy") ||
              scenario.startsWith("lifecycle-replace")
                ? "never"
                : "ready",
          },
        };
const result = scenario.startsWith("lifecycle")
  ? request.method === "resolve"
    ? {
        cases: [
          {
            id: "extension-case",
            prompt: "Return ready.",
            fixture:
              scenario === "lifecycle-repository"
                ? { kind: "repository", sourceRef: "fixture-repo" }
                : scenario === "lifecycle-generated" ||
                    scenario.startsWith("lifecycle-setup") ||
                    scenario === "lifecycle-git-excluded-artifact"
                  ? {
                      kind: "generated",
                      commits: [
                        {
                          message: "chore: initialize",
                          files: { "README.md": "fixture\n" },
                        },
                      ],
                      ...(scenario === "lifecycle-generated"
                        ? {
                            files: { "README.md": "staged\n" },
                            staged: ["README.md"],
                          }
                        : {}),
                    }
                  : { kind: "inline", files: { "README.md": "fixture\n" } },
            checks: [
              builtinCheck,
              ...(scenario === "lifecycle-replace-no-extension"
                ? []
                : [
                    {
                      id: "example.extension.ready",
                      grader: "example.extension",
                      configuration: {},
                    },
                  ]),
            ],
            requiredEvidence:
              scenario === "lifecycle-host-observation"
                ? ["darrow.activation"]
                : scenario === "lifecycle-host-artifact"
                  ? ["example.host.trace"]
                  : scenario === "lifecycle-policy-unavailable"
                    ? ["example.missing"]
                    : [],
            extensionData: { "example.extension": { marker: "resolved" } },
          },
        ],
      }
    : request.method === "prepare"
      ? {
          artifacts:
            scenario.includes("artifact") ||
            scenario.startsWith("lifecycle-setup")
              ? [
                  {
                    id: "generated-file",
                    relativePath:
                      scenario === "lifecycle-git-excluded-artifact"
                        ? ".agents/skills/example/SKILL.md"
                        : "generated/data.txt",
                    sha256:
                      scenario === "lifecycle-bad-artifact"
                        ? "a".repeat(64)
                        : createHash("sha256")
                            .update(
                              scenario === "lifecycle-executable-artifact"
                                ? "#!/bin/sh\nprintf 'ready\\n'\n"
                                : "prepared data\n",
                            )
                            .digest("hex"),
                    ...(scenario === "lifecycle-source-artifact"
                      ? { sourceRef: "input-data" }
                      : {
                          contentBase64: Buffer.from(
                            scenario === "lifecycle-executable-artifact"
                              ? "#!/bin/sh\nprintf 'ready\\n'\n"
                              : "prepared data\n",
                          ).toString("base64"),
                        }),
                    ...(scenario.startsWith("lifecycle-git-excluded")
                      ? { gitExclude: true }
                      : {}),
                    ...(scenario === "lifecycle-executable-artifact"
                      ? { executable: true }
                      : {}),
                  },
                ]
              : [],
          requestedInstrumentation:
            scenario === "lifecycle-instrumentation-observational"
              ? [{ id: "example.extension.trace", configuration: {} }]
              : scenario === "lifecycle-instrumentation" ||
                  scenario === "lifecycle-instrumentation-supported"
                ? [{ id: "example.extension.guard", configuration: {} }]
                : [],
          ...(scenario.startsWith("lifecycle-setup")
            ? {
                fixtureSetup: {
                  command: [
                    process.execPath,
                    "-e",
                    'if (await Bun.file("generated/data.txt").exists()) throw new Error("artifact mounted early"); await Bun.write("setup.txt", process.env.CASE_ROOT + "\\n");',
                  ],
                  environment: { CASE_ROOT: "{{sevro.project}}/cases" },
                },
              }
            : {}),
          extensionData: { "example.extension": { marker: "prepared" } },
        }
      : request.method === "evaluate"
        ? {
            checks:
              scenario === "lifecycle-missing-check"
                ? []
                : [
                    {
                      id: "example.extension.ready",
                      status: hostArtifactReady ? "passed" : "unavailable",
                      evidenceRefs:
                        scenario === "lifecycle-empty-evidence"
                          ? []
                          : scenario === "lifecycle-host-observation"
                            ? ["darrow.activation"]
                            : scenario === "lifecycle-host-artifact"
                              ? ["example.host.trace"]
                              : ["sevro.observation.final-message"],
                    },
                  ],
            metrics: [
              { id: "example.extension.score", value: 1, unit: "ratio" },
            ],
            ...(scenario.startsWith("lifecycle-domain-outcome")
              ? {
                  domainOutcomes: [
                    {
                      id: "example.extension.activation",
                      status:
                        scenario === "lifecycle-domain-outcome-invalid"
                          ? "passed"
                          : "failed",
                      evidenceRefs:
                        scenario === "lifecycle-domain-outcome-invalid"
                          ? []
                          : ["sevro.observation.final-message"],
                      data: { primarySkill: "other-skill" },
                    },
                  ],
                }
              : {}),
            ...(scenario.startsWith("lifecycle-policy") &&
            scenario !== "lifecycle-policy-missing" &&
            (request.params as Record<string, unknown>)
              .selectedTaskVerdictPolicy === "example.policy"
              ? { taskVerdictRecommendation: "passed" }
              : {}),
          }
        : discovery
  : discovery;
const response = {
  protocol: request.protocol,
  id: scenario === "wrong-id" ? "different" : request.id,
  method: request.method,
  result,
};
if (scenario === "oversized") {
  process.stdout.write("x".repeat(8 * 1024 * 1024 + 1));
  process.exit(0);
}
process.stdout.write(JSON.stringify(response));
