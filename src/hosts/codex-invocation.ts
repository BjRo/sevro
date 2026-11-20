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
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { HostAdapter } from "../host-contract/index";

type PluginSkillInvocation = NonNullable<
  PreparationResult["codexSkillInvocation"]
>;
type RepositorySkillInvocation = NonNullable<
  PreparationResult["codexRepositorySkillInvocation"]
>;
type CodexMarketplace = NonNullable<PreparationResult["codexMarketplace"]>;
export function marketplaceNamesValid(
  name: string,
  plugins: string[],
): boolean {
  return (
    validPluginName(name) &&
    plugins.length > 0 &&
    !plugins.some((plugin) => !validPluginName(plugin)) &&
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
  options: InvocationPreparation,
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

function validateCodexInvocationMembership(
  marketplace: CodexMarketplace | undefined,
  pluginName: string,
): asserts marketplace is CodexMarketplace {
  if (
    !marketplace ||
    !marketplace.pluginNames.includes(pluginName) ||
    !validPluginName(pluginName)
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
    !validInvocationSkillIdentity(skillName, placeholders) ||
    !artifacts.some(
      (artifact) =>
        artifact.relativePath ===
        pluginSkillPath(`${marketplace.artifactRoot}/plugin`, skillName),
    )
  )
    throw new EvaluationConfigurationError(
      "invalid Codex skill invocation declaration",
    );
}

function validateCodexPluginInvocation(
  options: InvocationPreparation,
  invocation: PluginSkillInvocation,
  placeholders: number,
): void {
  const marketplace = options.extensionPreparation?.codexMarketplace;
  validateCodexInvocationMembership(marketplace, invocation.pluginName);
  validateCodexInvocationBody(
    marketplace,
    invocation.skillName,
    options.inlineArtifacts,
    placeholders,
  );
  requireNegotiatedCapability(
    options,
    "sevro.codex.explicit-invocation",
    "Codex explicit invocation capability was not negotiated",
  );
}

function validateCodexRepositoryInvocation(
  options: InvocationPreparation,
  invocation: RepositorySkillInvocation,
  placeholders: number,
): void {
  const message = "invalid Codex repository skill invocation declaration";
  if (!validRepositoryInvocationIdentity(invocation.skillName, placeholders))
    throw new EvaluationConfigurationError(message);
  validateRepositoryInvocationBody(
    options.inlineArtifacts,
    codexRepositorySkillPath(invocation.skillName),
    message,
  );
  requireNegotiatedCapability(
    options,
    "sevro.codex.repository-invocation",
    "Codex repository invocation capability was not negotiated",
  );
}

export function codexInvocationDeclarations(
  input: InvocationPreparation,
): InvocationDeclaration[] {
  const preparation = input.extensionPreparation;
  const declarations: InvocationDeclaration[] = [];
  const plugin = preparation?.codexSkillInvocation;
  if (plugin)
    declarations.push({
      configuration: { codexSkillInvocation: plugin },
      resolve() {
        validateCodexPluginInvocation(
          input,
          plugin,
          invocationPlaceholderCount(input),
        );
        return {
          ...plugin,
          token: codexPluginToken(plugin),
        };
      },
    });
  const repository = preparation?.codexRepositorySkillInvocation;
  if (repository)
    declarations.push({
      configuration: { codexRepositorySkillInvocation: repository },
      resolve() {
        validateCodexRepositoryInvocation(
          input,
          repository,
          invocationPlaceholderCount(input),
        );
        return {
          ...repository,
          scope: "repository",
          token: codexRepositoryToken(repository.skillName),
        };
      },
    });
  return declarations;
}
export function prepareCodexPackage(
  input: InvocationPreparation,
): PreparedInvocationPackage {
  const marketplace = input.extensionPreparation?.codexMarketplace;
  validateCodexMarketplacePackage(input, marketplace, input.inlineArtifacts);
  if (!marketplace) return { configuration: {}, hostRequest: {} };
  return {
    configuration: { codexMarketplace: marketplace },
    hostRequest: {
      codexMarketplace: {
        ...marketplace,
        artifactPaths: input.inlineArtifacts
          .filter((artifact) =>
            artifact.relativePath.startsWith(`${marketplace.artifactRoot}/`),
          )
          .map((artifact) => artifact.relativePath),
      },
    },
  };
}

type Request = Parameters<HostAdapter["run"]>[0];
type Invocation = NonNullable<Request["explicitSkillInvocation"]>;

/** Runtime also rejects dot names, already excluded by prepared artifact paths. */
export async function verifyCodexInvocation(request: Request): Promise<void> {
  const selected = request.explicitSkillInvocation;
  if (!selected) return;
  if (
    !validRepositoryInvocationIdentity(
      selected.skillName,
      invocationTokenCount(request, selected.token),
    )
  )
    throw new Error("invalid Codex explicit skill invocation");
  if (selected.scope === "repository") {
    await verifyRepositorySkill(request, selected);
    return;
  }
  requirePluginInvocation(request, selected);
}
async function verifyRepositorySkill(
  request: Request,
  selected: Invocation,
): Promise<void> {
  if (selected.token !== codexRepositoryToken(selected.skillName))
    throw new Error("invalid Codex explicit skill invocation");
  let path = request.workspace;
  for (const [index, part] of codexRepositorySkillPath(selected.skillName)
    .split("/")
    .entries()) {
    path = join(path, part);
    const entry = await lstat(path).catch(() => null);
    if (!safeRepositorySkillEntry(entry, index))
      throw new Error(
        "invoked Codex repository skill is unavailable or unsafe",
      );
  }
}
function requirePluginInvocation(
  request: Request,
  selected: Invocation & { scope?: "plugin" },
): void {
  if (
    !request.codexMarketplace?.pluginNames.includes(selected.pluginName) ||
    !validPluginName(selected.pluginName) ||
    selected.token !== codexPluginToken(selected)
  )
    throw new Error("invalid Codex explicit skill invocation");
}

function codexRepositorySkillPath(skillName: string): string {
  return `.agents/skills/${skillName}/SKILL.md`;
}

function codexPluginToken(invocation: PluginSkillInvocation): string {
  return `$${invocation.pluginName}:${invocation.skillName}`;
}
function codexRepositoryToken(skillName: string): string {
  return `$${skillName}`;
}
