import type { RunValues } from "./run-options";

type Key = keyof RunValues;

function removeSaved(saved: RunValues, keys: readonly Key[]): void {
  for (const key of keys) Reflect.deleteProperty(saved, key);
}

const EXTENSION_OPTIONS = [
  "extension-command-file",
  "case-id",
  "extension-source-file",
  "extension-configuration-file",
  "extension-redacted-configuration-file",
  "task-verdict-policy",
  "replace-builtin-grader",
] as const;
const CANDIDATE_OPTIONS = [
  "host",
  "model",
  "effort",
  "codex-entrypoint",
] as const;

function overrideCandidate(saved: RunValues, explicit: RunValues): void {
  if (explicit["adapter-module"] !== undefined)
    removeSaved(saved, CANDIDATE_OPTIONS);
  if (explicit.host === undefined) return;
  delete saved["adapter-module"];
  if (saved.host !== explicit.host)
    removeSaved(saved, ["model", "effort", "codex-entrypoint"]);
}

function overrideSecondary(
  saved: RunValues,
  explicit: RunValues,
  role: "semantic" | "advisory",
): void {
  if (explicit[`${role}-host`] !== undefined)
    Reflect.deleteProperty(saved, `${role}-adapter-module`);
  if (explicit[`${role}-adapter-module`] !== undefined)
    removeSaved(saved, [`${role}-host`, `${role}-model`, `${role}-effort`]);
}

function removeUnusedNativeOptions(saved: RunValues, merged: RunValues): void {
  if (
    ![merged.host, merged["semantic-host"], merged["advisory-host"]].includes(
      "codex",
    )
  )
    removeSaved(saved, ["codex-bin", "codex-auth-file", "codex-timeout-ms"]);
  if (merged.host !== "claude")
    removeSaved(saved, [
      "claude-bin",
      "claude-credential-file",
      "claude-uv-cache-dir",
      "claude-project-settings",
    ]);
}

export function overrideRunSelections(
  saved: RunValues,
  explicit: RunValues,
): void {
  if (explicit["case-file"] !== undefined)
    removeSaved(saved, EXTENSION_OPTIONS);
  if (explicit["extension-command-file"] !== undefined)
    delete saved["case-file"];
  overrideCandidate(saved, explicit);
  overrideSecondary(saved, explicit, "semantic");
  overrideSecondary(saved, explicit, "advisory");
  if (
    [
      "host",
      "adapter-module",
      "semantic-host",
      "semantic-adapter-module",
      "advisory-host",
      "advisory-adapter-module",
    ].some((key) => explicit[key as Key] !== undefined)
  )
    removeUnusedNativeOptions(saved, { ...saved, ...explicit });
}
