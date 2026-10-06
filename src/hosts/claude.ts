import { observeClaudeNativeGoal } from "./claude-native-goal";
import { existsSync } from "node:fs";
import {
  cp,
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
import { claudeNativeControls } from "./native-controls";
import { fixtureParts } from "../preparation";
import { stageClaudeAuthentication } from "./claude-credential";
import { summarizeClaudeEvents } from "./claude-events";
import { claudeNestedSkillsObservation } from "./claude-nested-skills";
import {
  claudeRepositoryInvocationObservation,
  verifyClaudeRepositoryInvocation,
} from "./claude-repository-invocation";
import { claudeHostSettings } from "./claude-settings";
import { claudeToolCallsObservation } from "./claude-tool-calls";
import { evaluationProtectedRoots } from "./isolation-roots";
import { runClaudeTurns, type ClaudeSession } from "./claude-continuation";

const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface ClaudeHostOptions {
  binary: string;
  model: string;
  effort: string;
  projectRoot: string;
  resultsRoot: string;
  additionalProtectedRoots: string[];
  credentialFile?: string;
  uvCacheDir?: string;
  toolchainBinDir?: string;
  projectSettings?: boolean;
  timeoutMs?: number;
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function minimalRoots(roots: string[]): string[] {
  return roots.filter(
    (root) => !roots.some((other) => other !== root && inside(other, root)),
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
  limit = MAX_EVENT_BYTES,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit)
      throw new Error("Claude process output exceeds its limit");
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
}): Promise<{ code: number; out: string; err: string }> {
  if (options.signal?.aborted) throw new Error("Claude run cancelled");
  const proc = Bun.spawn(options.argv, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const completed = Promise.all([
      boundedStream(proc.stdout),
      boundedStream(proc.stderr, MAX_STDERR_BYTES),
      proc.exited,
    ]).then(([out, err, code]) => ({ out, err, code }));
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
  if (selected.scope === "repository") return;
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

/** Run Claude with explicit plugins and its native tool sandbox. */
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
    (options.uvCacheDir !== undefined && !isAbsolute(options.uvCacheDir)) ||
    (options.toolchainBinDir !== undefined &&
      !isAbsolute(options.toolchainBinDir)) ||
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
      "sevro.host.native-goal",
      "sevro.claude.plugin-dirs",
      "sevro.claude.explicit-invocation",
      ...(options.projectSettings
        ? ["sevro.claude.repository-invocation"]
        : []),
      "sevro.claude.tool-calls",
      "sevro.host.native-controls",
      "sevro.claude.nested-skills",
      "sevro.host.continuation",
      "sevro.claude.continuation",
    ],
    async run(request) {
      if (
        request.followUpPrompt !== undefined &&
        (typeof request.followUpPrompt !== "string" ||
          !request.followUpPrompt.trim())
      )
        throw new Error("Claude follow-up prompt must be nonempty");
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
      if (
        request.explicitSkillInvocation?.scope === "repository" &&
        !options.projectSettings
      )
        throw new Error(
          "Claude repository invocation requires project setting sources",
        );
      const repositoryInvocation =
        request.explicitSkillInvocation?.scope === "repository"
          ? await verifyClaudeRepositoryInvocation(request)
          : null;
      const stateRoot = await mkdtemp(join(tmpdir(), "sevro-claude-state-"));
      try {
        await mkdir(join(stateRoot, "private"), { mode: 0o700 });
        const privateRoot = await realpath(join(stateRoot, "private"));
        const home = join(stateRoot, "home");
        const temp = join(stateRoot, "tmp");
        await Promise.all(
          [home, temp].map((path) => mkdir(path, { mode: 0o700 })),
        );
        const authentication = await stageClaudeAuthentication(
          join(privateRoot, "config"),
          options.credentialFile,
        );
        const credential = authentication.credentialFile;
        const protectedRoots = minimalRoots(
          await evaluationProtectedRoots({
            workspace: request.workspace,
            projectRoot: options.projectRoot,
            resultsRoot: options.resultsRoot,
            additionalRoots: options.additionalProtectedRoots,
          }),
        );
        if (protectedRoots.some((root) => inside(root, credential)))
          throw new Error("Claude private state overlaps a protected root");
        const binaryRoot = await realpath(options.binary);
        if (protectedRoots.some((root) => inside(root, binaryRoot)))
          throw new Error("Claude executable resides inside a protected root");
        const toolchainBinDir = options.toolchainBinDir
          ? await realpath(options.toolchainBinDir)
          : null;
        if (
          toolchainBinDir &&
          (protectedRoots.some((root) => inside(root, toolchainBinDir)) ||
            !(await stat(toolchainBinDir)).isDirectory())
        )
          throw new Error(
            "Claude toolchain directory is unavailable or protected",
          );
        let runtimeRoot: string | null = null;
        if (options.uvCacheDir) {
          const cacheRoot = await realpath(options.uvCacheDir);
          if (
            protectedRoots.some((root) => inside(root, cacheRoot)) ||
            !(await stat(cacheRoot)).isDirectory()
          )
            throw new Error("Claude UV cache is unavailable or protected");
          runtimeRoot = join(request.workspace, ".git", "sevro-runtime");
          await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
          await cp(cacheRoot, join(runtimeRoot, "uv-cache"), {
            recursive: true,
            force: false,
            errorOnExist: true,
          });
        }
        const settingsPath = join(privateRoot, "settings.json");
        await writeFile(
          settingsPath,
          JSON.stringify(
            claudeHostSettings(
              privateRoot,
              credential,
              pluginDirs,
              protectedRoots,
            ),
          ),
          { flag: "wx", mode: 0o600 },
        );
        const env: Record<string, string> = {
          ...authentication.environment,
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
          PATH: [
            request.fixtureBinDir,
            toolchainBinDir,
            process.env.PATH ?? "/usr/bin:/bin",
          ]
            .filter(Boolean)
            .join(delimiter),
          LANG: process.env.LANG ?? "C",
          HOME: runtimeRoot ? join(runtimeRoot, "host-home") : home,
          TMPDIR: temp,
          CLAUDE_CONFIG_DIR: dirname(credential),
          NO_COLOR: "1",
          ...(runtimeRoot
            ? {
                UV_CACHE_DIR: join(runtimeRoot, "uv-cache"),
                UV_PROJECT_ENVIRONMENT: join(
                  runtimeRoot,
                  "project-environment",
                ),
                UV_OFFLINE: "1",
                PYTHONDONTWRITEBYTECODE: "1",
              }
            : {}),
        };
        if (runtimeRoot) await mkdir(env.HOME!, { mode: 0o700 });
        const runTurn = (prompt: string, session?: ClaudeSession) =>
          runProcess({
            argv: [
              options.binary,
              "-p",
              prompt,
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
              "Bash,Read,Edit,Skill,Agent",
              "--setting-sources",
              options.projectSettings ? "project" : "",
              "--settings",
              settingsPath,
              "--strict-mcp-config",
              "--mcp-config",
              '{"mcpServers":{}}',
              "--no-chrome",
              ...(session ? [session.option, session.id] : []),
              ...pluginDirs.flatMap((path) => ["--plugin-dir", path]),
            ],
            cwd: request.workspace,
            env,
            timeoutMs,
            signal: request.signal,
          });
        const execution = await runClaudeTurns({
          prompt: request.prompt,
          followUpPrompt: request.followUpPrompt,
          workspace: request.workspace,
          run: runTurn,
        });
        const summary = summarizeClaudeEvents(execution.out, execution.code);
        const nestedSkills = await claudeNestedSkillsObservation(
          execution.out,
          dirname(credential),
          request.workspace,
        );
        const toolCalls = claudeToolCallsObservation(
          execution.out,
          execution.code,
        );
        const repositoryObservation = repositoryInvocation
          ? await claudeRepositoryInvocationObservation({
              invocation: repositoryInvocation,
              stream: execution.initialOut ?? execution.out,
              configRoot: dirname(credential),
              workspace: request.workspace,
              tools: execution.initialOut
                ? claudeToolCallsObservation(execution.initialOut, 0)
                : toolCalls,
            })
          : null;
        return {
          finalMessage: summary.finalMessage,
          complete: summary.complete,
          executionFailed: !summary.complete,
          observations: [
            toolCalls,
            await observeClaudeNativeGoal(
              dirname(credential),
              execution.followUpOut ?? execution.out,
            ),
            nestedSkills,
            claudeNativeControls(execution.out, execution.code),
            ...(repositoryObservation ? [repositoryObservation] : []),
            ...(execution.continuation ? [execution.continuation] : []),
          ],
          artifacts: [
            {
              id: "sevro.claude.events",
              bytes: Buffer.from(execution.out, "utf8"),
            },
            ...(execution.initialOut !== undefined
              ? [
                  {
                    id: "sevro.claude.initial-events",
                    bytes: Buffer.from(execution.initialOut, "utf8"),
                  },
                ]
              : []),
            ...(execution.followUpOut !== undefined
              ? [
                  {
                    id: "sevro.claude.follow-up-events",
                    bytes: Buffer.from(execution.followUpOut, "utf8"),
                  },
                ]
              : []),
            ...(execution.err
              ? [
                  {
                    id: "sevro.claude.stderr",
                    bytes: Buffer.from(execution.err, "utf8"),
                  },
                ]
              : []),
          ],
          actualCondition: "passive" as const,
          inputTokens:
            execution.sessionResultsBound === false
              ? null
              : summary.inputTokens,
          outputTokens:
            execution.sessionResultsBound === false
              ? null
              : summary.outputTokens,
          costUsd:
            execution.sessionResultsBound === false ? null : summary.costUsd,
          usageComplete:
            execution.sessionResultsBound !== false && summary.usageComplete,
        };
      } finally {
        await rm(stateRoot, { recursive: true, force: true });
      }
    },
  };
}
