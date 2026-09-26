export {};

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
  graders: [],
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
            ],
            requiredEvidence: [],
            extensionData: { "example.extension": { marker: "resolved" } },
          },
        ],
      }
    : request.method === "prepare"
      ? {
          artifacts: [],
          requestedInstrumentation: [],
          extensionData: { "example.extension": { marker: "prepared" } },
        }
      : request.method === "evaluate"
        ? {
            checks: [
              {
                id: "example.extension.ready",
                status: "passed",
                evidenceRefs:
                  scenario === "lifecycle-empty-evidence"
                    ? []
                    : ["sevro.observation.final-message"],
              },
            ],
            metrics: [],
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
