import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
} from "node:child_process";
import { Readable, Writable } from "node:stream";
import { constants } from "node:os";

interface ProcessWriter {
  write(data: string | Uint8Array): unknown;
  end(): unknown;
}

export interface Subprocess {
  pid: number;
  stdin: ProcessWriter | null;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  readonly signalCode: string | null;
  kill(signal: NodeJS.Signals): void;
}

interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  stdin?: "pipe" | "ignore" | Uint8Array;
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore";
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function readable(stream: Readable | null): ReadableStream<Uint8Array> {
  // Node and Bun declare different overloads for the same Web Streams API.
  return stream
    ? (Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>)
    : emptyStream();
}

function output(
  stream: ReadableStream<Uint8Array> | null | undefined,
): ReadableStream<Uint8Array> {
  return stream ?? emptyStream();
}

function writer(stream: Writable | null): ProcessWriter | null {
  if (!stream) return null;
  const destination = Writable.toWeb(stream).getWriter();
  return {
    write: (data) =>
      destination.write(typeof data === "string" ? Buffer.from(data) : data),
    end: () => destination.close(),
  };
}

function commandName(argv: string[]): string {
  const name = argv[0];
  if (!name) throw new Error("process command must be nonempty");
  return name;
}

function stdinMode(input: SpawnOptions["stdin"]) {
  return input === "pipe" || input instanceof Uint8Array ? "pipe" : "ignore";
}

function processId(child: ChildProcess): number {
  if (child.pid !== undefined) return child.pid;
  child.once("error", () => {});
  throw new Error("could not start process");
}

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? 128 + (signal ? constants.signals[signal] : 0);
}

function completion(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve(exitCode(code, signal));
    });
  });
}

async function initialInput(
  stdin: ProcessWriter | null,
  input: SpawnOptions["stdin"],
) {
  if (!(input instanceof Uint8Array)) return;
  if (!stdin) throw new Error("process input pipe unavailable");
  await stdin.write(input);
  await stdin.end();
}

function nodeProcess(argv: string[], options: SpawnOptions): Subprocess {
  const child = nodeSpawn(commandName(argv), argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: [
      stdinMode(options.stdin),
      options.stdout ?? "pipe",
      options.stderr ?? "pipe",
    ],
  });
  const pid = processId(child);
  const exited = completion(child);
  const stdin = writer(child.stdin);
  return {
    pid,
    stdin,
    stdout: readable(child.stdout),
    stderr: readable(child.stderr),
    exited: Promise.all([exited, initialInput(stdin, options.stdin)]).then(
      ([code]) => code,
    ),
    get signalCode() {
      return child.signalCode;
    },
    kill(signal) {
      child.kill(signal);
    },
  };
}

function bunProcess(argv: string[], options: SpawnOptions): Subprocess {
  const child = Bun.spawn(argv, {
    ...options,
    stdin: options.stdin ?? "ignore",
    stderr: options.stderr ?? "pipe",
  });
  return {
    pid: child.pid,
    stdin: typeof child.stdin === "object" ? child.stdin : null,
    stdout: output(child.stdout),
    stderr: output(child.stderr),
    exited: child.exited,
    get signalCode() {
      return child.signalCode ?? null;
    },
    kill(signal) {
      child.kill(signal);
    },
  };
}

/** Keep the runner's process/stream contract independent of its JS runtime. */
export function spawn(argv: string[], options: SpawnOptions = {}): Subprocess {
  return process.versions.bun
    ? bunProcess(argv, options)
    : nodeProcess(argv, options);
}

function buffer(bytes: Buffer | null | undefined): Buffer {
  return bytes ?? Buffer.alloc(0);
}

function bunSync(argv: string[], options: SpawnOptions) {
  const result = Bun.spawnSync(argv, options);
  return {
    exitCode: result.exitCode,
    stdout: buffer(result.stdout),
    stderr: buffer(result.stderr),
  };
}

function nodeSync(argv: string[], options: SpawnOptions) {
  const result = nodeSpawnSync(commandName(argv), argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", options.stdout ?? "pipe", options.stderr ?? "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    exitCode: result.status ?? 1,
    stdout: buffer(result.stdout),
    stderr: buffer(result.stderr),
  };
}

export function spawnSync(argv: string[], options: SpawnOptions = {}) {
  return process.versions.bun
    ? bunSync(argv, options)
    : nodeSync(argv, options);
}
