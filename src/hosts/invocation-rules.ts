import type { Stats } from "node:fs";
import {
  EvaluationConfigurationError,
  type HostAdapter,
  type ResolvedCase,
} from "../host-contract/index";
import type { PreparationResult } from "../extensions/index";
import type { InlineArtifact } from "../fixtures/index";

export interface InvocationPreparation {
  case: Pick<ResolvedCase, "prompt" | "followUpPrompt">;
  hostCapabilities?: readonly string[];
  negotiatedCapabilities?: readonly string[];
  extensionPreparation: PreparationResult | null;
  inlineArtifacts: InlineArtifact[];
}
export type InvocationRequest = Pick<
  Parameters<HostAdapter["run"]>[0],
  "codexMarketplace" | "claudePluginDirs" | "explicitSkillInvocation"
>;
export type PackageConfiguration = Pick<
  PreparationResult,
  "codexMarketplace" | "claudePluginDirs"
>;
export type InvocationConfiguration = Pick<
  PreparationResult,
  | "codexSkillInvocation"
  | "codexRepositorySkillInvocation"
  | "claudeSkillInvocation"
  | "claudeRepositorySkillInvocation"
>;
export interface InvocationDeclaration {
  configuration: InvocationConfiguration;
  resolve: () => NonNullable<InvocationRequest["explicitSkillInvocation"]>;
}
export interface PreparedInvocation {
  readonly packageConfiguration: PackageConfiguration;
  readonly configuration: InvocationConfiguration;
  readonly hostRequest: InvocationRequest;
  readonly invocationToken: string | null;
}
export interface PreparedInvocationPackage {
  configuration: PackageConfiguration;
  hostRequest: InvocationRequest;
}
export const INVOCATION_PLACEHOLDER = "{{sevro.skill_invocation}}";
export const LEGACY_CODEX_PLACEHOLDER = "{{sevro.codex.skill_invocation}}";

export function requireNegotiatedCapability(
  input: InvocationPreparation,
  capability: string,
  message: string,
): void {
  if (
    !input.negotiatedCapabilities?.includes(capability) ||
    !input.hostCapabilities?.includes(capability)
  )
    throw new EvaluationConfigurationError(message);
}
export function validatePackageManifest(
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

export function invocationTokenCount(
  caseData: InvocationPreparation["case"],
  placeholder: string,
): number {
  return (
    caseData.prompt.split(placeholder).length -
    1 +
    (caseData.followUpPrompt?.split(placeholder).length ?? 1) -
    1
  );
}

export function invocationPlaceholderCount(
  input: InvocationPreparation,
): number {
  return (
    invocationTokenCount(input.case, INVOCATION_PLACEHOLDER) +
    invocationTokenCount(input.case, LEGACY_CODEX_PLACEHOLDER)
  );
}

export function validPluginName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}
export function validSkillName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name);
}
export function validRepositorySkillName(name: string): boolean {
  return validSkillName(name) && ![".", ".."].includes(name);
}
export function validRepositoryInvocationIdentity(
  skillName: string,
  placeholders: number,
): boolean {
  return validRepositorySkillName(skillName) && placeholders === 1;
}
export function validateRepositoryInvocationBody(
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
export function pluginSkillPath(root: string, skillName: string): string {
  return `${root}/skills/${skillName}/SKILL.md`;
}

export function validInvocationSkillIdentity(
  skillName: string,
  occurrences: number,
): boolean {
  return validSkillName(skillName) && occurrences === 1;
}
export function safeRepositorySkillEntry(
  entry: Stats | null,
  index: number,
): boolean {
  if (!entry || entry.isSymbolicLink()) return false;
  return index === 3
    ? entry.isFile() && entry.size <= 1024 * 1024
    : entry.isDirectory();
}
