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
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { HostAdapter } from "../engine";
import { fixtureParts } from "../preparation";
import { stageClaudeCredential } from "./claude-credential";
import { summarizeClaudeEvents } from "./claude-events";
import { claudeHostSettings } from "./claude-settings";
import { claudeToolCallsObservation } from "./claude-tool-calls";
import { evaluationProtectedRoots } from "./isolation-roots";
import { macSandboxProfile } from "./mac-sandbox";

const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface ClaudeHostOptions {
  binary: string;
  model: string;
  effort: string;
  projectRoot: string;
  resultsRoot: string;
  additionalProtectedRoots: string[];
  credentialFile?: string;
  timeoutMs?: number;
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function stop(proc: Bun.Subprocess): void {
  try {
    if (process.platform !== "win32") process.kill(-proc.pid, "SIGKILL");
    else proc.kill("SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
}

async function boundedStream(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_EVENT_BYTES)
      throw new Error("Claude event stream exceeds 8 MiB");
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
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ code: number; out: string }> {
  if (options.signal?.aborted) throw new Error("Claude run cancelled");
  const proc = Bun.spawn(options.argv, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const completed = Promise.all([
      boundedStream(proc.stdout),
      proc.exited,
    ]).then(([out, code]) => ({ out, code }));
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Claude run timed out")),
        options.timeoutMs,
      );
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!options.signal) return;
      cancel = () => reject(new Error("Claude run cancelled"));
      if (options.signal.aborted) cancel();
      else options.signal.addEventListener("abort", cancel, { once: true });
    });
    return await Promise.race([completed, timeout, aborted]);
  } catch (error) {
    stop(proc);
    await proc.exited;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener("abort", cancel);
  }
}

async function pluginDirectories(
  workspace: string,
  declaration: NonNullable<
    Parameters<HostAdapter["run"]>[0]["claudePluginDirs"]
  >,
): Promise<string[]> {
  const root = await realpath(workspace);
  if (
    new Set(declaration.artifactRoots).size !==
      declaration.artifactRoots.length ||
    new Set(declaration.artifactPaths).size !== declaration.artifactPaths.length
  )
    throw new Error("Claude plugin declaration contains duplicates");
  const paths = new Set(declaration.artifactPaths);
  const directories: string[] = [];
  for (const relativeRoot of declaration.artifactRoots) {
    fixtureParts(relativeRoot);
    const manifest = `${relativeRoot}/.claude-plugin/plugin.json`;
    if (!paths.has(manifest))
      throw new Error("Claude plugin manifest is undeclared");
    const actual = await realpath(join(root, relativeRoot));
    if (!inside(root, actual))
      throw new Error("Claude plugin directory escapes workspace");
    if (!(await stat(join(actual, ".claude-plugin", "plugin.json"))).isFile())
      throw new Error("Claude plugin manifest is missing");
    directories.push(actual);
  }
  if (new Set(directories).size !== directories.length)
    throw new Error("Claude plugin directories overlap");
  if (
    directories.some((item) =>
      directories.some((other) => item !== other && inside(other, item)),
    )
  )
    throw new Error("Claude plugin directories overlap");
  for (const artifactPath of paths) {
    fixtureParts(artifactPath);
    const index = declaration.artifactRoots.findIndex((item) =>
      artifactPath.startsWith(`${item}/`),
    );
    if (index < 0)
      throw new Error("Claude plugin artifact is outside a declared directory");
    if (!inside(directories[index]!, await realpath(join(root, artifactPath))))
      throw new Error("Claude plugin artifact escapes workspace");
  }
  return directories;
}

async function verifyInvocation(
  request: Parameters<HostAdapter["run"]>[0],
  directories: string[],
): Promise<void> {
  const selected = request.explicitSkillInvocation;
  if (!selected) return;
  const { pluginName, skillName, token } = selected;
  if (
    token !== `/${pluginName}:${skillName}` ||
    request.prompt.split(token).length - 1 !== 1 ||
    !/^[a-z][a-z0-9-]*$/.test(pluginName) ||
    !/^[A-Za-z0-9._-]+$/.test(skillName)
  )
    throw new Error("invalid Claude explicit skill invocation");
  for (const [index, root] of directories.entries()) {
    const relativeRoot = request.claudePluginDirs?.artifactRoots[index];
    if (
      !request.claudePluginDirs?.artifactPaths.includes(
        `${relativeRoot}/skills/${skillName}/SKILL.md`,
      )
    )
      continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(
        await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8"),
      );
    } catch {
      throw new Error("invalid Claude plugin manifest");
    }
    if (
      manifest &&
      typeof manifest === "object" &&
      "name" in manifest &&
      manifest.name === pluginName &&
      (
        await stat(join(root, "skills", skillName, "SKILL.md")).catch(
          () => null,
        )
      )?.isFile()
    )
      return;
  }
  throw new Error("invoked Claude skill is absent from the package");
}

/** Run Claude with explicit plugins and two nested filesystem boundaries. */
export function createClaudeHost(options: ClaudeHostOptions): HostAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    process.platform !== "darwin" ||
    !existsSync("/usr/bin/sandbox-exec") ||
    !isAbsolute(options.binary) ||
    !isAbsolute(options.projectRoot) ||
    !isAbsolute(options.resultsRoot) ||
    options.additionalProtectedRoots.some((root) => !isAbsolute(root)) ||
    (options.credentialFile !== undefined &&
      !isAbsolute(options.credentialFile)) ||
    !options.model ||
    !options.effort ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30 * 60_000
  )
    throw new Error("invalid Claude host configuration");
  return {
    id: "sevro.host.claude",
    model: options.model,
    effort: options.effort,
    hostCapabilities: [
      "sevro.claude.plugin-dirs",
      "sevro.claude.explicit-invocation",
      "sevro.claude.tool-calls",
    ],
    async run(request) {
      if (request.followUpPrompt !== undefined)
        throw new Error("Claude continuation is unavailable");
      if (request.instrumentation?.length || request.condition !== "passive")
        throw new Error("Claude enforcement instrumentation is unavailable");
      if (
        request.fixtureBinDir !== undefined &&
        request.fixtureBinDir !== join(request.workspace, ".git", "fixture-bin")
      )
        throw new Error("fixture binary path is outside the workspace");
      const pluginDirs = request.claudePluginDirs
        ? await pluginDirectories(request.workspace, request.claudePluginDirs)
        : [];
      await verifyInvocation(request, pluginDirs);
      const stateRoot = await mkdtemp(join(tmpdir(), "sevro-claude-state-"));
      try {
        await mkdir(join(stateRoot, "private"), { mode: 0o700 });
        const privateRoot = await realpath(join(stateRoot, "private"));
        const home = join(stateRoot, "home");
        const temp = join(stateRoot, "tmp");
        await Promise.all(
          [home, temp].map((path) => mkdir(path, { mode: 0o700 })),
        );
        const credential = await stageClaudeCredential(
          join(privateRoot, "config"),
          options.credentialFile,
        );
        const settingsPath = join(privateRoot, "settings.json");
        await writeFile(
          settingsPath,
          JSON.stringify(
            claudeHostSettings(privateRoot, credential, pluginDirs),
          ),
          { flag: "wx", mode: 0o600 },
        );
        const protectedRoots = await evaluationProtectedRoots({
          workspace: request.workspace,
          projectRoot: options.projectRoot,
          resultsRoot: options.resultsRoot,
          additionalRoots: options.additionalProtectedRoots,
        });
        if (protectedRoots.some((root) => inside(root, credential)))
          throw new Error("Claude private state overlaps a protected root");
        const binaryRoot = await realpath(options.binary);
        if (protectedRoots.some((root) => inside(root, binaryRoot)))
          throw new Error("Claude executable resides inside a protected root");
        const protectedProbe = join(stateRoot, "outer-protected");
        await mkdir(protectedProbe, { mode: 0o700 });
        await writeFile(join(protectedProbe, "probe.txt"), "probe\n", {
          flag: "wx",
          mode: 0o600,
        });
        const profilePath = join(privateRoot, `outer-${randomUUID()}.sb`);
        await writeFile(
          profilePath,
          macSandboxProfile([
            ...protectedRoots,
            await realpath(protectedProbe),
          ]),
          {
            flag: "wx",
            mode: 0o600,
          },
        );
        const env: Record<string, string> = {
          PATH: request.fixtureBinDir
            ? `${request.fixtureBinDir}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`
            : (process.env.PATH ?? "/usr/bin:/bin"),
          LANG: process.env.LANG ?? "C",
          HOME: home,
          TMPDIR: temp,
          CLAUDE_CONFIG_DIR: dirname(credential),
          NO_COLOR: "1",
        };
        const preflight = await runProcess({
          argv: [
            "/usr/bin/sandbox-exec",
            "-f",
            profilePath,
            "/bin/sh",
            "-c",
            '/bin/test -r "$1" || exit 31; /bin/cat "$2/probe.txt" >/dev/null 2>&1 && exit 32; exit 0',
            "sevro-claude-preflight",
            credential,
            protectedProbe,
          ],
          cwd: request.workspace,
          env,
          timeoutMs: 10_000,
          signal: request.signal,
        });
        if (preflight.code !== 0)
          throw new Error(
            `Claude outer isolation preflight failed (${preflight.code})`,
          );
        const execution = await runProcess({
          argv: [
            "/usr/bin/sandbox-exec",
            "-f",
            profilePath,
            options.binary,
            "-p",
            request.prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            options.model,
            "--effort",
            options.effort,
            "--permission-mode",
            "dontAsk",
            "--tools",
            "Bash,Read,Edit,Write,Skill,Agent",
            "--setting-sources",
            "",
            "--settings",
            settingsPath,
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--no-chrome",
            "--no-session-persistence",
            ...pluginDirs.flatMap((path) => ["--plugin-dir", path]),
          ],
          cwd: request.workspace,
          env,
          timeoutMs,
          signal: request.signal,
        });
        const summary = summarizeClaudeEvents(execution.out, execution.code);
        if (!summary.complete) throw new Error("Claude turn did not complete");
        return {
          finalMessage: summary.finalMessage,
          complete: summary.complete,
          observations: [
            claudeToolCallsObservation(execution.out, execution.code),
          ],
          artifacts: [
            {
              id: "sevro.claude.events",
              bytes: Buffer.from(execution.out, "utf8"),
            },
          ],
          actualCondition: "passive" as const,
          inputTokens: summary.inputTokens,
          outputTokens: summary.outputTokens,
          costUsd: summary.costUsd,
          usageComplete: summary.usageComplete,
        };
      } finally {
        await rm(stateRoot, { recursive: true, force: true });
      }
    },
  };
}
