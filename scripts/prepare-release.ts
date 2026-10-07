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

async function prepare() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: { tag: { type: "string" }, output: { type: "string" } },
  });
  if (positionals.length || !values.output || !isAbsolute(values.output))
    throw new Error("--output must name a new absolute directory");
  const manifest = JSON.parse(
    await readFile(join(sourceRoot, "package.json"), "utf8"),
  ) as {
    name?: string;
    version?: string;
    private?: boolean;
    license?: string;
    repository?: { type?: string; url?: string };
    publishConfig?: { registry?: string; access?: string; tag?: string };
  };
  if (
    manifest.name !== "@bjoernrochel/sevro" ||
    manifest.private !== false ||
    typeof manifest.version !== "string" ||
    !releaseVersion.test(manifest.version) ||
    /(?:^|[.-])dev(?:[.-]|$)/i.test(manifest.version)
  )
    throw new Error("a public Sevro release version is required");
  if (values.tag !== `v${manifest.version}`)
    throw new Error("--tag must match v<package version>");
  if (
    typeof manifest.license !== "string" ||
    !manifest.license.trim() ||
    manifest.license === "UNLICENSED" ||
    !(await readFile(join(sourceRoot, "LICENSE"), "utf8")).trim()
  )
    throw new Error(
      "an owner-selected license and nonempty LICENSE are required",
    );
  if (
    manifest.repository?.type !== "git" ||
    manifest.repository.url !== "git+https://github.com/BjRo/sevro.git" ||
    manifest.publishConfig?.registry !== "https://registry.npmjs.org/" ||
    manifest.publishConfig.access !== "public" ||
    !["next", "latest"].includes(manifest.publishConfig.tag ?? "")
  )
    throw new Error(
      "public repository, registry, and distribution tag are required",
    );

  const output = resolve(values.output);
  await mkdir(output, { mode: 0o700 });
  try {
    const child = Bun.spawn(
      [
        "npm",
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        output,
      ],
      { cwd: sourceRoot, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`npm pack failed: ${stderr || stdout}`);
    const packs = JSON.parse(stdout) as Array<{
      name: string;
      version: string;
      filename: string;
      files: Array<{ path: string; size: number; mode: number }>;
    }>;
    const pack = packs[0];
    if (
      packs.length !== 1 ||
      !pack ||
      pack.name !== manifest.name ||
      pack.version !== manifest.version ||
      pack.filename !== `bjoernrochel-sevro-${manifest.version}.tgz` ||
      basename(pack.filename) !== pack.filename
    )
      throw new Error("npm packed an unexpected release identity");
    for (const path of requiredFiles)
      if (!pack.files.some((file) => file.path === path))
        throw new Error(`release is missing ${path}`);
    if (
      pack.files.some(
        ({ path }) =>
          !/^(?:(?:package\.json|README\.md|LICENSE)$|(?:src|docs|schemas|examples)\/)/.test(
            path,
          ),
      )
    )
      throw new Error("release contains files outside the package contract");
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
      releaseTag: values.tag,
      distTag: manifest.publishConfig.tag,
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
    await writeFile(
      join(output, "SHA256SUMS"),
      `${sha256}  ${pack.filename}\n`,
    );
    process.stdout.write(JSON.stringify(record, null, 2) + "\n");
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

try {
  await prepare();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
