import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import MarkdownIt from "markdown-it";

const root = resolve(import.meta.dir, "..");
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "sevro-doc-examples-")),
);

async function run(argv: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [output, diagnostic, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${argv[0]} exited ${code}: ${diagnostic || output}`);
  return output;
}

function example(text: string, id: string): string {
  const tokens = new MarkdownIt({ html: true }).parse(text, {});
  const marker = tokens.findIndex(
    (token) =>
      token.type === "html_block" &&
      token.content.trim() === `<!-- sevro-example:${id} -->`,
  );
  const fence = tokens[marker + 1];
  if (marker < 0 || fence?.type !== "fence" || fence.info !== "sh")
    throw new Error(`Missing marked shell example: ${id}`);
  return fence.content;
}

async function verify(
  cwd: string,
  command: string,
  expected: string,
): Promise<void> {
  try {
    await run(["/bin/sh", "-eu", "-c", command], cwd);
  } catch (error) {
    throw new Error(
      `${String(error)}; retained CLI result: ${await readFile(join(cwd, "sevro-result.json"), "utf8")}`,
    );
  }
  const result = JSON.parse(
    await readFile(join(cwd, "sevro-result.json"), "utf8"),
  ) as {
    exitCode: number;
    execution: { status: string };
    grading: { status: string };
    task: { verdict: string };
    evidencePath: string;
  };
  if (
    result.exitCode !== 0 ||
    result.execution.status !== "completed" ||
    result.task.verdict !== expected ||
    result.grading.status !==
      (expected === "passed" ? "completed" : "not_requested")
  )
    throw new Error(`Unexpected tutorial result in ${cwd}`);
  if (!result.evidencePath.startsWith(join(cwd, "sevro-results") + "/"))
    throw new Error(`Evidence escaped results root: ${result.evidencePath}`);
  const evidence = JSON.parse(await readFile(result.evidencePath, "utf8")) as {
    result: { task: { verdict: string } };
    trials: unknown[];
  };
  if (evidence.result.task.verdict !== expected || evidence.trials.length !== 1)
    throw new Error("Retained evidence differs from tutorial result");
}

try {
  const text = await readFile(join(root, "docs/getting-started.md"), "utf8");
  const consumerCommand = example(text, "consumer");
  const contributorCommand = example(text, "contributor");
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as { version: string; license: string };
  await run(
    [
      "npm",
      "pack",
      "--ignore-scripts",
      "--pack-destination",
      temporary,
      "--silent",
    ],
    root,
  );
  const archive = join(temporary, `bjoernrochel-sevro-${manifest.version}.tgz`);
  for (const [label, dependency] of [
    ["candidate-consumer", archive],
    ["published-consumer", "@bjoernrochel/sevro@0.1.0-rc.2"],
  ]) {
    const consumer = join(temporary, label);
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ name: label, private: true }),
    );
    await run([process.execPath, "add", "--exact", dependency], consumer);
    await verify(consumer, consumerCommand, "passed");
    await verify(
      consumer,
      consumerCommand.replaceAll("graded.json", "prompt-only.json"),
      "not_assessed",
    );
    const installed = join(consumer, "node_modules/@bjoernrochel/sevro");
    const installedManifest = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    ) as { license: string };
    const expectedLicense =
      label === "candidate-consumer" ? manifest.license : "BUSL-1.1";
    if (
      installedManifest.license !== expectedLicense ||
      !(await readFile(join(installed, "LICENSE"), "utf8")).trim()
    )
      throw new Error(`${label}: license mismatch`);
    if (
      label === "candidate-consumer" &&
      (await readFile(join(installed, "CONTRIBUTING.md"), "utf8")) !==
        (await readFile(join(root, "CONTRIBUTING.md"), "utf8"))
    )
      throw new Error("Contribution terms missing from package");
    if (
      label === "candidate-consumer" &&
      !(await readFile(join(installed, "LICENSE"))).equals(
        await readFile(join(root, "LICENSE")),
      )
    )
      throw new Error("Authoritative license differs in candidate package");
    console.log(
      `Passed exact documented commands: ${label}, license ${expectedLicense}`,
    );
  }
  const contributor = join(temporary, "contributor");
  await run(
    ["git", "clone", "--quiet", "--no-hardlinks", root, contributor],
    temporary,
  );
  for (const path of [
    "package.json",
    "bun.lock",
    "README.md",
    "LICENSE",
    "CONTRIBUTING.md",
    "docs",
    "schemas",
    "src",
    "examples",
    "scripts",
    "tests",
    "tsconfig.json",
    ".github",
    ".gitignore",
    ".agents",
    ".claude",
    "AGENTS.md",
    "CLAUDE.md",
  ])
    await cp(join(root, path), join(contributor, path), { recursive: true });
  await run([process.execPath, "install", "--frozen-lockfile"], contributor);
  await verify(contributor, contributorCommand, "passed");
  await verify(
    contributor,
    contributorCommand.replaceAll("graded.json", "prompt-only.json"),
    "not_assessed",
  );
  console.log("Passed exact documented commands: fresh contributor checkout");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
