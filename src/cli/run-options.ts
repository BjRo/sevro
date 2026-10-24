import { parseArgs } from "node:util";

type RunOption = {
  type: "string" | "boolean";
  kind: "string" | "boolean" | "number" | "path" | "path-list";
  multiple?: boolean;
  cliOnly?: boolean;
  private?: boolean;
  extension?: boolean;
  route?: "codex" | "claude";
  section:
    | "required"
    | "common"
    | "native"
    | "extension"
    | "grading"
    | "provenance"
    | "deprecated";
  help: string;
};

/** Parsing, saved-setting semantics, protection and help share one inventory. */
export const RUN_OPTIONS = {
  json: {
    type: "boolean",
    kind: "boolean",
    cliOnly: true,
    section: "common",
    help: "One versioned JSON result on stdout (default: false); human diagnostics go to stderr.",
  },
  "run-manifest-file": {
    type: "string",
    kind: "path",
    cliOnly: true,
    private: true,
    section: "common",
    help: "<path>  Saved sevro.run.v1 settings; explicit flags override them.",
  },
  "retain-host-diagnostics": {
    type: "boolean",
    kind: "boolean",
    section: "common",
    help: "Retain private native diagnostics (default: false).",
  },
  dry: {
    type: "boolean",
    kind: "boolean",
    section: "common",
    help: "Prepare only (default: false).",
  },
  "case-file": {
    type: "string",
    kind: "path",
    private: true,
    section: "required",
    help: "<path>  Select exactly one of --case-file or --extension-command-file.",
  },
  "case-id": {
    type: "string",
    kind: "string",
    extension: true,
    section: "extension",
    help: "<id>  Required with --extension-command-file.",
  },
  "extension-command-file": {
    type: "string",
    kind: "path",
    extension: true,
    private: true,
    section: "required",
    help: "<path>  Select one extension case instead of --case-file.",
  },
  "extension-source-file": {
    type: "string",
    kind: "path-list",
    multiple: true,
    extension: true,
    private: true,
    section: "extension",
    help: "<path>  Required source closure; repeatable.",
  },
  "extension-configuration-file": {
    type: "string",
    kind: "path",
    extension: true,
    private: true,
    section: "extension",
    help: "<path>  Private JSON object; supply with --extension-redacted-configuration-file.",
  },
  "extension-redacted-configuration-file": {
    type: "string",
    kind: "path",
    extension: true,
    private: true,
    section: "extension",
    help: "<path>  Redacted retained configuration; supply with --extension-configuration-file.",
  },
  "task-verdict-policy": {
    type: "string",
    kind: "string",
    extension: true,
    section: "extension",
    help: "<id>  Select an advertised namespaced extension policy.",
  },
  "replace-builtin-grader": {
    type: "string",
    kind: "string",
    multiple: true,
    extension: true,
    section: "extension",
    help: "<id>  Explicit replacement; repeatable.",
  },
  "case-source-root": {
    type: "string",
    kind: "path",
    private: true,
    section: "extension",
    help: "<path>  Supply with --case-source-map-file for mapped sources.",
  },
  "case-source-map-file": {
    type: "string",
    kind: "path",
    private: true,
    section: "extension",
    help: "<path>  Supply with --case-source-root for mapped sources.",
  },
  "adapter-module": {
    type: "string",
    kind: "path",
    section: "required",
    help: "<path>  Select exactly one of --adapter-module or --host <codex|claude>.",
  },
  "semantic-adapter-module": {
    type: "string",
    kind: "path",
    private: true,
    section: "grading",
    help: "<path>  Select this or --semantic-host codex.",
  },
  "semantic-host": {
    type: "string",
    kind: "string",
    section: "grading",
    help: "<codex>  Native semantic route; none selected by default.",
  },
  "semantic-model": {
    type: "string",
    kind: "string",
    section: "grading",
    help: "<name>  Required for native semantic route.",
  },
  "semantic-effort": {
    type: "string",
    kind: "string",
    section: "grading",
    help: "<level>  Required for native semantic route.",
  },
  "advisory-adapter-module": {
    type: "string",
    kind: "path",
    private: true,
    section: "grading",
    help: "<path>  Select this or --advisory-host codex.",
  },
  "advisory-host": {
    type: "string",
    kind: "string",
    section: "grading",
    help: "<codex>  Native advisory route; none selected by default.",
  },
  "advisory-model": {
    type: "string",
    kind: "string",
    section: "grading",
    help: "<name>  Required for native advisory route.",
  },
  "advisory-effort": {
    type: "string",
    kind: "string",
    section: "grading",
    help: "<level>  Required for native advisory route.",
  },
  "advisory-exclude": {
    type: "string",
    kind: "string",
    multiple: true,
    section: "grading",
    help: "<relative-path>  Exclude an evaluator path; repeatable.",
  },
  host: {
    type: "string",
    kind: "string",
    section: "required",
    help: "<codex|claude>  Bundled candidate route instead of --adapter-module.",
  },
  "codex-bin": {
    type: "string",
    kind: "path",
    route: "codex",
    section: "native",
    help: "<path> (default: codex on PATH)  Explicit binary override.",
  },
  "codex-entrypoint": {
    type: "string",
    kind: "string",
    section: "native",
    help: "<exec|app-server>  Candidate transport (default: exec).",
  },
  "codex-timeout-ms": {
    type: "string",
    kind: "number",
    route: "codex",
    section: "native",
    help: "<integer>  1..1800000 milliseconds (default: 600000).",
  },
  "codex-auth-file": {
    type: "string",
    kind: "path",
    private: true,
    route: "codex",
    section: "native",
    help: "<path>  Required for every Codex route.",
  },
  "claude-bin": {
    type: "string",
    kind: "path",
    route: "claude",
    section: "native",
    help: "<path> (default: claude on PATH)  Explicit binary override.",
  },
  "claude-credential-file": {
    type: "string",
    kind: "path",
    private: true,
    route: "claude",
    section: "native",
    help: "<path>  Optional credential override; otherwise use native auth.",
  },
  "claude-uv-cache-dir": {
    type: "string",
    kind: "path",
    route: "claude",
    section: "deprecated",
    help: "<path>  Migrate to sevro.json; cannot be combined with a runtime policy.",
  },
  "claude-project-settings": {
    type: "boolean",
    kind: "boolean",
    route: "claude",
    section: "native",
    help: "Allow fixture project settings (default: false).",
  },
  "toolchain-bin-dir": {
    type: "string",
    kind: "path",
    section: "deprecated",
    help: "<path>  Migrate to sevro.json; cannot be combined with a runtime policy.",
  },
  model: {
    type: "string",
    kind: "string",
    section: "native",
    help: "<name>  Required for a bundled candidate host.",
  },
  effort: {
    type: "string",
    kind: "string",
    section: "native",
    help: "<level>  Required for a bundled candidate host.",
  },
  "shell-isolation": {
    type: "boolean",
    kind: "boolean",
    section: "common",
    help: "Isolate shell checks (default: false).",
  },
  "protected-root": {
    type: "string",
    kind: "path-list",
    multiple: true,
    section: "common",
    help: "<path>  Extra protected source/private root; repeatable.",
  },
  "project-root": {
    type: "string",
    kind: "path",
    section: "common",
    help: "<path> (default: current directory)  Project identity; does not copy its files into the fixture.",
  },
  "config-root": {
    type: "string",
    kind: "path",
    section: "common",
    help: "<path> (default: --project-root)  Native concurrency configuration.",
  },
  "runtime-config-file": {
    type: "string",
    kind: "path",
    private: true,
    section: "common",
    help: "<path>  Runtime policy; otherwise discover project sevro.json.",
  },
  "results-root": {
    type: "string",
    kind: "path",
    section: "common",
    help: "<path> (default: <project-root>/.sevro/results)  Retained evidence.",
  },
  "run-state-root": {
    type: "string",
    kind: "path",
    section: "common",
    help: "<path> (default: --results-root)  Active records/checkpoints.",
  },
  "runner-build-digest": {
    type: "string",
    kind: "string",
    section: "provenance",
    help: "<sha256>  64 lowercase hex characters; normally derived automatically.",
  },
  "runner-checkout-root": {
    type: "string",
    kind: "path",
    section: "provenance",
    help: "<path>  Record the running checkout's revision/dirty digest.",
  },
  "project-digest": {
    type: "string",
    kind: "string",
    section: "provenance",
    help: "<sha256>  64 lowercase hex characters; normally derived automatically.",
  },
  condition: {
    type: "string",
    kind: "string",
    section: "common",
    help: "<passive|enforced> (default: passive)  Bundled hosts use passive.",
  },
  trials: {
    type: "string",
    kind: "number",
    section: "common",
    help: "<integer> (default: 1)  Positive number of trials.",
  },
  jobs: {
    type: "string",
    kind: "number",
    section: "common",
    help: "<integer> (default: 3)  Maximum parallel trials, positive integer.",
  },
  threshold: {
    type: "string",
    kind: "number",
    section: "common",
    help: "<number> (default: 1)  All assessed trials must pass; range (0, 1].",
  },
} as const satisfies Record<string, RunOption>;

export type RunOptionName = keyof typeof RUN_OPTIONS;

type MatchingOptions<K extends keyof RunOption, V> = {
  [N in RunOptionName]: (typeof RUN_OPTIONS)[N] extends Record<K, V>
    ? N
    : never;
}[RunOptionName];

export function optionsWith<
  K extends keyof RunOption,
  const V extends RunOption[K],
>(key: K, value: V): MatchingOptions<K, V>[] {
  return (Object.keys(RUN_OPTIONS) as RunOptionName[]).filter(
    (name) => (RUN_OPTIONS[name] as RunOption)[key] === value,
  ) as MatchingOptions<K, V>[];
}

export const PATH_OPTIONS = optionsWith("kind", "path");
export const PATH_LIST_OPTIONS = optionsWith("kind", "path-list");
export const NUMBER_OPTIONS = new Set<string>(optionsWith("kind", "number"));
export const LIST_OPTIONS = new Set<string>(optionsWith("multiple", true));
export const CLI_ONLY = new Set<string>(optionsWith("cliOnly", true));
export const EXTENSION_OPTIONS = optionsWith("extension", true);

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
