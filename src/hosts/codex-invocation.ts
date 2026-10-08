import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { HostAdapter } from "../engine";
type Request = Parameters<HostAdapter["run"]>[0];
type Invocation = NonNullable<Request["explicitSkillInvocation"]>;

function invocationTokenCount(request: Request, token: string): number {
  return (
    request.prompt.split(token).length -
    1 +
    (request.followUpPrompt?.split(token).length ?? 1) -
    1
  );
}
function validSkillName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && ![".", ".."].includes(name);
}
export async function verifyCodexInvocation(request: Request): Promise<void> {
  const selected = request.explicitSkillInvocation;
  if (!selected) return;
  if (
    !validSkillName(selected.skillName) ||
    invocationTokenCount(request, selected.token) !== 1
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
  if (selected.token !== `$${selected.skillName}`)
    throw new Error("invalid Codex explicit skill invocation");
  let path = request.workspace;
  for (const [index, part] of [
    ".agents",
    "skills",
    selected.skillName,
    "SKILL.md",
  ].entries()) {
    path = join(path, part);
    const entry = await lstat(path).catch(() => null);
    if (!safeRepositoryEntry(entry, index))
      throw new Error(
        "invoked Codex repository skill is unavailable or unsafe",
      );
  }
}
function safeRepositoryEntry(entry: Stats | null, index: number): boolean {
  if (!entry || entry.isSymbolicLink()) return false;
  return index === 3
    ? entry.isFile() && entry.size <= 1024 * 1024
    : entry.isDirectory();
}
function requirePluginInvocation(
  request: Request,
  selected: Invocation & { scope?: "plugin" },
): void {
  if (
    !request.codexMarketplace?.pluginNames.includes(selected.pluginName) ||
    !/^[a-z][a-z0-9-]*$/.test(selected.pluginName) ||
    selected.token !== `$${selected.pluginName}:${selected.skillName}`
  )
    throw new Error("invalid Codex explicit skill invocation");
}
