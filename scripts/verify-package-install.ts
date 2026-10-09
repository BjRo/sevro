import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkReleaseDocumentation } from "./release-documentation";

const sourceRoot = resolve(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { tarball: { type: "string" } },
});
if (
  values.tarball !== undefined &&
  (!isAbsolute(values.tarball) || !(await stat(values.tarball)).isFile())
)
  throw new Error("--tarball must name an existing absolute package file");
const root = await mkdtemp(join(tmpdir(), "sevro-package-install-"));

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
  const documentationErrors = await checkReleaseDocumentation(sourceRoot);
  if (documentationErrors.length)
    throw new Error(documentationErrors.join("\n"));
  const archive =
    values.tarball ??
    join(root, `bjoernrochel-sevro-${sourceManifest.version}.tgz`);
  if (values.tarball === undefined)
    await run(
      [
        "npm",
        "pack",
        "--ignore-scripts",
        "--pack-destination",
        root,
        "--silent",
      ],
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
  const installed = join(consumer, "node_modules", "@bjoernrochel", "sevro");
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
    !existsSync(join(installed, "schemas", "run-evidence-v1.schema.json")) ||
    !existsSync(join(installed, "schemas", "report-v1.schema.json")) ||
    !existsSync(join(installed, "examples", "basic", "graded.json")) ||
    !existsSync(join(installed, "examples", "basic", "prompt-only.json"))
  )
    throw new Error("installed package has missing or unexpected files");
  const manifest = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  ) as { name: string; version: string };
  if (
    manifest.name !== "@bjoernrochel/sevro" ||
    manifest.version !== sourceManifest.version
  )
    throw new Error("installed package identity differs from source metadata");
  const installedDocumentationErrors =
    await checkReleaseDocumentation(installed);
  if (installedDocumentationErrors.length)
    throw new Error(installedDocumentationErrors.join("\n"));
  async function installedRun(caseName: string) {
    const output = await run(
      [
        installedCommand,
        "run",
        "--json",
        "--case-file",
        join(installed, "examples", "basic", caseName),
        "--adapter-module",
        join(installed, "examples", "basic", "host.ts"),
        "--project-root",
        project,
        "--results-root",
        results,
        "--condition",
        "passive",
        "--trials",
        "1",
        "--threshold",
        "1",
      ],
      consumer,
    );
    return JSON.parse(output) as {
      exitCode: number;
      evidencePath: string;
      execution: { status: string };
      grading: { status: string };
      task: { verdict: string };
      cases: Array<{ trials: Array<{ checks: unknown[] }> }>;
    };
  }
  const result = await installedRun("graded.json");
  const evidence = JSON.parse(await readFile(result.evidencePath, "utf8")) as {
    runner: {
      source: string;
      packageName: string;
      version: string;
      buildDigest: string;
    };
    evaluationIdentity: {
      dimensions: { runnerBuildDigest: string; projectDigest: string };
    };
  };
  if (
    result.exitCode !== 0 ||
    result.execution.status !== "completed" ||
    result.grading.status !== "completed" ||
    result.task.verdict !== "passed" ||
    evidence.runner.source !== "package" ||
    evidence.runner.packageName !== "@bjoernrochel/sevro" ||
    evidence.runner.version !== manifest.version ||
    !/^[a-f0-9]{64}$/.test(evidence.runner.buildDigest) ||
    evidence.evaluationIdentity.dimensions.runnerBuildDigest !==
      evidence.runner.buildDigest ||
    !/^[a-f0-9]{64}$/.test(evidence.evaluationIdentity.dimensions.projectDigest)
  )
    throw new Error("installed package did not retain release provenance");
  const promptOnly = await installedRun("prompt-only.json");
  const promptEvidence = JSON.parse(
    await readFile(promptOnly.evidencePath, "utf8"),
  ) as {
    result: { task: { verdict: string } };
    trials: unknown[];
  };
  if (
    promptOnly.exitCode !== 0 ||
    promptOnly.execution.status !== "completed" ||
    promptOnly.grading.status !== "not_requested" ||
    promptOnly.task.verdict !== "not_assessed" ||
    promptEvidence.result.task.verdict !== "not_assessed" ||
    promptEvidence.trials.length !== 1 ||
    promptOnly.cases[0]?.trials[0]?.checks.length !== 0
  )
    throw new Error("installed prompt-only case claimed task success");
  if (process.platform === "darwin") {
    const binDir = join(root, "bin");
    await mkdir(binDir);
    const claudeBinary = join(binDir, "synthetic-claude");
    const uvCacheDir = join(binDir, "uv-cache");
    await mkdir(uvCacheDir);
    await writeFile(join(uvCacheDir, "sentinel"), "curated");
    const credentialFile = join(root, "claude-credential.json");
    const claudeCase = join(project, "claude-case.json");
    await Promise.all([
      writeFile(credentialFile, '{"test":"private-login"}', { mode: 0o600 }),
      writeFile(
        claudeBinary,
        [
          "#!/bin/sh",
          'test -r "$CLAUDE_CONFIG_DIR/.credentials.json" || exit 3',
          'test -z "${DARROW_CACHE_DIR+x}" || exit 4',
          'test "$(cat "$UV_CACHE_DIR/sentinel")" = curated || exit 5',
          'test "${HOME#*/.git/sevro-runtime/}" = host-home || exit 6',
          'mkdir -p "$HOME/.tool-cache" && printf isolated > "$HOME/.tool-cache/probe" || exit 7',
          'printf \'%s\\n\' \'{"type":"result","subtype":"success","is_error":false,"result":"READY","usage":{"input_tokens":1,"output_tokens":2},"total_cost_usd":0}\'',
        ].join("\n") + "\n",
        { mode: 0o700 },
      ),
      writeFile(
        claudeCase,
        JSON.stringify({
          id: "installed-claude",
          prompt: "Return READY.",
          fixture: { files: { "README.md": "fixture\n" } },
          checks: [
            {
              id: "ready",
              grader: "sevro.regex",
              configuration: { pattern: "^READY$" },
            },
            {
              id: "cache",
              grader: "sevro.shell",
              configuration: {
                run: 'test -z "${DARROW_CACHE_DIR+x}" && test "$(cat "$UV_CACHE_DIR/sentinel")" = curated && mkdir -p "$HOME/.tool-cache" && printf isolated > "$HOME/.tool-cache/probe"',
              },
            },
          ],
          requiredEvidence: [
            "sevro.claude.tool-calls",
            "sevro.host.native-controls",
          ],
        }),
      ),
    ]);
    const claude = JSON.parse(
      await run(
        [
          installedCommand,
          "run",
          "--json",
          "--case-file",
          claudeCase,
          "--host",
          "claude",
          "--claude-bin",
          claudeBinary,
          "--claude-credential-file",
          credentialFile,
          "--claude-uv-cache-dir",
          uvCacheDir,
          "--shell-isolation",
          "--model",
          "synthetic-claude",
          "--effort",
          "low",
          "--project-root",
          project,
          "--results-root",
          results,
          "--condition",
          "passive",
          "--trials",
          "1",
          "--threshold",
          "1",
        ],
        consumer,
      ),
    ) as {
      exitCode: number;
      task: { verdict: string };
      evidencePath: string;
    };
    const claudeEvidence = JSON.parse(
      await readFile(claude.evidencePath, "utf8"),
    ) as {
      runner: { source: string; version: string };
      routes: Array<{ host: string; model: string }>;
    };
    if (
      claude.exitCode !== 0 ||
      claude.task.verdict !== "passed" ||
      claudeEvidence.runner.source !== "package" ||
      claudeEvidence.runner.version !== manifest.version ||
      claudeEvidence.routes[0]?.host !== "sevro.host.claude" ||
      claudeEvidence.routes[0].model !== "synthetic-claude"
    )
      throw new Error("installed Claude host route did not complete");
  }
  const gradedResultFile = join(root, "graded-result.json");
  const promptResultFile = join(root, "prompt-result.json");
  await Promise.all([
    writeFile(gradedResultFile, JSON.stringify(result)),
    writeFile(promptResultFile, JSON.stringify(promptOnly)),
  ]);
  const report = JSON.parse(
    await run(
      [
        installedCommand,
        "report",
        "--json",
        "--result-file",
        gradedResultFile,
        "--result-file",
        promptResultFile,
      ],
      consumer,
    ),
  ) as {
    format: string;
    summary: { passed: number; notAssessed: number };
    rows: Array<{ candidateDurationMs: number | null; costUsd: number | null }>;
  };
  if (
    report.format !== "sevro.report.v1" ||
    report.summary.passed !== 1 ||
    report.summary.notAssessed !== 1 ||
    report.rows[0]?.candidateDurationMs === null ||
    report.rows.some((row) => row.costUsd !== null)
  )
    throw new Error("installed report lost task or measurement provenance");
  process.stdout.write(
    `Installed Sevro ${manifest.version} without source Git metadata\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
