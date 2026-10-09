import { appendFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = "0.160.1";
const claudeVersion = "2.1.284";
const targets = {
  darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
  linux: { arm64: "aarch64-unknown-linux-musl", x64: "x86_64-unknown-linux-musl" },
};
const target = (targets as Record<string, Record<string, string>>)[process.platform]?.[
  process.arch
];
if (!target)
  throw new Error("CI native host setup requires macOS or Linux arm64 or x64");
const githubPath = process.env.GITHUB_PATH;
const githubEnv = process.env.GITHUB_ENV;
if (!githubPath || !githubEnv)
  throw new Error("CI sandbox setup requires GITHUB_PATH and GITHUB_ENV");

// Hosted runner homes and tool caches are protected from candidate commands.
const root = await mkdtemp(
  join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "sevro-ci-"),
);
try {
  const prefix = join(root, "tools");
  const temporary = join(root, "tmp");
  await mkdir(temporary);
  const install = Bun.spawn(
    [
      "npm",
      "install",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `@openai/codex@${version}`,
      `@anthropic-ai/claude-code@${claudeVersion}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await install.exited) !== 0) throw new Error("CI Codex install failed");
  const bin = join(
    prefix,
    "node_modules/@openai",
    `codex-${process.platform}-${process.arch}`,
    "vendor",
    target,
    "bin",
  );
  const binary = join(bin, "codex");
  if (!(await stat(binary)).isFile())
    throw new Error("CI Codex native executable is missing");
  const checked = Bun.spawn([binary, "--version"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const [output, code] = await Promise.all([
    new Response(checked.stdout).text(),
    checked.exited,
  ]);
  if (code !== 0 || output.trim() !== `codex-cli ${version}`)
    throw new Error("CI Codex native version differs from the pinned version");
  // Expose the native executable: the npm launcher needs Node inside the sandbox.
  await appendFile(githubPath, `${bin}\n`);
  const claudeBin = join(
    prefix,
    "node_modules/@anthropic-ai",
    `claude-code-${process.platform}-${process.arch}`,
  );
  await checkClaudeVersion(join(claudeBin, "claude"));
  await appendFile(githubPath, `${claudeBin}\n`);
  await appendFile(githubEnv, `TMPDIR=${temporary}\n`);
  console.log(`${output.trim()} installed at ${binary}`);
} catch (error) {
  await rm(root, { recursive: true, force: true });
  throw error;
}

async function checkClaudeVersion(binary: string): Promise<void> {
  if (!(await stat(binary)).isFile())
    throw new Error("CI Claude native executable is missing");
  const child = Bun.spawn([binary, "--version"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const [output, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (code !== 0 || output.trim() !== `${claudeVersion} (Claude Code)`)
    throw new Error("CI Claude native version differs from the pinned version");
  console.log(`${output.trim()} installed at ${binary}`);
}
