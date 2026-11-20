import { containsControl } from "../kernel/index";

/** A named candidate-home directory retained as an evaluation artifact. */
export interface RuntimeArtifactDirectory {
  name: string;
  path: string;
}

/** Names the candidate Codex state binds itself when `codexState` is enabled. */
const CODEX_STATE_ARTIFACT_NAMES = [
  "codex_config",
  "codex_skills",
  "agent_skills",
  "command_agent_skills",
  "command_codex_skills",
];

/** These are relative candidate-home paths, never operator filesystem grants. */
export function requireArtifactDirectories(
  directories: RuntimeArtifactDirectory[],
): void {
  if (!Array.isArray(directories) || directories.length > 16)
    throw new Error("runtime artifact directories exceed the limit");
  const names = new Set<string>();
  for (const directory of directories) {
    requireArtifactDirectory(directory);
    if (names.has(directory.name))
      throw new Error("runtime artifact directory names overlap");
    names.add(directory.name);
  }
}

function requireArtifactDirectory(directory: RuntimeArtifactDirectory): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(directory.name))
    throw new Error("runtime artifact directory name is invalid");
  if (CODEX_STATE_ARTIFACT_NAMES.includes(directory.name))
    throw new Error(
      "runtime artifact directory name is reserved for Codex state",
    );
  const path = directory.path;
  if (!validArtifactPath(path))
    throw new Error("runtime artifact directory path is invalid");
  if (path.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error(
      "runtime artifact directory must be a bounded relative path",
    );
}

function validArtifactPath(path: string): boolean {
  if (typeof path !== "string" || path.length > 4096 || path.includes("\\"))
    return false;
  return !containsControl(path);
}
