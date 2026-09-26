import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import type { HostAdapter } from "../engine";
import { summarizeCodexEvents } from "./codex-events";
import { codexPermissionProfile } from "./codex-profile";
import { evaluationProtectedRoots } from "./isolation-roots";

const MAX_AUTH_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;

export interface CodexHostOptions {
  binary: string;
  authFile: string;
  model: string;
  effort: string;
  projectRoot: string;
  resultsRoot: string;
  additionalProtectedRoots: string[];
  timeoutMs?: number;
  /** Integration-test seam; production uses the same CLI for execution and preflight. */
  sandboxBinary?: string;
}

function stopProcess(proc: Bun.Subprocess): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // The group may have exited before cancellation.
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // The process already exited.
  }
}

async function boundedText(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit)
      throw new Error("Codex event stream exceeds the size limit");
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}

async function runProcess(options: {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ code: number; out: string }> {
  if (options.signal?.aborted) throw new Error("Codex run cancelled");
  const proc = Bun.spawn(options.argv, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const written = (async () => {
      if (options.input === undefined) return;
      if (!proc.stdin || typeof proc.stdin === "number")
        throw new Error("Codex input pipe unavailable");
      await proc.stdin.write(options.input);
      await proc.stdin.end();
    })();
    const completed = Promise.all([
      boundedText(proc.stdout, MAX_EVENT_BYTES),
      proc.exited,
      written,
    ]).then(([out, code]) => ({ out, code }));
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Codex run timed out")),
        options.timeoutMs,
      );
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!options.signal) return;
      cancel = () => reject(new Error("Codex run cancelled"));
      if (options.signal.aborted) cancel();
      else options.signal.addEventListener("abort", cancel, { once: true });
    });
    return await Promise.race([completed, timeout, aborted]);
  } catch (error) {
    stopProcess(proc);
    await proc.exited;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener("abort", cancel);
  }
}

async function copyAuth(source: string, target: string): Promise<void> {
  let bytes: Buffer;
  try {
    if ((await stat(source)).size > MAX_AUTH_BYTES)
      throw new Error("Codex auth file exceeds the size limit");
    bytes = await readFile(source);
  } catch {
    throw new Error("Codex auth file is unreadable or oversized");
  }
  if (bytes.byteLength > MAX_AUTH_BYTES)
    throw new Error("Codex auth file exceeds the size limit");
  await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
}

/** Construct one Codex route without inheriting user settings or credentials. */
export function createCodexHost(options: CodexHostOptions): HostAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !isAbsolute(options.binary) ||
    !isAbsolute(options.authFile) ||
    !isAbsolute(options.projectRoot) ||
    !isAbsolute(options.resultsRoot) ||
    options.additionalProtectedRoots.some((root) => !isAbsolute(root)) ||
    (options.sandboxBinary !== undefined &&
      !isAbsolute(options.sandboxBinary)) ||
    !options.model ||
    !options.effort ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  )
    throw new Error("invalid Codex host configuration");
  return {
    id: "sevro.host.codex",
    model: options.model,
    effort: options.effort,
    async run(request) {
      if (request.instrumentation?.length)
        throw new Error("Codex instrumentation is unavailable");
      if (request.condition !== "passive")
        throw new Error("Codex enforcement instrumentation is unavailable");
      if (existsSync(join(request.workspace, ".codex")))
        throw new Error("fixture Codex configuration is unsupported");
      const stateRoot = await mkdtemp(join(tmpdir(), "sevro-codex-state-"));
      try {
        const codexHome = join(stateRoot, "codex-home");
        const parentHome = join(stateRoot, "home");
        const parentTemp = join(stateRoot, "tmp");
        const commandHome = join(stateRoot, "command-home");
        const commandTemp = join(stateRoot, "command-tmp");
        await Promise.all(
          [codexHome, parentHome, parentTemp, commandHome, commandTemp].map(
            (path) => mkdir(path, { mode: 0o700 }),
          ),
        );
        await copyAuth(options.authFile, join(codexHome, "auth.json"));
        const protectedRoots = await evaluationProtectedRoots({
          workspace: request.workspace,
          projectRoot: options.projectRoot,
          resultsRoot: options.resultsRoot,
          additionalRoots: [...options.additionalProtectedRoots, stateRoot],
        });
        const sandboxBinary = options.sandboxBinary ?? options.binary;
        const executableReadRoots = await Promise.all(
          [options.binary, sandboxBinary].flatMap((binary) => [
            realpath(dirname(binary)),
            realpath(binary).then(dirname),
          ]),
        );
        if (
          executableReadRoots.some((readRoot) =>
            protectedRoots.some(
              (protectedRoot) =>
                readRoot === protectedRoot ||
                readRoot.startsWith(`${protectedRoot}${sep}`),
            ),
          )
        )
          throw new Error("Codex executable resides inside a protected root");
        const profileId = `sevro_${randomUUID().replaceAll("-", "")}`;
        await writeFile(
          join(codexHome, "config.toml"),
          codexPermissionProfile({
            id: profileId,
            workspace: request.workspace,
            commandHome,
            commandTemp,
            executableReadRoots,
            protectedRoots,
          }),
          { flag: "wx", mode: 0o600 },
        );
        const env = {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: process.env.LANG ?? "C",
          HOME: parentHome,
          TMPDIR: parentTemp,
          CODEX_HOME: codexHome,
          NO_COLOR: "1",
        };
        const probe = join(commandTemp, "isolation-probe");
        await writeFile(probe, "probe\n", { flag: "wx", mode: 0o600 });
        const checked = await runProcess({
          argv: [
            sandboxBinary,
            "sandbox",
            "-P",
            profileId,
            "-C",
            request.workspace,
            "/bin/sh",
            "-c",
            '/bin/cat "$1" >/dev/null && ! /bin/ls "$2" >/dev/null 2>&1 && ! /bin/cat "$3" >/dev/null 2>&1',
            "sevro-probe",
            probe,
            options.projectRoot,
            join(codexHome, "auth.json"),
          ],
          cwd: request.workspace,
          env,
          timeoutMs: 10_000,
          signal: request.signal,
        });
        if (checked.code !== 0)
          throw new Error("Codex isolation preflight failed");
        const executableCheck = await runProcess({
          argv: [
            sandboxBinary,
            "sandbox",
            "-P",
            profileId,
            "-C",
            request.workspace,
            sandboxBinary,
            "--version",
          ],
          cwd: request.workspace,
          env,
          timeoutMs: 10_000,
          signal: request.signal,
        });
        if (executableCheck.code !== 0)
          throw new Error("Codex executable preflight failed");
        await rm(probe);
        const execution = await runProcess({
          argv: [
            options.binary,
            "exec",
            "--json",
            "--strict-config",
            "--skip-git-repo-check",
            "--ephemeral",
            "--ignore-rules",
            "-C",
            request.workspace,
            "-m",
            options.model,
            "-c",
            `model_reasoning_effort=${JSON.stringify(options.effort)}`,
            "-c",
            `default_permissions=${JSON.stringify(profileId)}`,
            "-c",
            'approval_policy="never"',
            "-",
          ],
          cwd: request.workspace,
          env,
          input: request.prompt,
          timeoutMs,
          signal: request.signal,
        });
        const summary = summarizeCodexEvents(execution.out, execution.code);
        if (!summary.complete) throw new Error("Codex turn did not complete");
        return {
          finalMessage: summary.finalMessage,
          complete: summary.finalMessage !== null,
          artifacts: [
            {
              id: "sevro.codex.events",
              bytes: Buffer.from(execution.out, "utf8"),
            },
          ],
          actualCondition: "passive" as const,
          inputTokens: summary.inputTokens,
          outputTokens: summary.outputTokens,
          usageComplete: summary.usageComplete,
          costUsd: null,
        };
      } finally {
        await rm(stateRoot, { recursive: true, force: true });
      }
    },
  };
}
