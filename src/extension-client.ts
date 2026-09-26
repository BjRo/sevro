import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import extensionSchema from "../schemas/extension-v1.schema.json";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const PROTOCOL = "sevro.extension.v1";

const ajv = new Ajv2020({
  strict: true,
  strictRequired: false,
  strictTypes: false,
});
const validExchange = ajv.compile(extensionSchema);

export class ExtensionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionProtocolError";
  }
}

export interface ExtensionRequest {
  protocol: string;
  id: string;
  method: "describe" | "resolve" | "prepare" | "evaluate";
  params: Record<string, unknown>;
}

export interface ExtensionResponse {
  protocol: string;
  id: string;
  method: ExtensionRequest["method"];
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface ExchangeOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  truncate: boolean,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!truncate && size + value.byteLength > limit)
      throw new ExtensionProtocolError("extension message exceeds 8 MiB");
    const kept = value.subarray(0, Math.max(0, limit - size));
    if (kept.byteLength) chunks.push(kept);
    size += kept.byteLength;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function terminate(proc: Bun.Subprocess): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // The group may have exited while the runner was handling the error.
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // The process already exited.
  }
}

/** Run exactly one request in a fresh extension process. */
export async function exchangeExtension(
  command: string[],
  request: ExtensionRequest,
  options: ExchangeOptions = {},
): Promise<ExtensionResponse> {
  if (!command.length || command.some((part) => !part))
    throw new ExtensionProtocolError(
      "extension command must be a nonempty argv array",
    );
  if (!validExchange(request))
    throw new ExtensionProtocolError("invalid extension request");
  if (options.signal?.aborted)
    throw new ExtensionProtocolError("extension request cancelled");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new ExtensionProtocolError(
      "extension timeout must be a positive integer",
    );
  const payload = new TextEncoder().encode(JSON.stringify(request));
  if (payload.byteLength > MAX_MESSAGE_BYTES)
    throw new ExtensionProtocolError("extension request exceeds 8 MiB");

  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(command, {
      cwd: options.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
  } catch {
    throw new ExtensionProtocolError("could not start extension process");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const { stdin, stdout, stderr } = proc;
    if (
      !stdin ||
      typeof stdin === "number" ||
      !stdout ||
      typeof stdout === "number" ||
      !stderr ||
      typeof stderr === "number"
    )
      throw new ExtensionProtocolError("extension pipes are unavailable");
    const write = (async () => {
      await stdin.write(payload);
      await stdin.end();
    })();
    const output = (async () => {
      const [responseBytes, _diagnostic, exitCode] = await Promise.all([
        readBounded(stdout, MAX_MESSAGE_BYTES, false),
        readBounded(stderr, MAX_DIAGNOSTIC_BYTES, true),
        proc.exited,
        write,
      ]);
      if (exitCode !== 0)
        throw new ExtensionProtocolError(
          `extension exited with code ${exitCode}`,
        );
      let response: unknown;
      try {
        response = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(responseBytes),
        );
      } catch {
        throw new ExtensionProtocolError(
          "extension did not return one UTF-8 JSON response",
        );
      }
      if (!validExchange(response))
        throw new ExtensionProtocolError("invalid extension response");
      const envelope = response as unknown as ExtensionResponse;
      if (
        envelope.id !== request.id ||
        envelope.protocol !== request.protocol ||
        envelope.method !== request.method
      )
        throw new ExtensionProtocolError(
          "extension response does not match request",
        );
      if (envelope.error)
        throw new ExtensionProtocolError(
          `extension reported ${envelope.error.code}`,
        );
      return envelope;
    })();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ExtensionProtocolError("extension timed out")),
        timeoutMs,
      );
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!options.signal) return;
      cancel = () =>
        reject(new ExtensionProtocolError("extension request cancelled"));
      if (options.signal.aborted) cancel();
      else options.signal.addEventListener("abort", cancel, { once: true });
    });
    return await Promise.race([output, timeout, aborted]);
  } catch (error) {
    terminate(proc);
    if (error instanceof ExtensionProtocolError) throw error;
    throw new ExtensionProtocolError("extension transport failed");
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener("abort", cancel);
  }
}

export interface NegotiatedExtension {
  id: string;
  version: string;
  protocol: string;
  capabilities: string[];
  graders: string[];
  taskVerdictPolicies: string[];
}

/** Discover an extension and select the v1 protocol and available capabilities. */
export async function negotiateExtension(
  command: string[],
  available: { engineCapabilities: string[]; hostCapabilities: string[] },
  options: ExchangeOptions = {},
): Promise<NegotiatedExtension> {
  const response = await exchangeExtension(
    command,
    {
      protocol: "sevro.discovery.v1",
      id: randomUUID(),
      method: "describe",
      params: {
        protocols: [PROTOCOL],
        engineCapabilities: available.engineCapabilities,
        hostCapabilities: available.hostCapabilities,
      },
    },
    options,
  );
  const result = response.result!;
  const offered = result.protocols as string[];
  if (!offered.includes(PROTOCOL))
    throw new ExtensionProtocolError("extension has no compatible protocol");
  const supported = new Set([
    ...available.engineCapabilities,
    ...available.hostCapabilities,
  ]);
  const required = result.requiredCapabilities as string[];
  for (const capability of required)
    if (!supported.has(capability))
      throw new ExtensionProtocolError(
        `unsupported required capability: ${capability}`,
      );
  const optional = (result.optionalCapabilities as string[]).filter((item) =>
    supported.has(item),
  );
  const extension = result.extension as { id: string; version: string };
  return {
    id: extension.id,
    version: extension.version,
    protocol: PROTOCOL,
    capabilities: [...new Set([...required, ...optional])],
    graders: result.graders as string[],
    taskVerdictPolicies: result.taskVerdictPolicies as string[],
  };
}
