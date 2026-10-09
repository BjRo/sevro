import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { RuntimePolicy } from "./runtime-config";
import { insideRuntimeRoot, requireRuntimeReadRoots } from "./runtime-paths";
import { runtimeSeedDigest } from "./runtime-seeds";
import { prepareRuntimeState } from "./runtime-state";
import { macSandboxProfile } from "./hosts/mac-sandbox";
import type { IsolatedCommand } from "./hosts/mac-sandbox";
import { prepareLinuxSandboxCommand } from "./hosts/linux-sandbox";
import { isRecord, isUnknownArray } from "./value-guards";
import { hookExecutions, releaseHookProcesses } from "./runtime-hook-processes";

export interface HookMounts {
  directories: string[];
  receipts: string;
  isolation: IsolatedCommand[];
  plugins: {
    name: string;
    allowed: boolean;
    sourceDigest: string;
    effectiveDigest: string;
  }[];
}
interface HookRewrite {
  allowed: boolean;
  root: string;
  privateRoot: string;
  environment: Record<string, string>;
  profile?: string;
  isolation?: IsolatedCommand;
  ordinal: number;
  files: Set<string>;
}

export function runtimeHooksEnabled(
  policy: RuntimePolicy | undefined,
): boolean {
  const hooks = policy?.hooks;
  if (!hooks) return false;
  const plugins = hooks.plugins ?? [];
  return hooks.nativeGoal === true || plugins.length > 0;
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid runtime hook declaration");
  return value;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Materialize immutable mounts; only declared plugin hooks reach the host. */
export async function prepareHookMounts(options: {
  workspace: string;
  stateRoot: string;
  privateRoot: string;
  pluginRoots: string[];
  protectedRoots: string[];
  policy: RuntimePolicy;
}): Promise<HookMounts> {
  let mountRoot = join(options.stateRoot, "runtime-plugins");
  const receipts = join(options.privateRoot, "hook-receipts");
  await Promise.all(
    [mountRoot, receipts].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  mountRoot = await realpath(mountRoot);
  const runtime = await prepareRuntimeState(
    options.workspace,
    options.policy,
    "hooks",
    join(options.privateRoot, "hook-runtime"),
  );
  const selected = selectedPlugins(options.policy);
  const plugins: HookMounts["plugins"] = [],
    isolation: IsolatedCommand[] = [],
    directories: string[] = [];
  for (const [index, source] of options.pluginRoots.entries()) {
    const root = join(mountRoot, `plugin-${index}`);
    const sourceDigest = await runtimeSeedDigest(source);
    await cp(source, root, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
    });
    const manifest = object(
      JSON.parse(
        await readFile(join(root, ".claude-plugin/plugin.json"), "utf8"),
      ),
    );
    const name = uniquePluginName(manifest, plugins);
    const allowed = selected.delete(name);
    const readRoots = [...options.policy.readOnlyRoots, root];
    requireRuntimeReadRoots(readRoots, options.protectedRoots);
    const boundary = await prepareHookIsolation(options, index, readRoots, runtime.root);
    if (boundary.isolation) isolation.push(boundary.isolation);
    const rewrite: HookRewrite = {
      root,
      allowed,
      privateRoot: options.privateRoot,
      ...boundary,
      ordinal: index * 10000,
      files: new Set(),
      environment: {
        ...runtime.environment,
        PATH: hookPath(runtime.environment),
        CLAUDE_PLUGIN_ROOT: root,
        PLUGIN_ROOT: root,
      },
    };
    await rewritePlugin(manifest, rewrite);
    plugins.push({
      name,
      allowed,
      sourceDigest,
      effectiveDigest: await runtimeSeedDigest(root),
    });
    directories.push(root);
  }
  if (selected.size)
    throw new Error("runtime hook policy selects an unavailable plugin");
  return { directories, receipts, plugins, isolation };
}

async function prepareHookIsolation(
  options: Parameters<typeof prepareHookMounts>[0],
  index: number,
  readRoots: string[],
  runtimeRoot: string,
): Promise<{ profile?: string; isolation?: IsolatedCommand }> {
  if (process.platform === "linux")
    return {
      isolation: await prepareLinuxSandboxCommand({
        argv: ["/bin/true"],
        workspace: options.workspace,
        protectedRoots: options.protectedRoots,
        privateStateRoot: options.privateRoot,
        denyNetwork: true,
        readOnlyRoots: readRoots,
        writableRuntimeRoot: runtimeRoot,
      }),
    };
  const profile = join(options.privateRoot, `hooks-${index}.sb`);
  await writeFile(
    profile,
    macSandboxProfile(options.protectedRoots, true, readRoots, runtimeRoot) +
      "\n(deny process-info* (require-not (target self)))\n",
    { mode: 0o600 },
  );
  return { profile };
}

function hookPath(environment: Record<string, string>): string {
  return environment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
}
function selectedPlugins(policy: RuntimePolicy): Set<string> {
  return new Set(policy.hooks?.plugins ?? []);
}
function uniquePluginName(
  manifest: Record<string, unknown>,
  plugins: HookMounts["plugins"],
): string {
  if (typeof manifest.name !== "string")
    throw new Error("runtime hook plugin has no name");
  const name = manifest.name;
  if (plugins.some((plugin) => plugin.name === name))
    throw new Error("runtime hook plugin names overlap");
  return name;
}

async function rewritePlugin(
  manifest: Record<string, unknown>,
  state: HookRewrite,
): Promise<void> {
  await requireHookOnlyPlugin(state.root);
  await rewriteManifest(manifest, state, ".claude-plugin/plugin.json");
  const native = join(state.root, ".codex-plugin/plugin.json");
  if (await Bun.file(native).exists())
    await rewriteManifest(
      object(JSON.parse(await readFile(native, "utf8"))),
      state,
      ".codex-plugin/plugin.json",
    );
  const standard = join(state.root, "hooks/hooks.json");
  if (await Bun.file(standard).exists()) await hookFile(standard, state);
  await rewriteFrontmatter(state.root, state);
}

async function requireHookOnlyPlugin(root: string): Promise<void> {
  for (const name of [".mcp.json", ".lsp.json"])
    if (await Bun.file(join(root, name)).exists())
      throw new Error("runtime auxiliary plugin execution is unsupported");
}

async function rewriteManifest(
  manifest: Record<string, unknown>,
  state: HookRewrite,
  path: string,
): Promise<void> {
  if (manifest.mods !== undefined)
    throw new Error("runtime plugin mods are unsupported");
  delete manifest.mcpServers;
  delete manifest.lspServers;
  if (manifest.hooks !== undefined)
    manifest.hooks = await hookSource(manifest.hooks, state);
  await writeFile(join(state.root, path), JSON.stringify(manifest));
}

async function hookSource(
  value: unknown,
  state: HookRewrite,
): Promise<unknown> {
  if (typeof value === "string") {
    const path = await realpath(join(state.root, value));
    if (!insideRuntimeRoot(state.root, path))
      throw new Error("runtime hook file escapes its plugin");
    await hookFile(path, state);
    return value;
  }
  if (isUnknownArray(value))
    return Promise.all(value.map((source) => hookSource(source, state)));
  const configuration = object(value);
  if (configuration.hooks !== undefined)
    return {
      ...configuration,
      hooks: await hookMap(configuration.hooks, state),
    };
  return hookMap(configuration, state);
}

async function hookFile(path: string, state: HookRewrite): Promise<void> {
  if (state.files.has(path)) return;
  state.files.add(path);
  const value = object(JSON.parse(await readFile(path, "utf8")));
  value.hooks = await hookMap(value.hooks, state);
  await writeFile(path, JSON.stringify(value));
}

async function hookMap(
  value: unknown,
  state: HookRewrite,
): Promise<Record<string, unknown>> {
  if (!state.allowed) return {};
  const entries: [string, unknown][] = [];
  for (const [event, groups] of Object.entries(object(value))) {
    if (!isUnknownArray(groups))
      throw new Error("runtime hook groups must be arrays");
    entries.push([
      event,
      await Promise.all(
        groups.map(async (group) => {
          const definition = object(group);
          if (!isUnknownArray(definition.hooks))
            throw new Error("runtime hook handlers must be arrays");
          return {
            ...definition,
            hooks: await Promise.all(
              definition.hooks.map((handler) => commandHook(handler, state)),
            ),
          };
        }),
      ),
    ]);
  }
  return Object.fromEntries(entries);
}

async function commandHook(
  value: unknown,
  state: HookRewrite,
): Promise<Record<string, unknown>> {
  const handler = commandHandler(value);
  if (handler.command.includes("\0") || handler.command.length > 65536)
    throw new Error("runtime hook command is invalid or oversized");
  const wrapper = join(state.privateRoot, `hook-${state.ordinal++}.sh`);
  const environment = Object.entries(state.environment)
    .map(([name, content]) => `${name}=${content}`);
  const receipts = join(state.privateRoot, "hook-receipts");
  const command = isolatedHookCommand(state, environment, handler.command);
  await writeFile(
    wrapper,
    `#!/bin/sh
set -u
receipt=$(/usr/bin/mktemp ${quote(join(receipts, "call.XXXXXX"))}) || exit 125
test ! -f ${quote(join(receipts, "stopped"))} || exit 125
printf '{"status":"running","pid":%s,"wrapper":%s}\\n' "$$" ${quote(JSON.stringify(wrapper))} > "$receipt"
${command}
code=$?
printf '{"status":"completed","pid":%s,"exitCode":%s,"wrapper":%s}\\n' "$$" "$code" ${quote(JSON.stringify(wrapper))} > "$receipt"
exit "$code"
`,
    { mode: 0o700 },
  );
  return { ...handler, command: `/bin/sh ${quote(wrapper)}` };
}

function isolatedHookCommand(
  state: HookRewrite,
  environment: string[],
  command: string,
): string {
  const prefix = state.isolation
    ? state.isolation.argv.slice(0, -1)
    : ["/usr/bin/sandbox-exec", "-f", state.profile ?? ""];
  return [...prefix, "/usr/bin/env", "-i", ...environment, "/bin/sh", "-c", command]
    .map(quote)
    .join(" ");
}

function commandHandler(
  value: unknown,
): Record<string, unknown> & { command: string } {
  const handler = object(value);
  if (handler.type !== "command" || typeof handler.command !== "string")
    throw new Error("runtime policy supports command plugin hooks only");
  if (handler.args !== undefined)
    throw new Error("runtime exec-form hook arguments are unsupported");
  return { ...handler, command: handler.command };
}

async function rewriteFrontmatter(
  directory: string,
  state: HookRewrite,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await rewriteFrontmatter(path, state);
    else if (entry.name.endsWith(".md")) await rewriteMarkdown(path, state);
  }
}

async function rewriteMarkdown(
  path: string,
  state: HookRewrite,
): Promise<void> {
  const body = await readFile(path, "utf8");
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  const metadata = hookFrontmatter(header?.[1]);
  if (!metadata || !header) return;
  if (state.allowed) metadata.hooks = await hookMap(metadata.hooks, state);
  else delete metadata.hooks;
  await writeFile(
    path,
    `---\n${Bun.YAML.stringify(metadata)}---\n${body.slice(header[0].length)}`,
  );
}

function hookFrontmatter(
  header: string | undefined,
): Record<string, unknown> | undefined {
  if (!header?.includes("hooks")) return undefined;
  const metadata = object(Bun.YAML.parse(header));
  return metadata.hooks === undefined ? undefined : metadata;
}

export async function runtimeHookObservation(mounts: HookMounts) {
  await releaseHookProcesses(mounts.receipts);
  const executions = (await hookExecutions(mounts.receipts)).map(
    (execution) => ({
      status: execution.status,
      pid: execution.pid,
      exitCode: execution.exitCode,
    }),
  );
  return {
    id: "sevro.host.hooks",
    completeness: executions.every(
      (execution) => execution.status === "completed",
    )
      ? ("complete" as const)
      : ("partial" as const),
    data: { plugins: mounts.plugins, executions },
  };
}

export async function releaseRuntimeHooks(
  mounts: HookMounts | undefined,
): Promise<void> {
  if (!mounts) return;
  await releaseHookProcesses(mounts.receipts);
  await Promise.all(mounts.isolation.map((item) => item.release()));
}
