import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const sourceRoot = resolve(import.meta.dir, "..");
const releaseVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/;
const requiredFiles = [
  "package.json",
  "README.md",
  "LICENSE",
  "src/cli.ts",
  "schemas/run-evidence-v1.schema.json",
  "schemas/report-v1.schema.json",
  "examples/basic/graded.json",
  "examples/basic/prompt-only.json",
];

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  repository?: { type?: string; url?: string };
  publishConfig?: { registry?: string; access?: string; tag?: string };
}

interface Pack {
  name: string;
  version: string;
  filename: string;
  files: Array<{ path: string; size: number; mode: number }>;
}

function isReleaseVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    releaseVersion.test(value) &&
    !/(?:^|[.-])dev(?:[.-]|$)/i.test(value)
  );
}

function validateIdentity(manifest: Manifest, tag: string | undefined) {
  if (
    manifest.name !== "@bjoernrochel/sevro" ||
    manifest.private !== false ||
    !isReleaseVersion(manifest.version)
  )
    throw new Error("a public Sevro release version is required");
  if (tag !== `v${manifest.version}`)
    throw new Error("--tag must match v<package version>");
}

async function validateLicense(manifest: Manifest) {
  if (
    typeof manifest.license !== "string" ||
    !manifest.license.trim() ||
    manifest.license === "UNLICENSED" ||
    !(await readFile(join(sourceRoot, "LICENSE"), "utf8")).trim()
  )
    throw new Error(
      "an owner-selected license and nonempty LICENSE are required",
    );
}

function validateRepository(manifest: Manifest) {
  const repository = manifest.repository;
  if (
    repository?.type !== "git" ||
    repository.url !== "git+https://github.com/BjRo/sevro.git"
  )
    throw new Error(
      "public repository, registry, and distribution tag are required",
    );
}

function validateRegistry(manifest: Manifest) {
  const publish = manifest.publishConfig;
  validateDistributionTag(publish?.tag);
  if (
    publish?.registry !== "https://registry.npmjs.org/" ||
    publish.access !== "public"
  )
    throw new Error(
      "public repository, registry, and distribution tag are required",
    );
}

function validateDistributionTag(tag: string | undefined) {
  if (!["next", "latest"].includes(tag ?? ""))
    throw new Error(
      "public repository, registry, and distribution tag are required",
    );
}

function validatePack(
  pack: Pack | undefined,
  count: number,
  manifest: Manifest,
): asserts pack is Pack {
  if (count !== 1 || !pack)
    throw new Error("npm packed an unexpected release identity");
  validatePackedIdentity(pack, manifest);
  if (
    pack.filename !== `bjoernrochel-sevro-${manifest.version}.tgz` ||
    basename(pack.filename) !== pack.filename
  )
    throw new Error("npm packed an unexpected release identity");
}

function validatePackedIdentity(pack: Pack, manifest: Manifest) {
  if (pack.name !== manifest.name || pack.version !== manifest.version)
    throw new Error("npm packed an unexpected release identity");
}

function validatePackFiles(pack: Pack) {
  for (const path of requiredFiles)
    if (!pack.files.some((file) => file.path === path))
      throw new Error(`release is missing ${path}`);
  if (
    pack.files.some(
      ({ path }) =>
        !/^(?:(?:package\.json|README\.md|CONTRIBUTING\.md|LICENSE)$|(?:src|docs|schemas|examples)\/)/.test(
          path,
        ),
    )
  )
    throw new Error("release contains files outside the package contract");
}

async function prepare() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { tag: { type: "string" }, output: { type: "string" } },
  });
  if (!values.output || !isAbsolute(values.output))
    throw new Error("--output must name a new absolute directory");
  const manifest = JSON.parse(
    await readFile(join(sourceRoot, "package.json"), "utf8"),
  ) as Manifest;
  validateIdentity(manifest, values.tag);
  await validateLicense(manifest);
  validateRepository(manifest);
  validateRegistry(manifest);

  const output = resolve(values.output);
  await mkdir(output, { mode: 0o700 });
  try {
    await produceRelease(manifest, output, values.tag);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

async function produceRelease(
  manifest: Manifest,
  output: string,
  tag: string | undefined,
) {
  const child = Bun.spawn(
    ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", output],
    { cwd: sourceRoot, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`npm pack failed: ${stderr || stdout}`);
  const packs = JSON.parse(stdout) as Pack[];
  const pack = packs[0];
  validatePack(pack, packs.length, manifest);
  validatePackFiles(pack);
  await retainRelease(manifest, pack, output, tag);
}

async function retainRelease(
  manifest: Manifest,
  pack: Pack,
  output: string,
  tag: string | undefined,
) {
  const bytes = await readFile(join(output, pack.filename));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const nodeVersion = Bun.spawnSync(["node", "--version"]);
  const npmVersion = Bun.spawnSync(["npm", "--version"]);
  if (nodeVersion.exitCode !== 0 || npmVersion.exitCode !== 0)
    throw new Error("preparation runtime versions are unavailable");
  const record = {
    format: "sevro.release.v1",
    name: manifest.name,
    version: manifest.version,
    releaseTag: tag,
    distTag: manifest.publishConfig?.tag,
    archive: join(output, pack.filename),
    sha256,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    runtimes: {
      bun: Bun.version,
      node: nodeVersion.stdout.toString().trim(),
      npm: npmVersion.stdout.toString().trim(),
    },
    files: pack.files,
  };
  await writeFile(
    join(output, "release.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
  await writeFile(join(output, "SHA256SUMS"), `${sha256}  ${pack.filename}\n`);
  process.stdout.write(JSON.stringify(record, null, 2) + "\n");
}

try {
  await prepare();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
