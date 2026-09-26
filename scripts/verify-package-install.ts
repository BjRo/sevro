import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sourceRoot = resolve(import.meta.dir, "..");
const root = await mkdtemp(join(tmpdir(), "sevro-package-install-"));
const digest = "a".repeat(64);

async function run(argv: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${argv[0]} exited ${code}: ${stderr || stdout}`);
  return stdout;
}

try {
  const sourceManifest = JSON.parse(
    await readFile(join(sourceRoot, "package.json"), "utf8"),
  ) as { version: string };
  const archive = join(root, `sevro-${sourceManifest.version}.tgz`);
  await run(
    [process.execPath, "pm", "pack", "--destination", root, "--quiet"],
    sourceRoot,
  );
  const consumer = join(root, "consumer");
  const project = join(root, "project");
  const results = join(root, "results");
  await Promise.all([mkdir(consumer), mkdir(project)]);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "sevro-package-consumer", private: true }),
  );
  await run([process.execPath, "add", archive], consumer);
  const installed = join(consumer, "node_modules", "sevro");
  const installedCommand = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "sevro.cmd" : "sevro",
  );
  if (
    !existsSync(installedCommand) ||
    existsSync(join(installed, ".git")) ||
    existsSync(join(installed, "tests")) ||
    !existsSync(join(installed, "schemas", "run-evidence-v1.schema.json"))
  )
    throw new Error("installed package has missing or unexpected files");
  const manifest = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  ) as { version: string };
  const caseFile = join(project, "case.json");
  const adapter = join(project, "adapter.ts");
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "package-install",
      prompt: "Return ready.",
      fixture: { files: { "README.md": "fixture\n" } },
      checks: [
        {
          id: "ready",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
      requiredEvidence: [],
    }),
  );
  await writeFile(
    adapter,
    `export default {
  id: "sevro.host.package-test", model: "synthetic-v1", effort: "none",
  async run() { return { finalMessage: "ready", complete: true }; },
};
`,
  );
  const output = await run(
    [
      installedCommand,
      "run",
      "--json",
      "--case-file",
      caseFile,
      "--adapter-module",
      adapter,
      "--project-root",
      project,
      "--results-root",
      results,
      "--runner-build-digest",
      digest,
      "--project-digest",
      digest,
      "--condition",
      "passive",
      "--trials",
      "1",
      "--threshold",
      "1",
    ],
    consumer,
  );
  const result = JSON.parse(output) as {
    exitCode: number;
    evidencePath: string;
  };
  const evidence = JSON.parse(await readFile(result.evidencePath, "utf8")) as {
    runner: { source: string; packageName: string; version: string };
  };
  if (
    result.exitCode !== 0 ||
    evidence.runner.source !== "package" ||
    evidence.runner.packageName !== "sevro" ||
    evidence.runner.version !== manifest.version
  )
    throw new Error("installed package did not retain release provenance");
  process.stdout.write(
    `Installed Sevro ${manifest.version} without source Git metadata\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
