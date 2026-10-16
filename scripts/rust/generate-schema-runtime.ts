import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { isRecord } from "../../src/value-guards";

const root = resolve(import.meta.dir, "../..");
const assetDirectory = "crates/sevro/assets/schema";
const bundleName = "ajv-8.20.0.bundle.js";
const entry =
  'import Ajv2020 from "ajv/dist/2020.js"; globalThis.Ajv2020 = Ajv2020;\n';
const packages = [
  ["ajv", "8.20.0"],
  ["fast-deep-equal", "3.1.3"],
  ["fast-uri", "3.1.8"],
  ["json-schema-traverse", "1.0.0"],
] as const;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function requirePackages() {
  for (const [name, version] of packages) {
    const value: unknown = JSON.parse(
      await readFile(
        resolve(root, "node_modules", name, "package.json"),
        "utf8",
      ),
    );
    if (!isRecord(value) || value.version !== version)
      throw new Error(`Expected ${name}@${version} for schema runtime`);
  }
}

async function sourceInputs(metafile: Bun.BuildMetafile, entryPath: string) {
  const inputs: { path: string; sha256: string }[] = [];
  for (const input of Object.keys(metafile.inputs)) {
    const path = resolve(root, input);
    if (path === entryPath) continue;
    const marker = path.lastIndexOf("/node_modules/");
    if (marker < 0)
      throw new Error(`Unexpected schema runtime input: ${input}`);
    inputs.push({
      path: path.slice(marker + 1),
      sha256: sha256(await readFile(path)),
    });
  }
  return inputs.sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
}

async function buildRuntime() {
  const temporary = await realpath(
    await mkdtemp(resolve(tmpdir(), "sevro-schema-runtime-")),
  );
  const entryPath = resolve(temporary, "entry.ts");
  try {
    const importPath = JSON.stringify(
      resolve(root, "node_modules/ajv/dist/2020.js"),
    );
    await writeFile(entryPath, entry.replace('"ajv/dist/2020.js"', importPath));
    const built = await Bun.build({
      entrypoints: [entryPath],
      root,
      target: "browser",
      format: "iife",
      minify: { identifiers: false, syntax: true, whitespace: true },
      metafile: true,
    });
    const output = built.outputs[0];
    if (
      !built.success ||
      built.outputs.length !== 1 ||
      !output ||
      !built.metafile
    )
      throw new Error(
        `Schema runtime build failed: ${built.logs.map((log) => log.message).join("\n")}`,
      );
    const bundle = await output.text();
    const inputs = await sourceInputs(built.metafile, entryPath);
    return { bundle, inputs };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function outputFile(name: string, content: string, check: boolean) {
  const path = resolve(root, assetDirectory, name);
  if (!check) {
    await writeFile(path, content);
    return;
  }
  const actual = await readFile(path, "utf8").catch(() => "");
  if (actual !== content)
    throw new Error(
      `Stale schema runtime ${name}; run bun scripts/rust/generate-schema-runtime.ts`,
    );
}

function checkRequested(): boolean {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.length > 1 ||
    (arguments_.length === 1 && arguments_[0] !== "--check")
  )
    throw new Error("Expected no arguments or --check");
  return arguments_.length === 1;
}

async function main() {
  const check = checkRequested();
  if (Bun.version !== "1.3.13")
    throw new Error("Schema runtime generation requires Bun 1.3.13");
  await requirePackages();
  const { bundle, inputs } = await buildRuntime();
  const manifest =
    JSON.stringify(
      {
        format: "sevro.schema-runtime.v1",
        generator: "scripts/rust/generate-schema-runtime.ts",
        bunVersion: Bun.version,
        entry,
        packages: packages.map(([name, version]) => ({ name, version })),
        inputs,
        bundle: {
          path: `${assetDirectory}/${bundleName}`,
          sha256: sha256(bundle),
        },
      },
      null,
      2,
    ) + "\n";
  if (!check) await mkdir(resolve(root, assetDirectory), { recursive: true });
  await outputFile(bundleName, bundle, check);
  await outputFile("manifest.json", manifest, check);
}

await main();
