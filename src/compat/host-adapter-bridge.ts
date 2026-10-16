import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { HostAdapter } from "../evaluation/types";

type Request =
  | { id: string; method: "load"; module: string }
  | { id: string; method: "run"; request: Parameters<HostAdapter["run"]>[0] }
  | { id: string; method: "abort"; reason: string }
  | { id: string; method: "shutdown" };

type ImportInterrupt = {
  id: string;
  method: "interrupt-import";
  reason: "SIGINT" | "SIGTERM";
  exitCode: number;
};

const socketPath = process.argv[2];
assert(socketPath, "adapter bridge requires its private socket");
const socket = createConnection(socketPath);
const lines = createInterface({ input: socket });
let host: HostAdapter;
const active = new Map<string, AbortController>();

type JsonConfiguration =
  | null
  | boolean
  | number
  | string
  | JsonConfiguration[]
  | { [key: string]: JsonConfiguration };

function snapshotJsonConfiguration(value: unknown): JsonConfiguration {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value))
        throw new Error("adapter configuration contains a non-finite number");
      return value;
    case "object":
      return value === null ? null : snapshotConfigurationObject(value);
    default:
      throw new Error("adapter configuration contains a non-JSON value");
  }
}

function snapshotConfigurationObject(value: object): JsonConfiguration {
  if (Array.isArray(value)) return value.map(snapshotJsonConfiguration);
  assertPlainConfigurationObject(value);
  const snapshot = Object.create(null) as Record<string, JsonConfiguration>;
  for (const key of Object.keys(value))
    snapshot[key] = snapshotConfigurationProperty(value, key);
  return snapshot;
}

function assertPlainConfigurationObject(value: object): void {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("adapter configuration contains a nonplain object");
  if (Object.getOwnPropertySymbols(value).length)
    throw new Error("adapter configuration contains symbol keys");
}

function snapshotConfigurationProperty(
  value: object,
  key: string,
): JsonConfiguration {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value"))
    throw new Error("adapter configuration contains an accessor property");
  const child: unknown = descriptor.value;
  return snapshotJsonConfiguration(child);
}

function validatedResult(value: unknown) {
  if (typeof value !== "object" || value === null)
    throw new Error("invalid host result");
  const finalMessage = (value as { finalMessage?: unknown }).finalMessage;
  if (finalMessage !== null && typeof finalMessage !== "string")
    throw new Error("invalid host final message");
  const artifacts = encodedArtifacts(
    (value as { artifacts?: unknown }).artifacts,
  );
  const receipt = { ...value, artifacts, toJSON: undefined };
  return { receipt, retainedEvidenceIssue: retainedEvidenceIssue(receipt) };
}

function retainedEvidenceIssue(receipt: object) {
  const costUsd = (receipt as { costUsd?: unknown }).costUsd;
  return Number.isNaN(costUsd) ? "nan_cost" : null;
}

function encodedArtifacts(value: unknown) {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error("invalid host artifacts");
  if (value.length > 32) throw new Error("too many host artifacts");
  const artifacts = value.map(validatedArtifact);
  assertArtifactSizes(artifacts);
  return artifacts.map(({ id, bytes }) => ({
    id,
    bytes: Buffer.from(bytes).toString("base64"),
  }));
}

function validatedArtifact(item: unknown) {
  if (typeof item !== "object" || item === null)
    throw new Error("invalid host artifact");
  const { id, bytes } = item as { id?: unknown; bytes?: unknown };
  if (typeof id !== "string") throw new Error("invalid host artifact id");
  if (!(bytes instanceof Uint8Array))
    throw new Error("invalid host artifact bytes");
  return { id, bytes };
}

function assertArtifactSizes(artifacts: { bytes: Uint8Array }[]) {
  if (artifacts.some(({ bytes }) => bytes.byteLength > 8 * 1024 * 1024))
    throw new Error("host artifact exceeds the size limit");
  const total = artifacts.reduce((sum, { bytes }) => sum + bytes.byteLength, 0);
  if (total > 32 * 1024 * 1024)
    throw new Error("host artifacts exceed the size limit");
}

async function dispatch(command: Request) {
  switch (command.method) {
    case "load": {
      const loaded: unknown = await import(pathToFileURL(command.module).href);
      host = (loaded as { default: HostAdapter }).default;
      if (typeof host.run !== "function")
        throw new Error(
          `host adapter module has no valid default adapter at ${command.module}; export a default adapter with string id, model, effort and a run function`,
        );
      const configuration = host.configuration;
      const snapshot =
        configuration === undefined
          ? undefined
          : snapshotJsonConfiguration(configuration);
      return {
        id: host.id,
        model: host.model,
        effort: host.effort,
        configuration: snapshot,
        instrumentation: host.instrumentation,
        hostCapabilities: host.hostCapabilities,
      };
    }
    case "run": {
      const controller = new AbortController();
      active.set(command.id, controller);
      try {
        return validatedResult(
          await host.run({ ...command.request, signal: controller.signal }),
        );
      } finally {
        active.delete(command.id);
      }
    }
    case "abort":
      active.get(command.id)?.abort(command.reason);
      return null;
    case "shutdown":
      return null;
  }
}

async function respond(command: Request) {
  try {
    const result: unknown = await dispatch(command);
    socket.write(`${JSON.stringify({ id: command.id, result })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    socket.write(`${JSON.stringify({ id: command.id, error: message })}\n`);
  }
}

function interruptImport(command: ImportInterrupt) {
  if (process.listenerCount(command.reason) === 0)
    process.exit(command.exitCode);
  process.emit(command.reason);
}

const pending = new Set<Promise<void>>();
for await (const line of lines) {
  const command = JSON.parse(line) as Request | ImportInterrupt;
  if (command.method === "interrupt-import") {
    interruptImport(command);
    continue;
  }
  if (command.method === "abort") {
    await dispatch(command);
    continue;
  }
  if (command.method === "shutdown") {
    await Promise.all(pending);
    await respond(command);
    process.exitCode = 0;
    socket.end();
    break;
  }
  const response = respond(command);
  pending.add(response);
  void response.then(() => pending.delete(response));
}
await Promise.all(pending);
