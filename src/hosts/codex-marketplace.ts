import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fixtureParts } from "../preparation";
import type { HostAdapter } from "../engine";
import { runCodexProcess } from "./codex-process";
import { isRecord, isUnknownArray } from "../value-guards";
type Request = Parameters<HostAdapter["run"]>[0];
type Declaration = NonNullable<Request["codexMarketplace"]>;
interface InstallContext {
  binary: string;
  env: Record<string, string>;
  pluginCacheRoot: string;
  request: Request;
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}
function validPluginNames(declaration: Declaration): boolean {
  const names = declaration.pluginNames;
  return (
    /^[a-z][a-z0-9-]*$/.test(declaration.marketplaceName) &&
    names.length > 0 &&
    names.every((name) => /^[a-z][a-z0-9-]*$/.test(name)) &&
    new Set(names).size === names.length
  );
}
function validArtifactPaths(
  declaration: Declaration,
  paths: Set<string>,
): boolean {
  return (
    declaration.artifactPaths.length > 0 &&
    paths.size === declaration.artifactPaths.length &&
    declaration.artifactPaths.every(
      (path) =>
        path.startsWith(`${declaration.artifactRoot}/`) &&
        fixtureParts(path).join("/") === path,
    )
  );
}

async function marketplaceRoot(
  workspace: string,
  declaration: Declaration,
): Promise<string> {
  const paths = new Set(declaration.artifactPaths);
  if (!validPluginNames(declaration) || !validArtifactPaths(declaration, paths))
    throw new Error("invalid Codex marketplace declaration");
  const root = join(workspace, ...fixtureParts(declaration.artifactRoot));
  const actualWorkspace = await realpath(workspace),
    actualRoot = await realpath(root);
  if (!inside(actualWorkspace, actualRoot) || actualRoot === actualWorkspace)
    throw new Error("Codex marketplace escapes the workspace");
  await verifyMarketplaceManifest(actualRoot, declaration);
  await verifyMaterializedPackage(actualRoot, declaration.artifactRoot, paths);
  return actualRoot;
}

function objectRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(message);
  // JSON arrays also have unknown-valued object properties; field validation follows.
  return value as Record<string, unknown>;
}
async function marketplaceManifest(
  root: string,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
    );
  } catch (error) {
    throw new Error("Codex marketplace manifest is unreadable", {
      cause: error,
    });
  }
  return objectRecord(value, "invalid Codex marketplace manifest");
}
async function verifyMarketplaceManifest(
  root: string,
  declaration: Declaration,
): Promise<void> {
  const document = await marketplaceManifest(root);
  const plugins = document.plugins;
  if (
    document.name !== declaration.marketplaceName ||
    !isUnknownArray(plugins) ||
    plugins.length !== declaration.pluginNames.length
  )
    throw new Error("Codex marketplace manifest does not match declaration");
  const found = new Set<string>();
  for (const entry of plugins)
    await verifyLocalPlugin(entry, declaration.pluginNames, found, root);
}
function declaredName(
  name: unknown,
  names: string[],
  found: Set<string>,
): name is string {
  return typeof name === "string" && names.includes(name) && !found.has(name);
}
function localSource(source: unknown): source is string {
  return typeof source === "string" && source.startsWith("./");
}
async function verifyLocalPlugin(
  entry: unknown,
  names: string[],
  found: Set<string>,
  root: string,
): Promise<void> {
  const plugin = objectRecord(entry, "invalid Codex marketplace plugin");
  if (!declaredName(plugin.name, names, found) || !localSource(plugin.source))
    throw new Error("Codex marketplace plugin is not a declared local source");
  found.add(plugin.name);
  const source = join(root, ...fixtureParts(plugin.source.slice(2)));
  if (!inside(root, await realpath(source)))
    throw new Error("Codex marketplace plugin escapes its artifact root");
}

interface PackageState {
  pending: string[];
  seen: Set<string>;
  expected: Set<string>;
  root: string;
  artifactRoot: string;
}
async function verifyMaterializedPackage(
  root: string,
  artifactRoot: string,
  expected: Set<string>,
): Promise<void> {
  const state: PackageState = {
    pending: [root],
    seen: new Set(),
    expected,
    root,
    artifactRoot,
  };
  while (state.pending.length) {
    const directory = state.pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory, { withFileTypes: true }))
      verifyPackageEntry(directory, entry, state);
  }
  if (state.seen.size !== expected.size)
    throw new Error("Codex marketplace package is missing declared files");
}
function verifyPackageEntry(
  directory: string,
  entry: Dirent,
  state: PackageState,
): void {
  if (entry.isSymbolicLink())
    throw new Error("Codex marketplace package contains a symlink");
  if (entry.isDirectory()) {
    state.pending.push(join(directory, entry.name));
    return;
  }
  if (!entry.isFile())
    throw new Error("Codex marketplace package contains a special file");
  const path = `${state.artifactRoot}/${relative(state.root, join(directory, entry.name)).split(sep).join("/")}`;
  if (!state.expected.has(path))
    throw new Error("Codex marketplace package contains undeclared files");
  state.seen.add(path);
}

async function pluginCommand(context: InstallContext, args: string[]) {
  return runCodexProcess({
    argv: [context.binary, "plugin", ...args, "--json"],
    cwd: context.request.workspace,
    env: context.env,
    timeoutMs: 30_000,
    signal: context.request.signal,
  });
}
export async function installCodexPlugins(
  context: InstallContext,
): Promise<string[]> {
  const declaration = context.request.codexMarketplace;
  if (!declaration) return [];
  const root = await marketplaceRoot(context.request.workspace, declaration);
  const added = await pluginCommand(context, ["marketplace", "add", root]);
  if (added.code !== 0)
    throw new Error("Codex local marketplace installation failed");
  const installed: string[] = [];
  for (const plugin of declaration.pluginNames)
    installed.push(await installPlugin(context, declaration, plugin));
  return installed;
}
async function installPlugin(
  context: InstallContext,
  declaration: Declaration,
  pluginName: string,
): Promise<string> {
  const installed = await pluginCommand(context, [
    "add",
    `${pluginName}@${declaration.marketplaceName}`,
  ]);
  if (installed.code !== 0)
    throw new Error("Codex local plugin installation failed");
  const path = await installedPluginPath(
    installed.out,
    declaration.marketplaceName,
    pluginName,
    context.pluginCacheRoot,
  );
  await verifyInstalledInvocation(context.request, pluginName, path);
  return path;
}
function installationReceipt(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("Codex plugin installation receipt is invalid", {
      cause: error,
    });
  }
  if (!isRecord(value))
    throw new Error("Codex plugin installation receipt is invalid");
  return value;
}
function matchingReceipt(
  receipt: Record<string, unknown>,
  marketplace: string,
  plugin: string,
  path: string | null,
): boolean {
  return (
    receipt.name === plugin &&
    receipt.marketplaceName === marketplace &&
    path !== null
  );
}
async function installedPluginPath(
  text: string,
  marketplace: string,
  plugin: string,
  cache: string,
): Promise<string> {
  const receipt = installationReceipt(text);
  const path =
    typeof receipt.installedPath === "string"
      ? await realpath(receipt.installedPath)
      : null;
  if (
    !matchingReceipt(receipt, marketplace, plugin, path) ||
    path === null ||
    !inside(await realpath(cache), path)
  )
    throw new Error("Codex plugin installation receipt is invalid");
  return path;
}
async function verifyInstalledInvocation(
  request: Request,
  plugin: string,
  path: string,
): Promise<void> {
  const selected = request.explicitSkillInvocation;
  if (selected?.pluginName !== plugin) return;
  const skill = await stat(
    join(path, "skills", selected.skillName, "SKILL.md"),
  ).catch(() => null);
  if (!skill?.isFile())
    throw new Error("invoked Codex skill is absent from the installation");
}
