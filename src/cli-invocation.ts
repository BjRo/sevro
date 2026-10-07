import { parseArgs } from "node:util";
import { isAbsolute } from "node:path";

export class InvocationError extends Error {}

function requiredOption(value: string | undefined, name: string): string {
  if (!value) throw new InvocationError(`missing ${name}`);
  return value;
}

function absoluteOption(value: string | undefined, name: string): string {
  const path = requiredOption(value, name);
  if (!isAbsolute(path)) throw new InvocationError(`${name} must be absolute`);
  return path;
}

function optionalAbsolute(
  value: string | undefined,
  name: string,
): string | undefined {
  return value ? absoluteOption(value, name) : undefined;
}

function optionalDigest(value: string | undefined, name: string) {
  if (value !== undefined && !/^[a-f0-9]{64}$/.test(value))
    throw new InvocationError(`${name} must be a 64-character SHA-256 digest`);
  return value;
}

function conditionOption(value: string | undefined): "passive" | "enforced" {
  const condition = requiredOption(value, "--condition");
  if (condition !== "passive" && condition !== "enforced")
    throw new InvocationError("invalid --condition");
  return condition;
}

const RUN_OPTIONS = {
  json: { type: "boolean" },
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
  "results-root": { type: "string" },
  "run-state-root": { type: "string" },
  "runner-build-digest": { type: "string" },
  "runner-checkout-root": { type: "string" },
  "project-digest": { type: "string" },
  condition: { type: "string" },
  trials: { type: "string" },
  jobs: { type: "string", default: "3" },
  threshold: { type: "string" },
} as const;

function cliArguments(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: RUN_OPTIONS,
    });
  } catch (cause) {
    throw new InvocationError("invalid CLI arguments", { cause });
  }
}

type Values = ReturnType<typeof cliArguments>["values"];

function trialParameters(values: Values) {
  const condition = conditionOption(values.condition);
  const trialCount = Number(requiredOption(values.trials, "--trials"));
  const jobs = Number(requiredOption(values.jobs, "--jobs"));
  const passThreshold = Number(requiredOption(values.threshold, "--threshold"));
  positiveInteger(trialCount, "--trials");
  positiveInteger(jobs, "--jobs");
  if (
    !Number.isFinite(passThreshold) ||
    passThreshold <= 0 ||
    passThreshold > 1
  )
    throw new InvocationError("invalid --threshold");
  return { condition, trialCount, jobs, passThreshold };
}

function positiveInteger(value: number, option: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new InvocationError(`invalid ${option}`);
}

function hostRoutes(values: Values) {
  const codex = values.host === "codex";
  const claude = values.host === "claude";
  return {
    codex,
    claude,
    builtinHost: codex || claude,
    semanticCodex: values["semantic-host"] === "codex",
    advisoryCodex: values["advisory-host"] === "codex",
  };
}

type Routes = ReturnType<typeof hostRoutes>;
type CompatibilityRule = {
  invalid: (values: Values, routes: Routes, roots: string[]) => unknown;
  message: string;
};
const HOST_COMPATIBILITY: CompatibilityRule[] = [
  {
    invalid: (v, r) =>
      v["codex-entrypoint"] !== undefined &&
      (!r.codex || !["exec", "app-server"].includes(v["codex-entrypoint"])),
    message: "--codex-entrypoint requires --host codex and exec or app-server",
  },
  {
    invalid: (v, r) => v.host && !r.builtinHost,
    message: "unsupported --host",
  },
  {
    invalid: (v, r) => v["semantic-host"] && !r.semanticCodex,
    message: "unsupported --semantic-host",
  },
  {
    invalid: (v, r) => v["advisory-host"] && !r.advisoryCodex,
    message: "unsupported --advisory-host",
  },
  {
    invalid: (v, r) => r.semanticCodex && v["semantic-adapter-module"],
    message: "--semantic-host and --semantic-adapter-module are exclusive",
  },
  {
    invalid: (v, r) => r.advisoryCodex && v["advisory-adapter-module"],
    message: "--advisory-host and --advisory-adapter-module are exclusive",
  },
  {
    invalid: (v, r) => r.builtinHost && v["adapter-module"],
    message: "--host and --adapter-module are exclusive",
  },
  {
    invalid: (v, r) => !r.builtinHost && !v["adapter-module"],
    message: "missing --adapter-module or --host",
  },
  {
    invalid: (v, r) => !r.builtinHost && (v.model || v.effort),
    message: "--model and --effort require a built-in host",
  },
  {
    invalid: (v, r) =>
      !r.semanticCodex && (v["semantic-model"] || v["semantic-effort"]),
    message: "semantic model options require --semantic-host codex",
  },
  {
    invalid: (v, r) =>
      !r.advisoryCodex && (v["advisory-model"] || v["advisory-effort"]),
    message: "advisory model options require --advisory-host codex",
  },
  {
    invalid: (v, r) =>
      v["advisory-exclude"]?.length &&
      !r.advisoryCodex &&
      !v["advisory-adapter-module"],
    message: "--advisory-exclude requires an advisory route",
  },
  {
    invalid: (v, r) =>
      !r.codex &&
      !r.semanticCodex &&
      !r.advisoryCodex &&
      (v["codex-bin"] || v["codex-auth-file"]),
    message: "Codex options require a Codex host route",
  },
  {
    invalid: (v, r) =>
      !r.claude &&
      (v["claude-bin"] ||
        v["claude-credential-file"] ||
        v["claude-uv-cache-dir"] ||
        v["claude-project-settings"]),
    message: "Claude options require --host claude",
  },
  {
    invalid: (v, r, roots) =>
      roots.length &&
      !v["shell-isolation"] &&
      !r.builtinHost &&
      !r.semanticCodex &&
      !r.advisoryCodex,
    message: "--protected-root requires isolation",
  },
];

function validateHostCompatibility(
  values: Values,
  routes: Routes,
  roots: string[],
): void {
  for (const rule of HOST_COMPATIBILITY)
    if (rule.invalid(values, routes, roots))
      throw new InvocationError(rule.message);
}

function rootParameters(values: Values) {
  const projectRoot = absoluteOption(values["project-root"], "--project-root");
  const configRoot =
    values["config-root"] !== undefined
      ? absoluteOption(values["config-root"], "--config-root")
      : projectRoot;
  const resultsRoot = absoluteOption(values["results-root"], "--results-root");
  const runStateRoot = values["run-state-root"]
    ? absoluteOption(values["run-state-root"], "--run-state-root")
    : resultsRoot;
  return { projectRoot, configRoot, resultsRoot, runStateRoot };
}

type Roots = ReturnType<typeof rootParameters>;

function validQualifiedId(id: string): boolean {
  return /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(id);
}

function validateExtensionSelection(values: Values): void {
  const policy = values["task-verdict-policy"];
  if (policy !== undefined && !validQualifiedId(policy))
    throw new InvocationError("invalid --task-verdict-policy");
  const replacements = values["replace-builtin-grader"] ?? [];
  validateReplacements(replacements);
  if (
    Boolean(values["case-file"]) === Boolean(values["extension-command-file"])
  )
    throw new InvocationError(
      "select exactly one of --case-file or --extension-command-file",
    );
  validateExtensionArguments(values);
  validatePairedFiles(values);
}

function validateReplacements(replacements: string[]): void {
  if (
    new Set(replacements).size !== replacements.length ||
    replacements.some((id) => !validQualifiedId(id))
  )
    throw new InvocationError("invalid --replace-builtin-grader");
}

function hasExtensionArguments(values: Values): boolean {
  return (
    [
      values["case-id"],
      values["extension-source-file"],
      values["extension-configuration-file"],
      values["extension-redacted-configuration-file"],
    ].some(Boolean) ||
    values["task-verdict-policy"] !== undefined ||
    (values["replace-builtin-grader"] ?? []).length > 0
  );
}

function extensionSources(values: Values): string[] {
  const sources = values["extension-source-file"];
  if (!sources?.length)
    throw new InvocationError("missing --extension-source-file");
  if (sources.some((path) => !isAbsolute(path)))
    throw new InvocationError("--extension-source-file must be absolute");
  return sources;
}

function validateExtensionArguments(values: Values): void {
  if (values["extension-command-file"]) {
    requiredOption(values["case-id"], "--case-id");
    extensionSources(values);
  } else if (hasExtensionArguments(values))
    throw new InvocationError(
      "extension options require --extension-command-file",
    );
}

function validatePairedFiles(values: Values): void {
  if (
    Boolean(values["extension-configuration-file"]) !==
    Boolean(values["extension-redacted-configuration-file"])
  )
    throw new InvocationError(
      "extension configuration requires a redacted file",
    );
  if (
    Boolean(values["case-source-root"]) !==
    Boolean(values["case-source-map-file"])
  )
    throw new InvocationError("case sources require a root and map file");
}

function privateRootDeclarations(
  values: Values,
  configRoot: string,
  protectedRoots: string[],
): string[] {
  return [
    configRoot,
    ...protectedRoots,
    values["claude-credential-file"],
    values["case-file"],
    values["extension-command-file"],
    ...(values["extension-source-file"] ?? []),
    values["extension-configuration-file"],
    values["extension-redacted-configuration-file"],
    values["case-source-root"],
    values["case-source-map-file"],
    values["semantic-adapter-module"],
    values["advisory-adapter-module"],
  ].filter((value): value is string => Boolean(value));
}

function commonCodexOptions(
  values: Values,
  routes: Routes,
  roots: Roots,
  privateRoots: string[],
) {
  if (![routes.codex, routes.semanticCodex, routes.advisoryCodex].some(Boolean))
    return undefined;
  return {
    binary: absoluteOption(values["codex-bin"], "--codex-bin"),
    authFile: absoluteOption(values["codex-auth-file"], "--codex-auth-file"),
    projectRoot: roots.projectRoot,
    resultsRoot: roots.resultsRoot,
    additionalProtectedRoots: [...privateRoots, roots.runStateRoot],
  };
}

function claudeHostOptions(
  values: Values,
  routes: Routes,
  roots: Roots,
  privateRoots: string[],
  toolchainBinDir: string | undefined,
) {
  if (!routes.claude) return undefined;
  return {
    binary: absoluteOption(values["claude-bin"], "--claude-bin"),
    ...(values["claude-credential-file"]
      ? {
          credentialFile: absoluteOption(
            values["claude-credential-file"],
            "--claude-credential-file",
          ),
        }
      : {}),
    ...(values["claude-uv-cache-dir"]
      ? {
          uvCacheDir: absoluteOption(
            values["claude-uv-cache-dir"],
            "--claude-uv-cache-dir",
          ),
        }
      : {}),
    model: requiredOption(values.model, "--model"),
    effort: requiredOption(values.effort, "--effort"),
    toolchainBinDir,
    projectSettings: values["claude-project-settings"] ?? false,
    projectRoot: roots.projectRoot,
    resultsRoot: roots.resultsRoot,
    additionalProtectedRoots: [...privateRoots, roots.runStateRoot],
  };
}

function extensionInvocation(values: Values) {
  const command = values["extension-command-file"];
  if (!command) return undefined;
  return {
    commandFile: absoluteOption(command, "--extension-command-file"),
    sourceFiles: extensionSources(values),
    caseId: requiredOption(values["case-id"], "--case-id"),
    configurationFile: optionalAbsolute(
      values["extension-configuration-file"],
      "--extension-configuration-file",
    ),
    redactedConfigurationFile: optionalAbsolute(
      values["extension-redacted-configuration-file"],
      "--extension-redacted-configuration-file",
    ),
    taskVerdictPolicy: values["task-verdict-policy"],
    replaceBuiltinGraders: values["replace-builtin-grader"] ?? [],
  };
}

const CODEX_MODEL_KEYS = {
  candidate: ["model", "effort"],
  semantic: ["semantic-model", "semantic-effort"],
  advisory: ["advisory-model", "advisory-effort"],
} as const;

function codexRoleOptions(
  values: Values,
  common: ReturnType<typeof commonCodexOptions>,
  enabled: boolean,
  role: keyof typeof CODEX_MODEL_KEYS,
) {
  if (!enabled) return undefined;
  if (!common)
    throw new InvocationError("Codex options require a Codex host route");
  const [modelKey, effortKey] = CODEX_MODEL_KEYS[role];
  return {
    ...(role === "candidate"
      ? { entrypoint: codexEntrypoint(values["codex-entrypoint"]) }
      : {}),
    ...common,
    model: requiredOption(values[modelKey], `--${modelKey}`),
    effort: requiredOption(values[effortKey], `--${effortKey}`),
  };
}

function codexEntrypoint(
  value: string | undefined,
): "exec" | "app-server" | undefined {
  if (value === undefined) return undefined;
  if (value !== "exec" && value !== "app-server")
    throw new InvocationError(
      "--codex-entrypoint requires --host codex and exec or app-server",
    );
  return value;
}

function invocationInputs(
  values: Values,
  context: ReturnType<typeof invocationContext>,
) {
  const {
    routes,
    roots,
    privateRoots,
    toolchainBinDir,
    codexCommon,
    claudeOptions,
    trials,
  } = context;
  return {
    json: values.json ?? false,
    dry: values.dry ?? false,
    caseFile: optionalAbsolute(values["case-file"], "--case-file"),
    extension: extensionInvocation(values),
    caseSourceRoot: optionalAbsolute(
      values["case-source-root"],
      "--case-source-root",
    ),
    caseSourceMapFile: optionalAbsolute(
      values["case-source-map-file"],
      "--case-source-map-file",
    ),
    adapterModule: routes.builtinHost
      ? undefined
      : absoluteOption(values["adapter-module"], "--adapter-module"),
    semanticAdapterModule: optionalAbsolute(
      values["semantic-adapter-module"],
      "--semantic-adapter-module",
    ),
    semanticCodex: codexRoleOptions(
      values,
      codexCommon,
      routes.semanticCodex,
      "semantic",
    ),
    advisoryAdapterModule: optionalAbsolute(
      values["advisory-adapter-module"],
      "--advisory-adapter-module",
    ),
    advisoryCodex: codexRoleOptions(
      values,
      codexCommon,
      routes.advisoryCodex,
      "advisory",
    ),
    advisoryExcludedPaths: values["advisory-exclude"] ?? [],
    codex: codexRoleOptions(values, codexCommon, routes.codex, "candidate"),
    claude: claudeOptions,
    shellIsolation: shellIsolationOptions(
      values,
      privateRoots,
      toolchainBinDir,
    ),
    ...roots,
    runnerBuildDigest: optionalDigest(
      values["runner-build-digest"],
      "--runner-build-digest",
    ),
    runnerCheckoutRoot: optionalAbsolute(
      values["runner-checkout-root"],
      "--runner-checkout-root",
    ),
    projectDigest: optionalDigest(values["project-digest"], "--project-digest"),
    ...trials,
  };
}

function shellIsolationOptions(
  values: Values,
  protectedRoots: string[],
  toolchainBinDir: string | undefined,
) {
  return values["shell-isolation"]
    ? {
        protectedRoots,
        toolchainBinDir,
        uvRuntimeCache: !!values["claude-uv-cache-dir"],
      }
    : undefined;
}

function invocationContext(values: Values) {
  const trials = trialParameters(values);
  const protectedRoots = values["protected-root"] ?? [];
  if (protectedRoots.some((path) => !isAbsolute(path)))
    throw new InvocationError("--protected-root must be absolute");
  const toolchainBinDir = optionalAbsolute(
    values["toolchain-bin-dir"],
    "--toolchain-bin-dir",
  );
  const routes = hostRoutes(values);
  validateHostCompatibility(values, routes, protectedRoots);
  const roots = rootParameters(values);
  validateExtensionSelection(values);
  const privateRoots = privateRootDeclarations(
    values,
    roots.configRoot,
    protectedRoots,
  );
  const codexCommon = commonCodexOptions(values, routes, roots, privateRoots);
  const claudeOptions = claudeHostOptions(
    values,
    routes,
    roots,
    privateRoots,
    toolchainBinDir,
  );
  return {
    routes,
    roots,
    privateRoots,
    toolchainBinDir,
    codexCommon,
    claudeOptions,
    trials,
  };
}

/** Decode CLI flags in their documented validation order. */
export function parseInvocation(argv: string[]) {
  const parsed = cliArguments(argv);
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "run")
    throw new InvocationError("expected the run command");
  return invocationInputs(parsed.values, invocationContext(parsed.values));
}
