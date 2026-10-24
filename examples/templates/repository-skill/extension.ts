import { description, prepare, resolved } from "./extension-data";
import { readFileSync } from "node:fs";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a protocol request object");
  return value as Record<string, unknown>;
}

const request = record(JSON.parse(readFileSync(0, "utf8")) as unknown);
async function result() {
  switch (request.method) {
    case "describe":
      return description;
    case "resolve":
      return resolved;
    case "prepare":
      return await prepare();
    case "evaluate":
      return { checks: [], metrics: [] };
    default:
      throw new Error("Unsupported extension method");
  }
}
process.stdout.write(
  JSON.stringify({
    protocol: request.protocol,
    id: request.id,
    method: request.method,
    result: await result(),
  }),
);
