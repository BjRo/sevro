import { randomUUID } from "node:crypto";
import validExchange from "./generated/extension.cjs";
import { isRecord, isStringArray } from "./value-guards";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const PROTOCOL = "sevro.extension.v1";

export class ExtensionProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
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

function boundedChunk(
  value: Uint8Array,
  size: number,
  limit: number,
  truncate: boolean,
): Uint8Array {
  if (!truncate && size + value.byteLength > limit)
    throw new ExtensionProtocolError("extension message exceeds 8 MiB");
  return value.subarray(0, Math.max(0, limit - size));
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  truncate: boolean,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const kept = boundedChunk(value, size, limit, truncate);
    if (kept.byteLength) chunks.push(kept);
    size += kept.byteLength;
  }
  return concatenateChunks(chunks, size);
}

function concatenateChunks(chunks: Uint8Array[], size: number): Uint8Array {
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

interface SuccessfulExtensionResponse extends ExtensionResponse {
  result: Record<string, unknown>;
  error?: never;
}

function validateExtensionCommand(command: string[]): void {
  if (!command.length || command.some((part) => !part))
    throw new ExtensionProtocolError(
      "extension command must be a nonempty argv array",
    );
}

function extensionTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw new ExtensionProtocolError(
      "extension timeout must be a positive integer",
    );
  return timeout;
}

function extensionPayload(request: ExtensionRequest): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(request));
  if (payload.byteLength > MAX_MESSAGE_BYTES)
    throw new ExtensionProtocolError("extension request exceeds 8 MiB");
  return payload;
}

function spawnExtension(
  command: string[],
  options: ExchangeOptions,
): Bun.Subprocess {
  try {
    return Bun.spawn(command, {
      cwd: options.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
  } catch (cause) {
    throw new ExtensionProtocolError("could not start extension process", {
      cause,
    });
  }
}

function extensionWriter(proc: Bun.Subprocess) {
  const stdin = proc.stdin;
  if (!stdin || typeof stdin === "number")
    throw new ExtensionProtocolError("extension pipes are unavailable");
  return stdin;
}

function extensionReaders(proc: Bun.Subprocess) {
  const { stdout, stderr } = proc;
  if (
    !stdout ||
    typeof stdout === "number" ||
    !stderr ||
    typeof stderr === "number"
  )
    throw new ExtensionProtocolError("extension pipes are unavailable");
  return { stdout, stderr };
}

async function writeExtensionRequest(
  stdin: ReturnType<typeof extensionWriter>,
  payload: Uint8Array,
): Promise<void> {
  await stdin.write(payload);
  await stdin.end();
}

function hasResponseBody(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, "result") || Object.hasOwn(value, "error");
}

function assertExtensionResponse(
  value: unknown,
): asserts value is ExtensionResponse {
  if (!validExchange(value) || !isRecord(value) || !hasResponseBody(value))
    throw new ExtensionProtocolError("invalid extension response");
}

function parseExtensionResponse(bytes: Uint8Array): ExtensionResponse {
  let response: unknown;
  try {
    response = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (cause) {
    throw new ExtensionProtocolError(
      "extension did not return one UTF-8 JSON response",
      { cause },
    );
  }
  assertExtensionResponse(response);
  return response;
}

function validateResponseIdentity(
  response: ExtensionResponse,
  request: ExtensionRequest,
): void {
  if (
    response.id !== request.id ||
    response.protocol !== request.protocol ||
    response.method !== request.method
  )
    throw new ExtensionProtocolError(
      "extension response does not match request",
    );
}

function assertSuccessfulResponse(
  response: ExtensionResponse,
): asserts response is SuccessfulExtensionResponse {
  if (response.error)
    throw new ExtensionProtocolError(
      `extension reported ${response.error.code}`,
    );
  if (response.result === undefined)
    throw new ExtensionProtocolError("invalid extension response");
}

class ExtensionExchange {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cancel: (() => void) | undefined;
  constructor(
    private readonly proc: Bun.Subprocess,
    private readonly options: ExchangeOptions,
    private readonly timeoutMs: number,
  ) {}

  private async output(
    request: ExtensionRequest,
    payload: Uint8Array,
  ): Promise<SuccessfulExtensionResponse> {
    const stdin = extensionWriter(this.proc);
    const { stdout, stderr } = extensionReaders(this.proc);
    const write = writeExtensionRequest(stdin, payload);
    const [bytes, , exitCode] = await Promise.all([
      readBounded(stdout, MAX_MESSAGE_BYTES, false),
      readBounded(stderr, MAX_DIAGNOSTIC_BYTES, true),
      this.proc.exited,
      write,
    ]);
    if (exitCode !== 0)
      throw new ExtensionProtocolError(
        `extension exited with code ${exitCode}`,
      );
    const response = parseExtensionResponse(bytes);
    validateResponseIdentity(response, request);
    assertSuccessfulResponse(response);
    return response;
  }

  private timeout(): Promise<never> {
    return new Promise((_resolve, reject) => {
      this.timer = setTimeout(() => {
        reject(new ExtensionProtocolError("extension timed out"));
      }, this.timeoutMs);
    });
  }

  private aborted(): Promise<never> {
    return new Promise((_resolve, reject) => {
      const signal = this.options.signal;
      if (!signal) return;
      this.cancel = () => {
        reject(new ExtensionProtocolError("extension request cancelled"));
      };
      if (signal.aborted) this.cancel();
      else signal.addEventListener("abort", this.cancel, { once: true });
    });
  }

  private dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.cancel)
      this.options.signal?.removeEventListener("abort", this.cancel);
  }

  async run(
    request: ExtensionRequest,
    payload: Uint8Array,
  ): Promise<SuccessfulExtensionResponse> {
    try {
      return await Promise.race([
        this.output(request, payload),
        this.timeout(),
        this.aborted(),
      ]);
    } catch (cause) {
      terminate(this.proc);
      if (cause instanceof ExtensionProtocolError) throw cause;
      throw new ExtensionProtocolError("extension transport failed", { cause });
    } finally {
      this.dispose();
    }
  }
}

/** Run exactly one request in a fresh extension process. */
export async function exchangeExtension(
  command: string[],
  request: ExtensionRequest,
  options: ExchangeOptions = {},
): Promise<SuccessfulExtensionResponse> {
  validateExtensionCommand(command);
  if (!validExchange(request))
    throw new ExtensionProtocolError("invalid extension request");
  if (options.signal?.aborted)
    throw new ExtensionProtocolError("extension request cancelled");
  const timeout = extensionTimeout(options.timeoutMs);
  const payload = extensionPayload(request);
  return new ExtensionExchange(
    spawnExtension(command, options),
    options,
    timeout,
  ).run(request, payload);
}

export interface NegotiatedExtension {
  id: string;
  version: string;
  protocol: string;
  capabilities: string[];
  graders: string[];
  taskVerdictPolicies: string[];
}

function descriptionStrings(value: unknown): string[] {
  if (!isStringArray(value))
    throw new ExtensionProtocolError("invalid extension response");
  return value;
}

function describedIdentity(value: unknown): { id: string; version: string } {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.version !== "string"
  )
    throw new ExtensionProtocolError("invalid extension response");
  return { id: value.id, version: value.version };
}

function descriptionResult(value: Record<string, unknown>) {
  return {
    protocols: descriptionStrings(value.protocols),
    requiredCapabilities: descriptionStrings(value.requiredCapabilities),
    optionalCapabilities: descriptionStrings(value.optionalCapabilities),
    extension: describedIdentity(value.extension),
    graders: descriptionStrings(value.graders),
    taskVerdictPolicies: descriptionStrings(value.taskVerdictPolicies),
  };
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
  const result = descriptionResult(response.result);
  const offered = result.protocols;
  if (!offered.includes(PROTOCOL))
    throw new ExtensionProtocolError("extension has no compatible protocol");
  const supported = new Set([
    ...available.engineCapabilities,
    ...available.hostCapabilities,
  ]);
  const required = result.requiredCapabilities;
  for (const capability of required)
    if (!supported.has(capability))
      throw new ExtensionProtocolError(
        `unsupported required capability: ${capability}`,
      );
  const optional = result.optionalCapabilities.filter((item) =>
    supported.has(item),
  );
  const extension = result.extension;
  return {
    id: extension.id,
    version: extension.version,
    protocol: PROTOCOL,
    capabilities: [...new Set([...required, ...optional])],
    graders: result.graders,
    taskVerdictPolicies: result.taskVerdictPolicies,
  };
}
