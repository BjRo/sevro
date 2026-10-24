import { which } from "../executable";
import { join, resolve } from "node:path";
import { validQualifiedId } from "../value-guards";
import { canonicalRuntimeRoot } from "../runtime/paths";
import {
  PATH_OPTIONS,
  PATH_LIST_OPTIONS,
  EXTENSION_OPTIONS,
  RUN_OPTIONS,
  optionsWith,
  runArguments,
} from "./run-options";
import { savedRunValues } from "./run-manifest";

export class InvocationError extends Error {}

function requiredOption(value: string | undefined, name: string): string {
  if (!value)
    throw new InvocationError(`missing ${name}; supply ${name} with a value`);
  return value;
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
  const semanticCodex = values["semantic-host"] === "codex";
  const advisoryCodex = values["advisory-host"] === "codex";
  return {
    codex,
    claude,
    builtinHost: codex || claude,
    semanticCodex,
    advisoryCodex,
    anyCodex: codex || semanticCodex || advisoryCodex,
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
    invalid: (v, r) => !r.anyCodex && hasRouteOptions(v, "codex"),
    message: "Codex options require a Codex host route",
  },
  {
    invalid: (v, r) => !r.claude && hasRouteOptions(v, "claude"),
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

function hasRouteOptions(values: Values, route: "codex" | "claude"): boolean {
  return optionsWith("route", route).some((name) => {
    if (RUN_OPTIONS[name].kind === "number") return values[name] !== undefined;
    return Boolean(values[name]);
  });
}

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
  const projectRoot = requiredOption(values["project-root"], "--project-root");
  const configRoot =
    values["config-root"] !== undefined
      ? requiredOption(values["config-root"], "--config-root")
      : projectRoot;
  const resultsRoot = requiredOption(values["results-root"], "--results-root");
  const runStateRoot = values["run-state-root"]
    ? requiredOption(values["run-state-root"], "--run-state-root")
    : resultsRoot;
  return { projectRoot, configRoot, resultsRoot, runStateRoot };
}

type Roots = ReturnType<typeof rootParameters>;

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
  return EXTENSION_OPTIONS.some((name) => {
    const value = values[name];
    if (Array.isArray(value)) return value.length > 0;
    if (name === "task-verdict-policy") return value !== undefined;
    return Boolean(value);
  });
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
    ...optionsWith("private", true).flatMap((name) => values[name] ?? []),
  ].filter((value): value is string => Boolean(value));
}

function commonCodexOptions(
  values: Values,
  roots: Roots,
  privateRoots: string[],
) {
  return {
    binary: requiredOption(values["codex-bin"], "--codex-bin"),
    authFile: requiredOption(values["codex-auth-file"], "--codex-auth-file"),
    retainHostDiagnostics: values["retain-host-diagnostics"] === true,
    timeoutMs: codexTimeout(values["codex-timeout-ms"]),
    projectRoot: roots.projectRoot,
    resultsRoot: roots.resultsRoot,
    additionalProtectedRoots: [...privateRoots, roots.runStateRoot],
  };
}

function codexTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30 * 60_000)
    throw new InvocationError(
      "invalid --codex-timeout-ms; supply a positive integer at most 1800000 (30 minutes)",
    );
  return timeout;
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
    binary: requiredOption(values["claude-bin"], "--claude-bin"),
    ...(values["claude-credential-file"]
      ? {
          credentialFile: requiredOption(
            values["claude-credential-file"],
            "--claude-credential-file",
          ),
        }
      : {}),
    ...(values["claude-uv-cache-dir"]
      ? {
          uvCacheDir: requiredOption(
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
    commandFile: requiredOption(command, "--extension-command-file"),
    sourceFiles: extensionSources(values),
    caseId: requiredOption(values["case-id"], "--case-id"),
    configurationFile: values["extension-configuration-file"],
    redactedConfigurationFile: values["extension-redacted-configuration-file"],
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
  role: keyof typeof CODEX_MODEL_KEYS,
) {
  const [modelKey, effortKey] = CODEX_MODEL_KEYS[role];
  return {
    ...(role === "candidate"
      ? {
          entrypoint: values["codex-entrypoint"] as
            "exec" | "app-server" | undefined,
        }
      : {}),
    ...common,
    model: requiredOption(values[modelKey], `--${modelKey}`),
    effort: requiredOption(values[effortKey], `--${effortKey}`),
  };
}

function selectedCodexOptions(
  values: Values,
  routes: Routes,
  roots: Roots,
  privateRoots: string[],
) {
  if (!routes.anyCodex) return {};
  const common = commonCodexOptions(values, roots, privateRoots);
  return {
    codex: routes.codex
      ? codexRoleOptions(values, common, "candidate")
      : undefined,
    semanticCodex: routes.semanticCodex
      ? codexRoleOptions(values, common, "semantic")
      : undefined,
    advisoryCodex: routes.advisoryCodex
      ? codexRoleOptions(values, common, "advisory")
      : undefined,
  };
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
    codexOptions,
    claudeOptions,
    trials,
  } = context;
  return {
    json: values.json ?? false,
    runManifestFile: values["run-manifest-file"],
    protectedRoots: context.protectedRoots,
    deprecatedRuntimeOptions: optionsWith("section", "deprecated").filter(
      (name) => values[name] !== undefined,
    ),
    dry: values.dry ?? false,
    runtimeConfigFile: values["runtime-config-file"],
    caseFile: values["case-file"],
    extension: extensionInvocation(values),
    caseSourceRoot: values["case-source-root"],
    caseSourceMapFile: values["case-source-map-file"],
    adapterModule: routes.builtinHost
      ? undefined
      : requiredOption(values["adapter-module"], "--adapter-module"),
    semanticAdapterModule: values["semantic-adapter-module"],
    advisoryAdapterModule: values["advisory-adapter-module"],
    advisoryExcludedPaths: values["advisory-exclude"] ?? [],
    ...codexOptions,
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
    runnerCheckoutRoot: values["runner-checkout-root"],
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
  const toolchainBinDir = values["toolchain-bin-dir"];
  const routes = hostRoutes(values);
  const roots = rootParameters(values);
  validateExtensionSelection(values);
  const privateRoots = privateRootDeclarations(
    values,
    roots.configRoot,
    protectedRoots,
  );
  const codexOptions = selectedCodexOptions(
    values,
    routes,
    roots,
    privateRoots,
  );
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
    codexOptions,
    claudeOptions,
    trials,
  };
}

/** Decode CLI flags in their documented validation order. */
export async function parseInvocation(argv: string[]) {
  if (argv[0] !== "run")
    throw new InvocationError(
      "unknown command; available commands: demo, init, run, report, prune; run sevro --help",
    );
  const parsed = cliArguments(argv);
  if (parsed.positionals.length !== 1)
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
  if (routes.anyCodex) values["codex-bin"] ??= nativeBinary("codex");
  if (routes.claude) values["claude-bin"] ??= nativeBinary("claude");
}

function nativeBinary(host: "codex" | "claude"): string {
  const binary = which(host);
  if (!binary)
    throw new InvocationError(
      `selected ${host} executable was not found on PATH; install ${host} or supply --${host}-bin <path>`,
    );
  return binary;
}

export type Invocation = Awaited<ReturnType<typeof parseInvocation>>;

/** Keep all selected native roles visible to protection and evidence callers. */
export function nativeRoutes(
  invocation: Pick<
    Invocation,
    "codex" | "claude" | "semanticCodex" | "advisoryCodex"
  >,
) {
  return [
    invocation.codex,
    invocation.claude,
    invocation.semanticCodex,
    invocation.advisoryCodex,
  ].filter((host) => host !== undefined);
}

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
  for (const name of PATH_LIST_OPTIONS) {
    const paths = values[name];
    if (paths)
      values[name] = await Promise.all(
        paths.map((path) =>
          canonicalOption(requiredOption(path, `--${name}`), name),
        ),
      );
  }
}
