import {
  EvaluationConfigurationError,
  type EvaluationOptions,
  type ResolvedCase,
} from "./evaluation-types";
import { fixtureParts, type InlineArtifact } from "./preparation";
import { isStringArray } from "./value-guards";
import type { PreparationResult } from "./extension-session";

interface InvocationArtifacts {
  extensionPreparation: PreparationResult | null;
  inlineArtifacts: InlineArtifact[];
}

type ClaudePluginDirectories = NonNullable<
  NonNullable<InvocationArtifacts["extensionPreparation"]>["claudePluginDirs"]
>;
type CodexMarketplace = NonNullable<
  NonNullable<InvocationArtifacts["extensionPreparation"]>["codexMarketplace"]
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

function requireNegotiatedCapability(
  options: EvaluationOptions,
  capability: string,
  message: string,
): void {
  if (
    !options.extension?.session.identity.capabilities.includes(capability) ||
    !options.host.hostCapabilities?.includes(capability)
  )
    throw new EvaluationConfigurationError(message);
}

function validatePackageManifest(
  files: InlineArtifact[],
  manifest: string,
  message: string,
): void {
  if (
    !files.length ||
    !files.every((artifact) => artifact.gitExclude) ||
    !files.some((artifact) => artifact.relativePath === manifest)
  )
    throw new EvaluationConfigurationError(message);
}

function validateClaudePluginPackage(
  options: EvaluationOptions,
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

function marketplaceNamesValid(name: string, plugins: string[]): boolean {
  return (
    /^[a-z][a-z0-9-]*$/.test(name) &&
    plugins.length > 0 &&
    !plugins.some((plugin) => !/^[a-z][a-z0-9-]*$/.test(plugin)) &&
    new Set(plugins).size === plugins.length
  );
}

function validateMarketplaceDeclaration(marketplace: CodexMarketplace): void {
  try {
    fixtureParts(marketplace.artifactRoot);
    if (
      !marketplaceNamesValid(
        marketplace.marketplaceName,
        marketplace.pluginNames,
      )
    )
      throw new Error("invalid marketplace or plugin name");
  } catch (cause) {
    throw new EvaluationConfigurationError(
      "invalid Codex marketplace declaration",
      { cause },
    );
  }
}

function validateCodexMarketplacePackage(
  options: EvaluationOptions,
  marketplace: CodexMarketplace | undefined,
  artifacts: InlineArtifact[],
): void {
  if (!marketplace) return;
  validateMarketplaceDeclaration(marketplace);
  requireNegotiatedCapability(
    options,
    "sevro.codex.plugin-marketplace",
    "Codex marketplace capability was not negotiated",
  );
  const files = artifacts.filter((artifact) =>
    artifact.relativePath.startsWith(`${marketplace.artifactRoot}/`),
  );
  validatePackageManifest(
    files,
    `${marketplace.artifactRoot}/.claude-plugin/marketplace.json`,
    "Codex marketplace requires Git-excluded package artifacts and a manifest",
  );
}

function preparePackageArtifacts<T extends InvocationArtifacts>(
  options: EvaluationOptions,
  state: T,
) {
  const codexMarketplace = state.extensionPreparation?.codexMarketplace;
  const claudePluginDirs = state.extensionPreparation?.claudePluginDirs;
  validateClaudePluginPackage(options, claudePluginDirs, state.inlineArtifacts);
  validateCodexMarketplacePackage(
    options,
    codexMarketplace,
    state.inlineArtifacts,
  );
  return { ...state, codexMarketplace, claudePluginDirs };
}

type PackagePlan = ReturnType<
  typeof preparePackageArtifacts<InvocationArtifacts>
>;
const INVOCATION_PLACEHOLDER = "{{sevro.skill_invocation}}";
const LEGACY_CODEX_PLACEHOLDER = "{{sevro.codex.skill_invocation}}";

function skillInvocationDeclarations(
  preparation: PackagePlan["extensionPreparation"],
) {
  return {
    codexSkillInvocation: preparation?.codexSkillInvocation,
    codexRepositorySkillInvocation: preparation?.codexRepositorySkillInvocation,
    claudeSkillInvocation: preparation?.claudeSkillInvocation,
    claudeRepositorySkillInvocation:
      preparation?.claudeRepositorySkillInvocation,
  };
}

type SkillDeclarations = ReturnType<typeof skillInvocationDeclarations>;
type PluginSkillInvocation = NonNullable<
  SkillDeclarations["codexSkillInvocation"]
>;
type RepositorySkillInvocation = NonNullable<
  SkillDeclarations["codexRepositorySkillInvocation"]
>;
type SelectedSkillInvocation =
  | { kind: "codex-plugin"; value: PluginSkillInvocation }
  | { kind: "codex-repository"; value: RepositorySkillInvocation }
  | { kind: "claude-plugin"; value: PluginSkillInvocation }
  | { kind: "claude-repository"; value: RepositorySkillInvocation }
  | { kind: "none" };

function selectedSkillInvocation(
  declarations: SkillDeclarations,
): SelectedSkillInvocation {
  if (declarations.codexSkillInvocation)
    return { kind: "codex-plugin", value: declarations.codexSkillInvocation };
  if (declarations.codexRepositorySkillInvocation)
    return {
      kind: "codex-repository",
      value: declarations.codexRepositorySkillInvocation,
    };
  if (declarations.claudeRepositorySkillInvocation)
    return {
      kind: "claude-repository",
      value: declarations.claudeRepositorySkillInvocation,
    };
  if (declarations.claudeSkillInvocation)
    return { kind: "claude-plugin", value: declarations.claudeSkillInvocation };
  return { kind: "none" };
}

function invocationTokenFor(declarations: SkillDeclarations): string | null {
  if (declarations.codexRepositorySkillInvocation)
    return `$${declarations.codexRepositorySkillInvocation.skillName}`;
  if (declarations.claudeRepositorySkillInvocation)
    return `/${declarations.claudeRepositorySkillInvocation.skillName}`;
  if (declarations.codexSkillInvocation)
    return `$${declarations.codexSkillInvocation.pluginName}:${declarations.codexSkillInvocation.skillName}`;
  if (declarations.claudeSkillInvocation)
    return `/${declarations.claudeSkillInvocation.pluginName}:${declarations.claudeSkillInvocation.skillName}`;
  return null;
}

function invocationMetadata(declarations: SkillDeclarations) {
  const repositoryInvocation =
    declarations.codexRepositorySkillInvocation ??
    declarations.claudeRepositorySkillInvocation;
  const invocation = repositoryInvocation
    ? { ...repositoryInvocation, scope: "repository" as const }
    : (declarations.codexSkillInvocation ?? declarations.claudeSkillInvocation);
  return { repositoryInvocation, invocation };
}

function promptPlaceholderCount(
  caseData: ResolvedCase,
  placeholder: string,
): number {
  return (
    caseData.prompt.split(placeholder).length -
    1 +
    (caseData.followUpPrompt?.split(placeholder).length ?? 1) -
    1
  );
}

function validateOnlyOneInvocation(declarations: SkillDeclarations): void {
  if (
    [
      declarations.codexSkillInvocation,
      declarations.codexRepositorySkillInvocation,
      declarations.claudeSkillInvocation,
      declarations.claudeRepositorySkillInvocation,
    ].filter(Boolean).length > 1
  )
    throw new EvaluationConfigurationError(
      "only one explicit skill invocation may be declared",
    );
}

function validateCodexInvocationMembership(
  marketplace: CodexMarketplace | undefined,
  pluginName: string,
): asserts marketplace is CodexMarketplace {
  if (
    !marketplace ||
    !marketplace.pluginNames.includes(pluginName) ||
    !/^[a-z][a-z0-9-]*$/.test(pluginName)
  )
    throw new EvaluationConfigurationError(
      "invalid Codex skill invocation declaration",
    );
}

function validateCodexInvocationBody(
  marketplace: CodexMarketplace,
  skillName: string,
  artifacts: InlineArtifact[],
  placeholders: number,
): void {
  if (
    !/^[A-Za-z0-9._-]+$/.test(skillName) ||
    placeholders !== 1 ||
    !artifacts.some(
      (artifact) =>
        artifact.relativePath ===
        `${marketplace.artifactRoot}/plugin/skills/${skillName}/SKILL.md`,
    )
  )
    throw new EvaluationConfigurationError(
      "invalid Codex skill invocation declaration",
    );
}

function validateCodexPluginInvocation(
  options: EvaluationOptions,
  context: PackagePlan,
  invocation: PluginSkillInvocation,
  placeholders: number,
): void {
  const marketplace = context.codexMarketplace;
  validateCodexInvocationMembership(marketplace, invocation.pluginName);
  validateCodexInvocationBody(
    marketplace,
    invocation.skillName,
    context.inlineArtifacts,
    placeholders,
  );
  requireNegotiatedCapability(
    options,
    "sevro.codex.explicit-invocation",
    "Codex explicit invocation capability was not negotiated",
  );
}

function validRepositoryInvocationIdentity(
  skillName: string,
  placeholders: number,
): boolean {
  return (
    /^[A-Za-z0-9._-]+$/.test(skillName) &&
    skillName !== "." &&
    skillName !== ".." &&
    placeholders === 1
  );
}

function validateRepositoryInvocationBody(
  artifacts: InlineArtifact[],
  path: string,
  message: string,
): void {
  if (
    !artifacts.some(
      (artifact) => artifact.gitExclude && artifact.relativePath === path,
    )
  )
    throw new EvaluationConfigurationError(message);
}

function validateCodexRepositoryInvocation(
  options: EvaluationOptions,
  context: PackagePlan,
  invocation: RepositorySkillInvocation,
  placeholders: number,
): void {
  const message = "invalid Codex repository skill invocation declaration";
  if (!validRepositoryInvocationIdentity(invocation.skillName, placeholders))
    throw new EvaluationConfigurationError(message);
  validateRepositoryInvocationBody(
    context.inlineArtifacts,
    `.agents/skills/${invocation.skillName}/SKILL.md`,
    message,
  );
  requireNegotiatedCapability(
    options,
    "sevro.codex.repository-invocation",
    "Codex repository invocation capability was not negotiated",
  );
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
  options: EvaluationOptions,
  context: PackagePlan,
  invocation: RepositorySkillInvocation,
  placeholders: number,
): void {
  const message = "invalid Claude repository skill invocation declaration";
  if (!validRepositoryInvocationIdentity(invocation.skillName, placeholders))
    throw new EvaluationConfigurationError(message);
  validateClaudeRepositoryPrompt(options.case.prompt);
  validateRepositoryInvocationBody(
    context.inlineArtifacts,
    `.claude/skills/${invocation.skillName}/SKILL.md`,
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
    !/^[a-z][a-z0-9-]*$/.test(invocation.pluginName) ||
    !/^[A-Za-z0-9._-]+$/.test(invocation.skillName) ||
    placeholders !== 1
  )
    throw new EvaluationConfigurationError(
      "invalid Claude skill invocation declaration",
    );
}

function validateClaudePluginPrompt(caseData: ResolvedCase): void {
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
          artifact.relativePath === `${root}/skills/${skillName}/SKILL.md`,
      ),
    )
  )
    throw new EvaluationConfigurationError(
      "invalid Claude skill invocation declaration",
    );
}

function validateClaudePluginInvocation(
  options: EvaluationOptions,
  context: PackagePlan,
  invocation: PluginSkillInvocation,
  placeholders: number,
): void {
  const directories = context.claudePluginDirs;
  validateClaudeInvocationIdentity(directories, invocation, placeholders);
  validateClaudePluginPrompt(options.case);
  validateClaudeInvocationBody(
    directories,
    invocation.skillName,
    context.inlineArtifacts,
  );
  requireNegotiatedCapability(
    options,
    "sevro.claude.explicit-invocation",
    "Claude explicit invocation capability was not negotiated",
  );
}

function validateUndeclaredPlaceholder(placeholders: number): void {
  if (placeholders)
    throw new EvaluationConfigurationError(
      "skill invocation placeholder requires a declaration",
    );
}

function validateSelectedSkillInvocation(
  options: EvaluationOptions,
  context: PackagePlan,
  selected: SelectedSkillInvocation,
  placeholders: number,
): void {
  switch (selected.kind) {
    case "codex-plugin":
      validateCodexPluginInvocation(
        options,
        context,
        selected.value,
        placeholders,
      );
      break;
    case "codex-repository":
      validateCodexRepositoryInvocation(
        options,
        context,
        selected.value,
        placeholders,
      );
      break;
    case "claude-repository":
      validateClaudeRepositoryInvocation(
        options,
        context,
        selected.value,
        placeholders,
      );
      break;
    case "claude-plugin":
      validateClaudePluginInvocation(
        options,
        context,
        selected.value,
        placeholders,
      );
      break;
    case "none":
      validateUndeclaredPlaceholder(placeholders);
      break;
  }
}

function prepareSkillInvocation<T extends PackagePlan>(
  options: EvaluationOptions,
  state: T,
) {
  const declarations = skillInvocationDeclarations(state.extensionPreparation);
  const metadata = invocationMetadata(declarations);
  const invocationToken = invocationTokenFor(declarations);
  const placeholderCount =
    promptPlaceholderCount(options.case, INVOCATION_PLACEHOLDER) +
    promptPlaceholderCount(options.case, LEGACY_CODEX_PLACEHOLDER);
  validateOnlyOneInvocation(declarations);
  validateSelectedSkillInvocation(
    options,
    state,
    selectedSkillInvocation(declarations),
    placeholderCount,
  );
  return {
    ...state,
    ...declarations,
    ...metadata,
    invocationToken,
    invocationPlaceholder: INVOCATION_PLACEHOLDER,
    legacyCodexPlaceholder: LEGACY_CODEX_PLACEHOLDER,
    placeholderCount,
  };
}

export function prepareInvocationPlan<T extends InvocationArtifacts>(
  options: EvaluationOptions,
  state: T,
) {
  return prepareSkillInvocation(
    options,
    preparePackageArtifacts(options, state),
  );
}
