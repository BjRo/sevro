import { join } from "node:path";
import { prepareFixtureTools, installFixtureTools } from "./fixture-tools";

/** Bound hook declarations and keep every name inside Git's hooks directory. */
export function prepareGitHooks(value: unknown): Record<string, string> | null {
  return prepareFixtureTools(
    value,
    /^[a-z][a-z0-9-]*$/,
    32,
    "invalid fixture hooks",
  );
}

/** Install executable hooks only after fixture commits and overlays are ready. */
export async function installGitHooks(
  hooks: Record<string, string> | undefined,
  workspace: string,
): Promise<void> {
  if (!hooks) return;
  await installFixtureTools(hooks, join(workspace, ".git", "hooks"), {
    directory: "fixture Git hooks directory is invalid",
    target: "fixture Git hook target is invalid",
  });
}
