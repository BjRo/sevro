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
  optionalCapabilities: ["sevro.host.extra"],
  graders: ["example.extension"],
  taskVerdictPolicies: [],
};
const result = scenario.startsWith("lifecycle")
  ? request.method === "resolve"
    ? {
        cases: [
          {
            id: "extension-case",
            prompt: "Return ready.",
            fixture: { kind: "inline", files: { "README.md": "fixture\n" } },
            checks: [
              {
                id: "ready",
                grader: "sevro.regex",
                configuration: { pattern: "ready" },
              },
              {
                id: "example.extension.ready",
                grader: "example.extension",
                configuration: {},
              },
            ],
            requiredEvidence: [],
            extensionData: { "example.extension": { marker: "resolved" } },
          },
        ],
      }
    : request.method === "prepare"
      ? {
          artifacts: scenario.includes("artifact")
            ? [
                {
                  id: "generated-file",
                  relativePath: "generated/data.txt",
                  sha256:
                    scenario === "lifecycle-bad-artifact"
                      ? "a".repeat(64)
                      : createHash("sha256")
                          .update("prepared data\n")
                          .digest("hex"),
                  contentBase64:
                    Buffer.from("prepared data\n").toString("base64"),
                },
              ]
            : [],
          requestedInstrumentation:
            scenario === "lifecycle-instrumentation"
              ? [{ id: "example.extension.guard", configuration: {} }]
              : [],
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
                      status: "passed",
                      evidenceRefs:
                        scenario === "lifecycle-empty-evidence"
                          ? []
                          : ["sevro.observation.final-message"],
                    },
                  ],
            metrics: [
              { id: "example.extension.score", value: 1, unit: "ratio" },
            ],
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
