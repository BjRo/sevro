import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function run(argv: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${argv.join(" ")} exited ${code}: ${stderr}${stdout}`);
  if (stderr.includes("sevro:"))
    throw new Error(`embedding API wrote CLI diagnostics: ${stderr}`);
  return stdout;
}

async function writeConsumerExamples(consumer: string): Promise<void> {
  await mkdir(join(consumer, "project"), { recursive: true });
  const manifest = JSON.parse(
    await readFile(join(consumer, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ ...manifest, type: "module" }),
  );
  await writeFile(
    join(consumer, "embedding.ts"),
    `import { evaluate, type EvaluateOptions, type EvaluationResult, type EvaluationProgress } from "@bjoernrochel/sevro";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const installed = fileURLToPath(new URL("./node_modules/@bjoernrochel/sevro/", import.meta.url));
const progress: EvaluationProgress[] = [];
const exitCode = process.exitCode;
const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
const options: EvaluateOptions = { argv: ["run", "--case-file", installed + "examples/basic/graded.json", "--adapter-module", installed + "dist/examples/basic/host.js", "--project-root", "./project", "--results-root", "./results"], onProgress: event => progress.push(event) };
const result: EvaluationResult = await evaluate(options);
if (result.task.verdict !== "passed" || result.execution.status !== "completed" || result.exitCode !== 0) throw new Error("deterministic evaluation did not pass");
if (!progress.some(event => event.stage === "evidence" && event.status === "completed")) throw new Error("missing progress");
const evidence = JSON.parse(await readFile(result.evidencePath, "utf8"));
if (!/^[a-f0-9]{64}$/.test(evidence.runner.buildDigest) || !/^[a-f0-9]{64}$/.test(evidence.evaluationIdentity.dimensions.projectDigest)) throw new Error("missing automatic identity");
const badCase = JSON.parse(await readFile(installed + "examples/basic/graded.json", "utf8"));
badCase.checks[0].configuration.pattern = "^wrong$";
await writeFile("./failed-case.json", JSON.stringify(badCase));
const failed = await evaluate({ argv: [...options.argv, "--case-file", "./failed-case.json"] });
if (failed.exitCode !== 1 || failed.task.verdict !== "failed" || failed.execution.status !== "completed") throw new Error("failed assessment was not returned");
let rejected = false;
try { await evaluate({ argv: [...options.argv, "--threshold", "2"] }); }
catch (error) { rejected = error instanceof Error && error.message.includes("invalid --threshold"); }
if (!rejected) throw new Error("invalid configuration did not reject");
const controller = new AbortController();
const cancelled = await evaluate({ ...options, argv: [...options.argv, "--trials", "3", "--jobs", "1"], signal: controller.signal, onProgress(event) { if (event.stage === "candidate" && event.status === "started") controller.abort("SIGTERM"); } });
if (cancelled.execution.status !== "cancelled" || cancelled.task.verdict !== "not_assessed" || cancelled.exitCode !== 143 || cancelled.cases[0]?.trials.length !== 1) throw new Error("caller cancellation was not retained");
if (process.exitCode !== exitCode || process.listenerCount("SIGINT") !== listeners[0] || process.listenerCount("SIGTERM") !== listeners[1]) throw new Error("API changed process ownership");
// @ts-expect-error verdicts are closed public states
const invalidVerdict: EvaluationResult["task"]["verdict"] = "success";
console.log("Installed embedding API passed");
`,
  );
}

async function writeDocumentedExample(consumer: string): Promise<void> {
  const documentation = await readFile(
    join(consumer, "node_modules/@bjoernrochel/sevro/docs/embedding-api.md"),
    "utf8",
  );
  const example = /```typescript\n([\s\S]*?)```/.exec(documentation)?.[1];
  if (!example)
    throw new Error(
      "installed embedding documentation has no consumer example",
    );
  await writeFile(join(consumer, "evaluation.ts"), example);
}

/** Verify imports and execution from an independently installed npm consumer. */
export async function verifyEmbeddingApi(consumer: string): Promise<void> {
  await run(
    ["npm", "install", "--no-save", "--ignore-scripts", "@types/node@24.13.2"],
    consumer,
  );
  await writeConsumerExamples(consumer);
  await writeDocumentedExample(consumer);
  const compiler = join(consumer, "node_modules/typescript/bin/tsc");
  for (const resolution of ["NodeNext", "Bundler"]) {
    await run(
      [
        "node",
        compiler,
        "embedding.ts",
        "evaluation.ts",
        "--strict",
        "--skipLibCheck",
        "false",
        "--target",
        "ES2022",
        "--module",
        resolution === "NodeNext" ? "NodeNext" : "ESNext",
        "--moduleResolution",
        resolution,
        "--types",
        "node",
      ],
      consumer,
    );
  }
  // Keep relative package/project paths anchored in the consumer.
  const output = await run(["node", "embedding.js"], consumer);
  if (output !== "Installed embedding API passed\n")
    throw new Error(`unexpected API stdout: ${output}`);
  process.stdout.write(output);
  const documented = await run(["node", "evaluation.js"], consumer);
  if (!documented.startsWith("passed\n"))
    throw new Error(`documented consumer failed: ${documented}`);
}

async function main(): Promise<void> {
  const source = resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(
    await readFile(join(source, "package.json"), "utf8"),
  ) as { version: string };
  const root = await mkdtemp(join(tmpdir(), "sevro-embedding-"));
  try {
    await run([process.execPath, "run", "build"], source);
    await run(
      [
        "npm",
        "pack",
        "--ignore-scripts",
        "--pack-destination",
        root,
        "--silent",
      ],
      source,
    );
    const consumer = join(root, "consumer");
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      '{"private":true,"type":"module"}',
    );
    await run(
      [
        "npm",
        "install",
        "--ignore-scripts",
        join(root, `bjoernrochel-sevro-${manifest.version}.tgz`),
      ],
      consumer,
    );
    await verifyEmbeddingApi(consumer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
