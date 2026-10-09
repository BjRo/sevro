import { afterEach, expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir, "..");
const roots: string[] = [];
const before = "# Install\n\nHistorical `0.1.0-rc.2`.\n\n";
const after = "\n## Update\n\nMinimum `0.1.0-rc.3`.\n";
const stale =
  before +
  "<!-- sevro-current-release:start -->\n## Current release\n\nVersion `0.1.0-rc.3`.\n\n```sh\nbun add --exact @bjoernrochel/sevro@0.1.0-rc.3\n```\n<!-- sevro-current-release:end -->\n" +
  after;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(version = "0.1.0-rc.4") {
  const root = await mkdtemp(join(tmpdir(), "sevro-release-docs-"));
  roots.push(root);
  await cp(join(source, "scripts"), join(root, "scripts"), {
    recursive: true,
    filter: (path) => !path.endsWith(".md"),
  });
  await mkdir(join(root, "src"));
  await cp(
    join(source, "src/value-guards.ts"),
    join(root, "src/value-guards.ts"),
  );
  await symlink(join(source, "node_modules"), join(root, "node_modules"));
  const manifest: unknown = JSON.parse(
    await readFile(join(source, "package.json"), "utf8"),
  );
  if (typeof manifest !== "object" || manifest === null)
    throw new Error("Expected manifest");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ ...manifest, version }),
  );
  for (const directory of [
    "docs",
    ".agents/skills/sevro-guide/evals",
    ".claude/skills/sevro-guide",
  ]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, "docs/installing.md"), stale);
  await writeFile(
    join(root, ".agents/skills/sevro-guide/SKILL.md"),
    "# Guide\n",
  );
  await writeFile(
    join(root, ".claude/skills/sevro-guide/SKILL.md"),
    "# Guide\n",
  );
  await writeFile(
    join(root, ".agents/skills/sevro-guide/evals/inventory.json"),
    '{"questions":[]}',
  );
  await writeFile(
    join(root, ".agents/skills/sevro-guide/evals/cases.json"),
    "[]",
  );
  return root;
}

async function invoke(root: string, command: string, args: string[] = []) {
  const child = Bun.spawn([process.execPath, "run", command, ...args], {
    cwd: root,
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

test("check:docs refuses stale current release without mutation", async () => {
  const root = await fixture();
  const result = await invoke(root, "check:docs");
  expect(result.stderr).toContain(
    "Current release is stale; run bun run docs:sync",
  );
  expect(result.code).toBe(1);
  expect(await readFile(join(root, "docs/installing.md"), "utf8")).toBe(stale);
});

test("docs:sync installs rc.4 and preserves surrounding historical bytes", async () => {
  const root = await fixture();
  const result = await invoke(root, "docs:sync");
  expect(result.code, result.stderr).toBe(0);
  const content = await readFile(join(root, "docs/installing.md"), "utf8");
  expect(content).toBe(
    before +
      "<!-- sevro-current-release:start -->\n\n## Current release\n\nThe current release is `0.1.0-rc.4`. Install this exact version:\n\n```sh\nbun add --exact @bjoernrochel/sevro@0.1.0-rc.4\n```\n\n<!-- sevro-current-release:end -->\n" +
      after,
  );
  expect((await invoke(root, "check:docs")).code).toBe(0);
});

test.each(["missing", "duplicate", "reversed"])(
  "release commands refuse %s section without writing",
  async (kind) => {
    const root = await fixture();
    const sections: Record<string, string> = {
      missing: before + after,
      duplicate: stale + stale,
      reversed:
        "<!-- sevro-current-release:end -->\n<!-- sevro-current-release:start -->\n",
    };
    const content = sections[kind];
    if (!content) throw new Error("Expected fixture");
    const path = join(root, "docs/installing.md");
    await writeFile(path, content);
    for (const command of ["docs:sync", "check:docs"]) {
      const result = await invoke(root, command);
      expect(result.stderr).toContain(
        "Expected exactly one ordered Current release section",
      );
      expect(result.code).toBe(1);
      expect(await readFile(path, "utf8")).toBe(content);
    }
  },
);

test.each([
  "1.2",
  "01.2.3",
  "1.2.3-rc.01",
  "1.2.3\nbun remove anything",
  "",
  "../release",
])(
  "release commands refuse invalid manifest version %j without writing",
  async (version) => {
    const root = await fixture(version);
    for (const command of ["docs:sync", "check:docs"]) {
      const result = await invoke(root, command);
      expect(result.stderr).toContain(
        "package.json.version must be a valid semantic version",
      );
      expect(result.code).toBe(1);
      expect(await readFile(join(root, "docs/installing.md"), "utf8")).toBe(
        stale,
      );
    }
  },
);

test("docs:sync supports stable versions and repeats without byte changes", async () => {
  const root = await fixture("1.2.3");
  expect((await invoke(root, "docs:sync")).code).toBe(0);
  const path = join(root, "docs/installing.md");
  const first = await readFile(path, "utf8");
  expect(first).toContain("bun add --exact @bjoernrochel/sevro@1.2.3\n");
  expect(first.startsWith(before)).toBe(true);
  expect(first.endsWith(after)).toBe(true);
  expect((await invoke(root, "docs:sync")).code).toBe(0);
  expect(await readFile(path, "utf8")).toBe(first);
  expect((await invoke(root, "check:docs")).code).toBe(0);
});

test("package validation refuses stale documentation", async () => {
  const root = await fixture("0.1.0-rc.3");
  for (const directory of ["src", "schemas", "examples"]) {
    await cp(join(source, directory), join(root, directory), {
      recursive: true,
    });
  }
  for (const file of ["README.md", "LICENSE", "CONTRIBUTING.md"]) {
    await cp(join(source, file), join(root, file));
  }
  const result = await invoke(root, "test:package-install");
  expect(result.stderr).toContain(
    "Current release is stale; run bun run docs:sync",
  );
  expect(result.code).toBe(1);
  expect(await readFile(join(root, "docs/installing.md"), "utf8")).toBe(stale);
}, 60000);

test("package validation checks the supplied artifact's current release", async () => {
  const root = await fixture("0.1.0-rc.3");
  for (const directory of ["src", "schemas", "examples"]) {
    await cp(join(source, directory), join(root, directory), {
      recursive: true,
    });
  }
  for (const file of ["README.md", "LICENSE", "CONTRIBUTING.md"]) {
    await cp(join(source, file), join(root, file));
  }
  const packed = Bun.spawn(["npm", "pack", "--ignore-scripts", "--silent"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [archiveName, diagnostic, code] = await Promise.all([
    new Response(packed.stdout).text(),
    new Response(packed.stderr).text(),
    packed.exited,
  ]);
  expect(code, diagnostic).toBe(0);
  expect((await invoke(root, "docs:sync")).code).toBe(0);
  const archive = join(root, archiveName.trim());
  const bytes = await readFile(archive);
  const result = await invoke(root, "test:package-install", [
    "--tarball",
    archive,
  ]);
  expect(result.stderr).toContain(
    "Current release is stale; run bun run docs:sync",
  );
  expect(result.code).toBe(1);
  expect(await readFile(archive)).toEqual(bytes);
}, 60000);
