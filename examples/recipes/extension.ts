import { readFileSync } from "node:fs";
import {
  describe,
  evaluate,
  prepare,
  record,
  resolveCase,
} from "./extension-methods";

const mode = process.argv[2] ?? "lifecycle";
const host = process.argv[3] ?? "deterministic";
const fail = process.argv[4] === "fail";
const request = record(JSON.parse(readFileSync(0, "utf8")) as unknown);

async function result() {
  switch (request.method) {
    case "describe":
      return describe(mode, host);
    case "resolve":
      return resolveCase(mode, host, fail);
    case "prepare":
      return await prepare(mode, host);
    case "evaluate":
      return evaluate(record(request.params));
    default:
      throw new Error("Unsupported extension method");
  }
}

// One request per process; stdout contains only the matching protocol response.
process.stdout.write(
  JSON.stringify({
    protocol: request.protocol,
    id: request.id,
    method: request.method,
    result: await result(),
  }),
);
