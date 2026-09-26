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

const result = {
  extension: { id: "example.extension", version: "1.0.0" },
  protocols: ["sevro.extension.v1"],
  requiredCapabilities: ["sevro.host.exec"],
  optionalCapabilities: ["sevro.host.extra"],
  graders: [],
  taskVerdictPolicies: [],
};
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
