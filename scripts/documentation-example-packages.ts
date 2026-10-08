import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../src/value-guards";
import { verifyTutorialModes } from "./documentation-example-results";
import { runDocumentationCommand } from "./documentation-process";

async function packageLicense(path: string): Promise<string> {
  const value: unknown = JSON.parse(
    await readFile(join(path, "package.json"), "utf8"),
  );
  if (!isRecord(value) || typeof value.license !== "string")
    throw new Error(`Invalid package license in ${path}`);
  return value.license;
}

export async function candidatePackage(root: string, temporary: string) {
  const value: unknown = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (!isRecord(value) || typeof value.version !== "string")
    throw new Error("Invalid candidate package version");
  const license = await packageLicense(root);
  await runDocumentationCommand(
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
  return {
    archive: join(temporary, `bjoernrochel-sevro-${value.version}.tgz`),
    license,
  };
}

async function candidateTerms(root: string, installed: string): Promise<void> {
  if (
    (await readFile(join(installed, "CONTRIBUTING.md"), "utf8")) !==
    (await readFile(join(root, "CONTRIBUTING.md"), "utf8"))
  )
    throw new Error("Contribution terms missing from package");
  if (
    !(await readFile(join(installed, "LICENSE"))).equals(
      await readFile(join(root, "LICENSE")),
    )
  )
    throw new Error("Authoritative license differs in candidate package");
}

export async function verifyConsumer(
  root: string,
  temporary: string,
  command: string,
  label: string,
  dependency: string,
  expectedLicense: string,
): Promise<void> {
  const consumer = join(temporary, label);
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: label, private: true }),
  );
  await runDocumentationCommand(
    [process.execPath, "add", "--exact", dependency],
    consumer,
  );
  await verifyTutorialModes(consumer, command);
  const installed = join(consumer, "node_modules/@bjoernrochel/sevro");
  if (
    (await packageLicense(installed)) !== expectedLicense ||
    !(await readFile(join(installed, "LICENSE"), "utf8")).trim()
  )
    throw new Error(`${label}: license mismatch`);
  if (label === "candidate-consumer") await candidateTerms(root, installed);
  console.log(
    `Passed exact documented commands: ${label}, license ${expectedLicense}`,
  );
}

export async function verifyContributor(
  root: string,
  temporary: string,
  command: string,
): Promise<void> {
  const contributor = join(temporary, "contributor");
  await runDocumentationCommand(
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
  await runDocumentationCommand(
    [process.execPath, "install", "--frozen-lockfile"],
    contributor,
  );
  await verifyTutorialModes(contributor, command);
  console.log("Passed exact documented commands: fresh contributor checkout");
}
