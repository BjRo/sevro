import validExchange from "../../src/generated/extension.cjs";
import { isRecord } from "../../src/value-guards";

function responses(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected configured method responses");
  return value;
}

function request(value: unknown) {
  if (!validExchange(value) || !isRecord(value))
    throw new Error("Invalid request");
  if (typeof value.method !== "string") throw new Error("Missing method");
  return { protocol: value.protocol, id: value.id, method: value.method };
}

const configured = responses(JSON.parse(process.argv[2] ?? "{}") as unknown);
const envelope = request(JSON.parse(await Bun.stdin.text()) as unknown);
process.stdout.write(
  JSON.stringify({ ...envelope, result: configured[envelope.method] }),
);
