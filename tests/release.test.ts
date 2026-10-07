import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sevro-release-test-"));
  roots.push(root);
  const source = join(root, "source");
  const output = join(root, "release");
  await mkdir(join(source, "scripts"), { recursive: true });
  const command = join(source, "scripts/prepare-release.ts");
  await copyFile(
    resolve(import.meta.dir, "../scripts/prepare-release.ts"),
    command,
  );
  const manifest = {
    name: "@bjoernrochel/sevro",
    version: "0.1.0-rc.1",
    private: false,
    bin: { sevro: "./src/cli.ts" },
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/BjRo/sevro.git" },
    publishConfig: {
      registry: "https://registry.npmjs.org/",
      access: "public",
      tag: "next",
    },
    files: ["src", "schemas", "examples", "README.md", "LICENSE"],
    scripts: {
      prepack: "node -e \"require('fs').writeFileSync('UNEXPECTED', 'ran')\"",
    },
  };
  const files = {
    "package.json": JSON.stringify(manifest),
    LICENSE: "Synthetic test fixture license.\n",
    "README.md": "Fixture documentation.\n",
    "src/cli.ts": "#!/usr/bin/env bun\nconsole.log('READY');\n",
    "schemas/run-evidence-v1.schema.json": "{}\n",
    "schemas/report-v1.schema.json": "{}\n",
    "examples/basic/graded.json": "{}\n",
    "examples/basic/prompt-only.json": "{}\n",
    "tests/private.txt": "not part of the package\n",
  };
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(source, path);
    await mkdir(resolve(absolute, ".."), { recursive: true });
    await writeFile(absolute, content);
  }
  return { root, source, command, output, manifest };
}

async function invoke(command: string, args: string[]) {
  const child = Bun.spawn([process.execPath, command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("scoped package installation retains the sevro command and release provenance", async () => {
  const checked = await invoke(
    resolve(import.meta.dir, "../scripts/verify-package-install.ts"),
    [],
  );
  expect(checked.code, checked.stderr).toBe(0);
}, 60_000);

test.each(["next", "latest"])(
  "release preparation retains a real tarball, identity, inventory, and checksums (%s)",
  async (distTag) => {
    const { source, command, output, manifest } = await fixture();
    manifest.publishConfig.tag = distTag;
    await writeFile(join(source, "package.json"), JSON.stringify(manifest));
    const run = await invoke(command, [
      "--tag",
      "v0.1.0-rc.1",
      "--output",
      output,
    ]);
    expect(run.code, run.stderr).toBe(0);
    const release = JSON.parse(run.stdout);
    const archive = join(output, "bjoernrochel-sevro-0.1.0-rc.1.tgz");
    const bytes = await readFile(archive);
    expect(release).toMatchObject({
      format: "sevro.release.v1",
      name: "@bjoernrochel/sevro",
      version: "0.1.0-rc.1",
      releaseTag: "v0.1.0-rc.1",
      distTag,
      archive,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    });
    expect(release.runtimes.node).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(release.runtimes.npm).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      JSON.parse(await readFile(join(output, "release.json"), "utf8")),
    ).toEqual(release);
    expect(await readFile(join(output, "SHA256SUMS"), "utf8")).toBe(
      `${release.sha256}  bjoernrochel-sevro-0.1.0-rc.1.tgz\n`,
    );
    expect(release.files.map((file: { path: string }) => file.path)).toContain(
      "LICENSE",
    );
    expect(
      release.files.map((file: { path: string }) => file.path),
    ).not.toContain("tests/private.txt");
    expect(existsSync(join(source, "UNEXPECTED"))).toBe(false);
    expect(existsSync(join(source, ".git"))).toBe(false);
    const repeated = await invoke(command, [
      "--tag",
      "v0.1.0-rc.1",
      "--output",
      output,
    ]);
    expect(repeated.code).toBe(1);
    expect(await readFile(archive)).toEqual(bytes);
  },
);

test.each([
  "development",
  "tag",
  "license",
  "distribution-tag",
  "repository",
  "relative",
])(
  "release preparation refuses invalid %s configuration before producing artifacts",
  async (kind) => {
    const { source, command, output, manifest } = await fixture();
    if (kind === "development") manifest.version = "0.1.0-dev.0";
    if (kind === "license") manifest.license = "UNLICENSED";
    if (kind === "distribution-tag") manifest.publishConfig.tag = "unsupported";
    if (kind === "repository")
      manifest.repository.url = "git+https://github.com/another/project.git";
    await writeFile(join(source, "package.json"), JSON.stringify(manifest));
    const run = await invoke(command, [
      "--tag",
      kind === "tag" ? "v9.0.0" : `v${manifest.version}`,
      "--output",
      kind === "relative" ? "relative-release" : output,
    ]);
    expect(run.code, run.stderr).toBe(1);
    expect(run.stdout).toBe("");
    expect(existsSync(output)).toBe(false);
  },
);

test("release preparation refuses missing runtime assets without leaving a candidate", async () => {
  const { source, command, output } = await fixture();
  await rm(join(source, "schemas/report-v1.schema.json"));
  const run = await invoke(command, [
    "--tag",
    "v0.1.0-rc.1",
    "--output",
    output,
  ]);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(
    "release is missing schemas/report-v1.schema.json",
  );
  expect(existsSync(output)).toBe(false);
});

test("release preparation refuses unexpected root files despite a permitted prefix", async () => {
  const { source, command, output, manifest } = await fixture();
  manifest.files.push("LICENSE.extra");
  await writeFile(join(source, "LICENSE.extra"), "unexpected root file\n");
  await writeFile(join(source, "package.json"), JSON.stringify(manifest));
  const run = await invoke(command, [
    "--tag",
    "v0.1.0-rc.1",
    "--output",
    output,
  ]);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("files outside the package contract");
  expect(existsSync(output)).toBe(false);
});

test("the package installation gate rejects a different candidate version", async () => {
  const { source, command, output, manifest } = await fixture();
  manifest.version = "9.8.7-rc.1";
  await writeFile(join(source, "package.json"), JSON.stringify(manifest));
  const prepared = await invoke(command, [
    "--tag",
    "v9.8.7-rc.1",
    "--output",
    output,
  ]);
  expect(prepared.code, prepared.stderr).toBe(0);
  const archive = join(output, "bjoernrochel-sevro-9.8.7-rc.1.tgz");
  const original = await readFile(archive);
  const checked = await invoke(
    resolve(import.meta.dir, "../scripts/verify-package-install.ts"),
    ["--tarball", archive],
  );
  expect(checked.code).toBe(1);
  expect(checked.stderr).toContain(
    "installed package identity differs from source metadata",
  );
  expect(await readFile(archive)).toEqual(original);
});
