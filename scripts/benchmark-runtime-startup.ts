import { mock } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RuntimePolicy } from "../src/runtime/config";

const sourceRoot = resolve(required(process.argv[2]));
const output = resolve(required(process.argv[3]));
const native = required(Bun.which("codex"));
const rows: Record<string, unknown>[] = [];
let repetition = 0;
let role = "candidate";
function required(value: string | null | undefined): string {
  if (!value)
    throw new Error(
      "usage: bun scripts/benchmark-runtime-startup.ts SOURCE_ROOT OUTPUT_JSON",
    );
  return value;
}
function sourceModule(grouped: string, legacy: string): string {
  const path = join(sourceRoot, grouped);
  return existsSync(path) ? path : join(sourceRoot, legacy);
}
async function measure<T>(phase: string, action: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await action();
    rows.push({
      repetition,
      role,
      phase,
      milliseconds: performance.now() - start,
      status: "completed",
    });
    return result;
  } catch (error) {
    rows.push({
      repetition,
      role,
      phase,
      milliseconds: performance.now() - start,
      status: "failed",
      diagnostic: error instanceof Error ? error.message : "unknown",
    });
    throw error;
  }
}
async function instrumentation() {
  const runtimePath = sourceModule(
    "src/runtime/state.ts",
    "src/runtime-state.ts",
  );
  const runtime = (await import(
    runtimePath
  )) as typeof import("../src/runtime/state");
  const prepareRuntimeState = runtime.prepareRuntimeState;
  await mock.module(runtimePath, () => ({
    ...runtime,
    prepareRuntimeState: (
      ...args: Parameters<typeof runtime.prepareRuntimeState>
    ) => measure(`runtime.${args[2]}`, () => prepareRuntimeState(...args)),
  }));
  const processPath = join(sourceRoot, "src/hosts/codex-process.ts");
  const processes = (await import(
    processPath
  )) as typeof import("../src/hosts/codex-process");
  const runCodexProcess = processes.runCodexProcess;
  await mock.module(processPath, () => ({
    ...processes,
    runCodexProcess: (
      options: Parameters<typeof processes.runCodexProcess>[0],
    ) => measure(processPhase(options.argv), () => runCodexProcess(options)),
  }));
  const installPath = join(sourceRoot, "src/hosts/codex-marketplace.ts");
  const install = (await import(
    installPath
  )) as typeof import("../src/hosts/codex-marketplace");
  const installCodexPlugins = install.installCodexPlugins;
  await mock.module(installPath, () => ({
    ...install,
    installCodexPlugins: (
      options: Parameters<typeof install.installCodexPlugins>[0],
    ) =>
      measure("plugin-install", async () => {
        const installed = await installCodexPlugins(options);
        if (installed.length)
          await installedAssets(
            dirname(dirname(options.pluginCacheRoot)),
            options.request.workspace,
          );
        return installed;
      }),
  }));
}
function processPhase(argv: string[]): string {
  if (argv[1] === "sandbox") return "sandbox-probe";
  return argv[1] === "plugin" ? "plugin-command" : "participant-execution";
}
async function installedAssets(home: string, workspace: string): Promise<void> {
  const config = await readFile(join(home, "config.toml"), "utf8");
  const files = await readdir(join(home, "plugins"));
  rows.push({
    repetition,
    role,
    phase: "installation-assets",
    files,
    configurationContainsPrivateHome: config.includes(home),
    configurationContainsWorkspace: config.includes(workspace),
  });
}
async function fakeModel(root: string): Promise<string> {
  const binary = join(root, "synthetic-model");
  await writeFile(
    binary,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'plugin') {
  const child = Bun.spawn([${JSON.stringify(native)}, ...args], {env:process.env,stdout:'inherit',stderr:'inherit'});
  process.exit(await child.exited);
}
await Bun.stdin.text();
const semantic = args.includes('synthetic-semantic');
console.log(JSON.stringify({type:'thread.started',thread_id:'benchmark-thread'}));
const text = semantic ? JSON.stringify({checks:[{id:'meaning',verdict:'pass',reason:'Controlled fixture'}]}) : 'ready';
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,
    { mode: 0o700 },
  );
  return binary;
}
async function dependencies(root: string): Promise<RuntimePolicy> {
  const source = join(root, "dependencies");
  await mkdir(source);
  const bytes = Buffer.alloc(16 * 1024, 0x61);
  for (let index = 0; index < 2048; index++)
    await writeFile(join(source, `dependency-${index}`), bytes);
  const config = (await import(
    sourceModule("src/runtime/config.ts", "src/runtime-config.ts")
  )) as typeof import("../src/runtime/config");
  const path = join(root, "runtime.json");
  await writeFile(
    path,
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { PUBLIC_CACHE_DIR: "{{sevro.runtime}}/cache" } },
      runtime: { seedDirectories: [{ source, target: "cache" }] },
    }),
  );
  const policy = await measure("configuration", () =>
    config.loadRuntimeConfiguration(root, path),
  );
  if (!policy) throw new Error("benchmark runtime absent");
  return policy;
}
async function marketplace(workspace: string) {
  const files = {
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "sevro-benchmark",
      owner: { name: "Sevro" },
      plugins: [
        { name: "probe", source: "./plugin", description: "Benchmark" },
      ],
    }),
    "plugin/.claude-plugin/plugin.json": JSON.stringify({
      name: "probe",
      version: "1.0.0",
    }),
    "plugin/.codex-plugin/plugin.json": JSON.stringify({
      name: "probe",
      version: "1.0.0",
      skills: "./skills/",
    }),
    "plugin/skills/probe/SKILL.md":
      "---\nname: probe\ndescription: Benchmark fixture\n---\nReturn ready.\n",
  };
  for (const [path, value] of Object.entries(files)) {
    const target = join(workspace, "marketplace", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value);
  }
  return {
    artifactRoot: "marketplace",
    marketplaceName: "sevro-benchmark",
    pluginNames: ["probe"],
    artifactPaths: Object.keys(files).map((path) => `marketplace/${path}`),
  };
}
async function cloneControl(root: string) {
  const source = join(root, "clone-source"),
    target = join(root, "clone-copy");
  await writeFile(source, Buffer.alloc(32 * 1024 * 1024, 0x61));
  try {
    await measure("cow-copy", () =>
      copyFile(source, target, constants.COPYFILE_FICLONE_FORCE),
    );
    await writeFile(target, "changed");
    rows.push({
      phase: "cow-isolation",
      sourceUnchanged: (await readFile(source)).length === 32 * 1024 * 1024,
    });
  } catch {
    rows.push({ phase: "cow-isolation", supported: false });
  }
}
async function trial(root: string, policy: RuntimePolicy, binary: string) {
  const codex = (await import(
    join(sourceRoot, "src/hosts/codex.ts")
  )) as typeof import("../src/hosts/codex");
  const grading = (await import(
    sourceModule(
      "src/evaluation/grading-host.ts",
      "src/evaluation-grading-host.ts",
    )
  )) as typeof import("../src/evaluation/grading-host");
  for (const selected of ["candidate", "semantic"] as const) {
    role = selected;
    const workspace = join(root, `workspace-${repetition}-${role}`);
    await mkdir(workspace);
    const plugin =
      role === "candidate" ? await marketplace(workspace) : undefined;
    const host = codex.createCodexHost({
      binary,
      sandboxBinary: native,
      authFile: join(root, "auth.json"),
      projectRoot: join(root, "project"),
      resultsRoot: join(root, "results"),
      additionalProtectedRoots: [],
      model: `synthetic-${role}`,
      effort: "low",
    });
    const result = await measure(
      role === "semantic" ? "grading" : "candidate-total",
      () =>
        host.run({
          prompt: "Return ready.",
          workspace,
          condition: "passive",
          codexMarketplace: plugin,
          runtimeRole: selected,
          runtimePolicy:
            selected === "candidate"
              ? policy
              : grading.gradingRuntimePolicy(policy, true),
        }),
    );
    if (!result.complete) throw new Error("benchmark native host incomplete");
  }
}
async function main() {
  const root = await mkdtemp(join(tmpdir(), "sevro-startup-benchmark-"));
  try {
    await instrumentation();
    await Promise.all(
      ["project", "results"].map((path) => mkdir(join(root, path))),
    );
    await writeFile(join(root, "auth.json"), "{}");
    const binary = await fakeModel(root);
    const policy = await dependencies(root);
    for (repetition = 1; repetition <= 3; repetition++)
      await trial(root, policy, binary);
    await cloneControl(root);
  } finally {
    const version = Bun.spawnSync([native, "--version"]);
    await writeFile(
      output,
      JSON.stringify(
        {
          format: "sevro.runtime-startup-benchmark.v1",
          sourceRoot,
          platform: process.platform,
          arch: process.arch,
          bun: Bun.version,
          codex: version.stdout.toString().trim(),
          case: "synthetic-plugin-response",
          model: "synthetic-candidate / synthetic-semantic",
          effort: "low",
          seed: { entries: 2049, bytes: 33554432 },
          repetitions: 3,
          conditions:
            "Fresh role homes each invocation; first verified snapshot cold, later repetitions warm; OS filesystem caches uncontrolled; no live API/model calls",
          rows,
        },
        null,
        2,
      ) + "\n",
    );
    await rm(root, { recursive: true, force: true });
  }
}
await main();
