import { EvaluationConfigurationError } from "../host-contract/index";
import type { PreparationResult } from "../extensions/index";
import { fixtureParts, type InlineArtifact } from "../fixtures/index";
import {
  validInvocationSkillIdentity,
  safeRepositorySkillEntry,
  validPluginName,
  validRepositoryInvocationIdentity,
  validateRepositoryInvocationBody,
  invocationTokenCount,
  pluginSkillPath,
  requireNegotiatedCapability,
  validatePackageManifest,
  invocationPlaceholderCount,
  type InvocationPreparation,
  type InvocationDeclaration,
  type PreparedInvocationPackage,
} from "./invocation-rules";
import { isStringArray, isRecord } from "../kernel/index";
import {
  INVOCATION_PLACEHOLDER,
  LEGACY_CODEX_PLACEHOLDER,
} from "./invocation-rules";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { HostAdapter } from "../host-contract/index";
import { insideRuntimeRoot as inside } from "../runtime/index";

type PluginSkillInvocation = NonNullable<
  PreparationResult["claudeSkillInvocation"]
>;
type RepositorySkillInvocation = NonNullable<
  PreparationResult["claudeRepositorySkillInvocation"]
>;
type ClaudePluginDirectories = NonNullable<
  PreparationResult["claudePluginDirs"]
>;
function uniquePluginRoots(value: unknown): value is string[] {
  return (
    isStringArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length
  );
}

function validateClaudePluginRoots(roots: string[]): void {
  try {
    if (!uniquePluginRoots(roots)) throw new Error("invalid plugin roots");
    for (const root of roots) fixtureParts(root);
    if (
      roots.some((root) =>
        roots.some((other) => root !== other && root.startsWith(`${other}/`)),
      )
    )
      throw new Error("overlapping plugin roots");
  } catch (cause) {
    throw new EvaluationConfigurationError(
      "invalid Claude plugin directory declaration",
      { cause },
    );
  }
}

function validateClaudePluginPackage(
  options: InvocationPreparation,
  directories: ClaudePluginDirectories | undefined,
  artifacts: InlineArtifact[],
): void {
  if (!directories) return;
  const roots = directories.artifactRoots;
  validateClaudePluginRoots(roots);
  requireNegotiatedCapability(
    options,
    "sevro.claude.plugin-dirs",
    "Claude plugin directory capability was not negotiated",
  );
  for (const root of roots) {
    const files = artifacts.filter((artifact) =>
      artifact.relativePath.startsWith(`${root}/`),
    );
    validatePackageManifest(
      files,
      `${root}/.claude-plugin/plugin.json`,
      "Claude plugin directory requires Git-excluded package artifacts and a manifest",
    );
  }
}

function validateClaudeRepositoryPrompt(prompt: string): void {
  if (
    !prompt.startsWith(INVOCATION_PLACEHOLDER) ||
    prompt.includes(LEGACY_CODEX_PLACEHOLDER)
  )
    throw new EvaluationConfigurationError(
      "invalid Claude repository skill invocation declaration",
    );
}

function validateClaudeRepositoryInvocation(
  options: InvocationPreparation,
  invocation: RepositorySkillInvocation,
  placeholders: number,
): void {
  const message = "invalid Claude repository skill invocation declaration";
  if (!validRepositoryInvocationIdentity(invocation.skillName, placeholders))
    throw new EvaluationConfigurationError(message);
  validateClaudeRepositoryPrompt(options.case.prompt);
  validateRepositoryInvocationBody(
    options.inlineArtifacts,
    claudeRepositorySkillPath(invocation.skillName),
    message,
  );
  requireNegotiatedCapability(
    options,
    "sevro.claude.repository-invocation",
    "Claude repository invocation capability was not negotiated",
  );
}

function validateClaudeInvocationIdentity(
  directories: ClaudePluginDirectories | undefined,
  invocation: PluginSkillInvocation,
  placeholders: number,
): asserts directories is ClaudePluginDirectories {
  if (
    !directories ||
    !validPluginName(invocation.pluginName) ||
    !validInvocationSkillIdentity(invocation.skillName, placeholders)
  )
    throw new EvaluationConfigurationError(
      "invalid Claude skill invocation declaration",
    );
}

function validateClaudePluginPrompt(
  caseData: InvocationPreparation["case"],
): void {
  if (
    caseData.prompt.includes(LEGACY_CODEX_PLACEHOLDER) ||
    caseData.followUpPrompt?.includes(LEGACY_CODEX_PLACEHOLDER)
  )
    throw new EvaluationConfigurationError(
      "invalid Claude skill invocation declaration",
    );
}

function validateClaudeInvocationBody(
  directories: ClaudePluginDirectories,
  skillName: string,
  artifacts: InlineArtifact[],
): void {
  if (
    !directories.artifactRoots.some((root) =>
      artifacts.some(
        (artifact) =>
          artifact.relativePath === pluginSkillPath(root, skillName),
      ),
    )
  )
    throw new EvaluationConfigurationError(
      "invalid Claude skill invocation declaration",
    );
}

function validateClaudePluginInvocation(
  options: InvocationPreparation,
  invocation: PluginSkillInvocation,
  placeholders: number,
): void {
  const directories = options.extensionPreparation?.claudePluginDirs;
  validateClaudeInvocationIdentity(directories, invocation, placeholders);
  validateClaudePluginPrompt(options.case);
  validateClaudeInvocationBody(
    directories,
    invocation.skillName,
    options.inlineArtifacts,
  );
  requireNegotiatedCapability(
    options,
    "sevro.claude.explicit-invocation",
    "Claude explicit invocation capability was not negotiated",
  );
}

export function claudeInvocationDeclarations(
  input: InvocationPreparation,
): InvocationDeclaration[] {
  const preparation = input.extensionPreparation;
  const declarations: InvocationDeclaration[] = [];
  const repository = preparation?.claudeRepositorySkillInvocation;
  if (repository)
    declarations.push({
      configuration: { claudeRepositorySkillInvocation: repository },
      resolve() {
        validateClaudeRepositoryInvocation(
          input,
          repository,
          invocationPlaceholderCount(input),
        );
        return {
          ...repository,
          scope: "repository",
          token: claudeRepositoryToken(repository.skillName),
        };
      },
    });
  const plugin = preparation?.claudeSkillInvocation;
  if (plugin)
    declarations.push({
      configuration: { claudeSkillInvocation: plugin },
      resolve() {
        validateClaudePluginInvocation(
          input,
          plugin,
          invocationPlaceholderCount(input),
        );
        return {
          ...plugin,
          token: claudePluginToken(plugin),
        };
      },
    });
  return declarations;
}
export function prepareClaudePackage(
  input: InvocationPreparation,
): PreparedInvocationPackage {
  const directories = input.extensionPreparation?.claudePluginDirs;
  validateClaudePluginPackage(input, directories, input.inlineArtifacts);
  if (!directories) return { configuration: {}, hostRequest: {} };
  return {
    configuration: { claudePluginDirs: directories },
    hostRequest: {
      claudePluginDirs: {
        ...directories,
        artifactPaths: input.inlineArtifacts
          .filter((artifact) =>
            directories.artifactRoots.some((root) =>
              artifact.relativePath.startsWith(`${root}/`),
            ),
          )
          .map((artifact) => artifact.relativePath),
      },
    },
  };
}

export interface ClaudeRepositoryInvocation {
  skillName: string;
  skillDir: string;
  skillText: string;
  prompt: string;
}

/** Validate the native project mount before candidate execution. */
export async function verifyClaudeRepositoryInvocation(
  request: Parameters<HostAdapter["run"]>[0],
): Promise<ClaudeRepositoryInvocation> {
  const selected = request.explicitSkillInvocation;
  requireRepositorySelection(selected);
  const { skillName, token } = selected;
  if (!validRepositoryDeclaration(skillName, token, request.prompt))
    throw new Error("invalid Claude repository skill invocation");
  let path = await realpath(request.workspace);
  for (const [index, part] of claudeRepositorySkillPath(skillName)
    .split("/")
    .entries()) {
    path = join(path, part);
    const entry = await lstat(path).catch(() => null);
    if (!safeRepositorySkillEntry(entry, index))
      throw new Error(
        "invoked Claude repository skill is unavailable or unsafe",
      );
  }
  return {
    skillName,
    skillDir: join(path, ".."),
    skillText: await readFile(path, "utf8"),
    prompt: request.prompt,
  };
}

function requireRepositorySelection(
  selected: Parameters<HostAdapter["run"]>[0]["explicitSkillInvocation"],
): asserts selected is Extract<
  NonNullable<Parameters<HostAdapter["run"]>[0]["explicitSkillInvocation"]>,
  { scope: "repository" }
> {
  if (!selected || selected.scope !== "repository")
    throw new Error("Claude repository invocation is not declared");
}

function validRepositoryDeclaration(
  skillName: string,
  token: string,
  prompt: string,
): boolean {
  return (
    validRepositoryInvocationIdentity(
      skillName,
      invocationTokenCount({ prompt }, token),
    ) &&
    token === claudeRepositoryToken(skillName) &&
    repositoryPromptMatches(prompt, token)
  );
}
function repositoryPromptMatches(prompt: string, token: string): boolean {
  return (
    prompt === token ||
    prompt.startsWith(token + " ") ||
    prompt.startsWith(token + "\n")
  );
}
export async function verifyClaudeRepositoryMount(
  request: Parameters<HostAdapter["run"]>[0],
  projectSettings: boolean | undefined,
): Promise<ClaudeRepositoryInvocation | null> {
  if (request.explicitSkillInvocation?.scope !== "repository") return null;
  if (!projectSettings)
    throw new Error(
      "Claude repository invocation requires project setting sources",
    );
  return verifyClaudeRepositoryInvocation(request);
}

type Request = Parameters<HostAdapter["run"]>[0];
type PluginDeclaration = NonNullable<Request["claudePluginDirs"]>;
type PluginInvocation = NonNullable<Request["explicitSkillInvocation"]> & {
  scope?: "plugin";
};
async function pluginDirectories(
  workspace: string,
  declaration: PluginDeclaration,
): Promise<string[]> {
  const root = await realpath(workspace);
  requireUniquePluginDeclaration(declaration);
  const paths = new Set(declaration.artifactPaths);
  const directories: string[] = [];
  for (const relativeRoot of declaration.artifactRoots)
    directories.push(await declaredPluginDirectory(root, relativeRoot, paths));
  requireDisjointPluginDirectories(directories);
  for (const artifactPath of paths)
    await verifyPluginArtifact(root, artifactPath, declaration, directories);
  return directories;
}

function requireUniquePluginDeclaration(declaration: PluginDeclaration): void {
  if (
    new Set(declaration.artifactRoots).size !==
      declaration.artifactRoots.length ||
    new Set(declaration.artifactPaths).size !== declaration.artifactPaths.length
  )
    throw new Error("Claude plugin declaration contains duplicates");
}

async function declaredPluginDirectory(
  root: string,
  relativeRoot: string,
  paths: Set<string>,
): Promise<string> {
  fixtureParts(relativeRoot);
  if (!paths.has(`${relativeRoot}/.claude-plugin/plugin.json`))
    throw new Error("Claude plugin manifest is undeclared");
  const actual = await realpath(join(root, relativeRoot));
  if (!inside(root, actual))
    throw new Error("Claude plugin directory escapes workspace");
  if (!(await stat(join(actual, ".claude-plugin", "plugin.json"))).isFile())
    throw new Error("Claude plugin manifest is missing");
  return actual;
}

function requireDisjointPluginDirectories(directories: string[]): void {
  if (new Set(directories).size !== directories.length)
    throw new Error("Claude plugin directories overlap");
  if (
    directories.some((item) =>
      directories.some((other) => item !== other && inside(other, item)),
    )
  )
    throw new Error("Claude plugin directories overlap");
}

async function verifyPluginArtifact(
  root: string,
  artifactPath: string,
  declaration: PluginDeclaration,
  directories: string[],
): Promise<void> {
  fixtureParts(artifactPath);
  const index = declaration.artifactRoots.findIndex((item) =>
    artifactPath.startsWith(`${item}/`),
  );
  const directory = directories.at(index);
  if (index < 0 || directory === undefined)
    throw new Error("Claude plugin artifact is outside a declared directory");
  if (!inside(directory, await realpath(join(root, artifactPath))))
    throw new Error("Claude plugin artifact escapes workspace");
}

function pluginSelection(request: Request): PluginInvocation | null {
  const selected = request.explicitSkillInvocation;
  if (!selected || selected.scope === "repository") return null;
  return selected;
}

/** Preserve the initial-turn-only runtime rule; preparation accepts both turns. */
function requirePluginInvocation(
  selected: PluginInvocation,
  prompt: string,
): void {
  const { token, pluginName, skillName } = selected;
  if (
    token !== claudePluginToken(selected) ||
    !validPluginName(pluginName) ||
    !validInvocationSkillIdentity(
      skillName,
      invocationTokenCount({ prompt }, token),
    )
  )
    throw new Error("invalid Claude explicit skill invocation");
}

function skillPathDeclared(
  request: Request,
  index: number,
  skillName: string,
): boolean {
  const relativeRoot = request.claudePluginDirs?.artifactRoots[index];
  return !!request.claudePluginDirs?.artifactPaths.includes(
    pluginSkillPath(String(relativeRoot), skillName),
  );
}

async function verifyInvocation(
  request: Request,
  directories: string[],
): Promise<void> {
  const selected = pluginSelection(request);
  if (!selected) return;
  requirePluginInvocation(selected, request.prompt);
  for (const [index, root] of directories.entries()) {
    if (!skillPathDeclared(request, index, selected.skillName)) continue;
    if (await mountedPluginSkill(root, selected)) return;
  }
  throw new Error("invoked Claude skill is absent from the package");
}

async function mountedPluginSkill(
  root: string,
  selected: PluginInvocation,
): Promise<boolean> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8"),
    );
  } catch (error) {
    throw new Error("invalid Claude plugin manifest", { cause: error });
  }
  if (!isRecord(manifest) || manifest.name !== selected.pluginName)
    return false;
  const skill = await stat(pluginSkillPath(root, selected.skillName)).catch(
    () => null,
  );
  return !!skill?.isFile();
}

export async function verifyClaudePluginInvocation(
  request: Request,
): Promise<string[]> {
  const directories = request.claudePluginDirs
    ? await pluginDirectories(request.workspace, request.claudePluginDirs)
    : [];
  await verifyInvocation(request, directories);
  return directories;
}

function claudeRepositorySkillPath(skillName: string): string {
  return `.claude/skills/${skillName}/SKILL.md`;
}

function claudePluginToken(invocation: PluginSkillInvocation): string {
  return `/${invocation.pluginName}:${invocation.skillName}`;
}
function claudeRepositoryToken(skillName: string): string {
  return `/${skillName}`;
}
