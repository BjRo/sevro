import { parseArgs } from "node:util";

export const RUN_OPTIONS = {
  json: { type: "boolean" },
  "run-manifest-file": { type: "string" },
  "retain-host-diagnostics": { type: "boolean" },
  dry: { type: "boolean" },
  "case-file": { type: "string" },
  "case-id": { type: "string" },
  "extension-command-file": { type: "string" },
  "extension-source-file": { type: "string", multiple: true },
  "extension-configuration-file": { type: "string" },
  "extension-redacted-configuration-file": { type: "string" },
  "task-verdict-policy": { type: "string" },
  "replace-builtin-grader": { type: "string", multiple: true },
  "case-source-root": { type: "string" },
  "case-source-map-file": { type: "string" },
  "adapter-module": { type: "string" },
  "semantic-adapter-module": { type: "string" },
  "semantic-host": { type: "string" },
  "semantic-model": { type: "string" },
  "semantic-effort": { type: "string" },
  "advisory-adapter-module": { type: "string" },
  "advisory-host": { type: "string" },
  "advisory-model": { type: "string" },
  "advisory-effort": { type: "string" },
  "advisory-exclude": { type: "string", multiple: true },
  host: { type: "string" },
  "codex-bin": { type: "string" },
  "codex-entrypoint": { type: "string" },
  "codex-timeout-ms": { type: "string" },
  "codex-auth-file": { type: "string" },
  "claude-bin": { type: "string" },
  "claude-credential-file": { type: "string" },
  "claude-uv-cache-dir": { type: "string" },
  "claude-project-settings": { type: "boolean" },
  "toolchain-bin-dir": { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  "shell-isolation": { type: "boolean" },
  "protected-root": { type: "string", multiple: true },
  "project-root": { type: "string" },
  "config-root": { type: "string" },
  "runtime-config-file": { type: "string" },
  "results-root": { type: "string" },
  "run-state-root": { type: "string" },
  "runner-build-digest": { type: "string" },
  "runner-checkout-root": { type: "string" },
  "project-digest": { type: "string" },
  condition: { type: "string" },
  trials: { type: "string" },
  jobs: { type: "string" },
  threshold: { type: "string" },
} as const;

export const PATH_OPTIONS = [
  "run-manifest-file",
  "case-file",
  "extension-command-file",
  "extension-configuration-file",
  "extension-redacted-configuration-file",
  "case-source-root",
  "case-source-map-file",
  "adapter-module",
  "semantic-adapter-module",
  "advisory-adapter-module",
  "codex-bin",
  "codex-auth-file",
  "claude-bin",
  "claude-credential-file",
  "claude-uv-cache-dir",
  "toolchain-bin-dir",
  "project-root",
  "config-root",
  "runtime-config-file",
  "results-root",
  "run-state-root",
  "runner-checkout-root",
] as const;

export function runArguments(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    options: RUN_OPTIONS,
  });
}

export type RunValues = ReturnType<typeof runArguments>["values"];

/** Preserve the last explicit output selection even when parsing fails. */
export function jsonOutputRequested(argv: string[]): boolean {
  let json = false;
  for (const argument of argv) {
    if (argument === "--json") json = true;
    if (argument === "--no-json") json = false;
  }
  return json;
}
