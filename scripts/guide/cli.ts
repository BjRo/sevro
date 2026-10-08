import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { HostAdapter } from "../../src/engine";
import { createCodexHost } from "../../src/hosts/codex";
import { createClaudeHost } from "../../src/hosts/claude";
import { isRecord } from "../../src/value-guards";
import { evaluateGuide } from "./evaluation";
import { casesPath, guideRoot } from "./fixture";
import { parseGuideCases } from "./records";
import type { Host } from "./types";

function options() {
  return parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    options: {
      host: { type: "string" },
      case: { type: "string" },
      model: { type: "string" },
      effort: { type: "string", default: "medium" },
      jobs: { type: "string", default: "2" },
      "adapter-module": { type: "string" },
      dry: { type: "boolean" },
    },
  }).values;
}
type Options = ReturnType<typeof options>;

function selectedHost(value: string | undefined): Host {
  if (value !== "codex" && value !== "claude")
    throw new Error("--host codex|claude is required");
  return value;
}

async function adapter(path: string, host: Host): Promise<HostAdapter> {
  const module: unknown = await import(pathToFileURL(resolve(path)).href);
  const value: unknown = isRecord(module) ? module.default : undefined;
  if (!isRecord(value) || typeof value.run !== "function")
    throw new Error("Invalid guide host adapter");
  requireAdapterIdentity(value, host);
  return value as unknown as HostAdapter;
}

function requireAdapterIdentity(
  value: Record<string, unknown>,
  host: Host,
): void {
  if (value.id !== "sevro.host." + host)
    throw new Error("Guide adapter must identify the selected host route");
  if (typeof value.model !== "string" || typeof value.effort !== "string")
    throw new Error("Guide adapter requires model and effort identifiers");
}

async function nativeHost(host: Host, values: Options): Promise<HostAdapter> {
  if (values["adapter-module"]) return adapter(values["adapter-module"], host);
  if (values.dry) return dryHost(host, values);
  return liveHost(host, values);
}

function dryHost(host: Host, values: Options): HostAdapter {
  return {
    id: "sevro.host." + host,
    model: values.model ?? "dry-unverified",
    effort: values.effort,
    hostCapabilities: [
      "sevro.host.continuation",
      `sevro.${host}.repository-invocation`,
    ],
    run() {
      throw new Error("Dry guide evaluations must never invoke a host");
    },
  };
}

function liveHost(host: Host, values: Options): HostAdapter {
  if (!values.model)
    throw new Error("Live guide evaluations require --model <model-id>");
  const binary = Bun.which(host);
  if (!binary) throw new Error("Native guide host is unavailable: " + host);
  const common = {
    binary,
    model: values.model,
    effort: values.effort,
    projectRoot: guideRoot,
    resultsRoot: join(guideRoot, ".guide-results"),
    additionalProtectedRoots: [],
    timeoutMs: 180000,
  };
  return host === "codex"
    ? createCodexHost({
        ...common,
        authFile: join(
          process.env.CODEX_HOME ?? join(homedir(), ".codex"),
          "auth.json",
        ),
      })
    : createClaudeHost({ ...common, projectSettings: true });
}

async function runCase(
  id: string,
  host: HostAdapter,
  dry: boolean,
  signal: AbortSignal,
) {
  try {
    const { result } = await evaluateGuide(id, host, { dry, signal });
    console.log(
      `${id}: execution=${result.execution.status} grading=${result.grading.status} task=${result.task.verdict}`,
    );
    console.log("evidence=" + result.evidencePath);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  } catch (error) {
    console.error(
      id + ": " + (error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
  }
}

async function runCases(
  ids: string[],
  host: HostAdapter,
  values: Options,
  signal: AbortSignal,
) {
  const jobs = Number(values.jobs);
  if (![1, 2].includes(jobs)) throw new Error("--jobs must be 1 or 2");
  for (let offset = 0; offset < ids.length && !signal.aborted; offset += jobs)
    await Promise.all(
      ids
        .slice(offset, offset + jobs)
        .map((id) => runCase(id, host, values.dry ?? false, signal)),
    );
}

export async function guideMain(): Promise<void> {
  const values = options();
  const host = await nativeHost(selectedHost(values.host), values);
  const cases = parseGuideCases(
    await readFile(join(guideRoot, casesPath), "utf8"),
  );
  const selected = values.case
    ? cases.filter((test) => test.id === values.case)
    : cases;
  if (!selected.length) throw new Error("No matching guide case");
  const cancellation = new AbortController();
  const interrupt = () => {
    cancellation.abort("interrupted");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await runCases(
      selected.map((test) => test.id),
      host,
      values,
      cancellation.signal,
    );
    if (values.dry) console.log("Native host remains unverified.");
    if (cancellation.signal.aborted) process.exitCode = 130;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
