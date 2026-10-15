import { join, resolve } from "node:path";
import { canonicalRuntimeRoot } from "../runtime/paths";
import { PATH_OPTIONS, runArguments } from "./run-options";
import { savedRunValues } from "./run-manifest";

export class InvocationError extends Error {}

function requiredOption(value: string | undefined, name: string): string {
  if (!value)
    throw new InvocationError(`missing ${name}; supply ${name} with a value`);
  return value;
}

function absoluteOption(value: string | undefined, name: string): string {
  return requiredOption(value, name);
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
    throw new InvocationError("invalid --condition; use passive or enforced");
  return condition;
}

function cliArguments(argv: string[]) {
  try {
    return runArguments(argv);
  } catch (cause) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    throw new InvocationError(`invalid CLI arguments${detail}`, { cause });
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
    throw new InvocationError(
      "invalid --threshold; supply a number greater than 0 and at most 1",
    );
  return { condition, trialCount, jobs, passThreshold };
}

function positiveInteger(value: number, option: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new InvocationError(`invalid ${option}; supply a positive integer`);
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
    message: "unsupported --host; use codex or claude",
  },
  {
    invalid: (v, r) => v["semantic-host"] && !r.semanticCodex,
    message: "unsupported --semantic-host; use codex",
  },
  {
    invalid: (v, r) => v["advisory-host"] && !r.advisoryCodex,
    message: "unsupported --advisory-host; use codex",
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
      [
        v["codex-bin"],
        v["codex-auth-file"],
        v["codex-timeout-ms"] !== undefined,
      ].some(Boolean),
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
      values["extension-source-file"]?.length,
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
    values["codex-auth-file"],
    values["runtime-config-file"],
    values["run-manifest-file"],
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
    retainHostDiagnostics: values["retain-host-diagnostics"] === true,
    timeoutMs:
      values["codex-timeout-ms"] === undefined
        ? undefined
        : Number(values["codex-timeout-ms"]),
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
    retainHostDiagnostics: values["retain-host-diagnostics"] === true,
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
    runManifestFile: values["run-manifest-file"],
    protectedRoots: context.protectedRoots,
    deprecatedRuntimeOptions: (
      ["toolchain-bin-dir", "claude-uv-cache-dir"] as const
    ).filter((name) => values[name] !== undefined),
    dry: values.dry ?? false,
    runtimeConfigFile: optionalAbsolute(
      values["runtime-config-file"],
      "--runtime-config-file",
    ),
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
    protectedRoots,
    privateRoots,
    toolchainBinDir,
    codexCommon,
    claudeOptions,
    trials,
  };
}

/** Decode CLI flags in their documented validation order. */
export async function parseInvocation(argv: string[]) {
  const parsed = cliArguments(argv);
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "run")
    throw new InvocationError("expected the run command");
  parsed.values = await savedRunValues(parsed.values);
  applyRunDefaults(parsed.values);
  validateHostCompatibility(
    parsed.values,
    hostRoutes(parsed.values),
    parsed.values["protected-root"] ?? [],
  );
  applyRootDefaults(parsed.values);
  resolveNativeBinaries(parsed.values);
  await canonicalizePaths(parsed.values);
  return invocationInputs(parsed.values, invocationContext(parsed.values));
}

function resolveNativeBinaries(values: Values): void {
  const routes = hostRoutes(values);
  if ([routes.codex, routes.semanticCodex, routes.advisoryCodex].some(Boolean))
    values["codex-bin"] ??= nativeBinary("codex");
  if (routes.claude) values["claude-bin"] ??= nativeBinary("claude");
}

function nativeBinary(host: "codex" | "claude"): string {
  const binary = Bun.which(host);
  if (!binary)
    throw new InvocationError(
      `selected ${host} executable was not found on PATH; install ${host} or supply --${host}-bin <path>`,
    );
  return binary;
}

export type Invocation = Awaited<ReturnType<typeof parseInvocation>>;

function applyRunDefaults(values: Values): void {
  values.condition ??= "passive";
  values.trials ??= "1";
  values.jobs ??= "3";
  values.threshold ??= "1";
}

function applyRootDefaults(values: Values): void {
  values["project-root"] ??= process.cwd();
  values["results-root"] ??= join(
    resolve(values["project-root"]),
    ".sevro",
    "results",
  );
}

async function canonicalOption(path: string, option: string): Promise<string> {
  try {
    return await canonicalRuntimeRoot(resolve(path));
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    throw new InvocationError(
      `--${option} cannot be resolved at ${path}: filesystem ${error.syscall ?? "realpath"} failed (${error.code ?? "unknown"}); supply a usable file or directory path`,
      { cause },
    );
  }
}

async function canonicalizePaths(values: Values): Promise<void> {
  for (const name of PATH_OPTIONS) {
    const value = values[name];
    if (value !== undefined)
      values[name] = await canonicalOption(
        requiredOption(value, `--${name}`),
        name,
      );
  }
  for (const name of ["extension-source-file", "protected-root"] as const) {
    const paths = values[name];
    if (paths)
      values[name] = await Promise.all(
        paths.map((path) =>
          canonicalOption(requiredOption(path, `--${name}`), name),
        ),
      );
  }
}
