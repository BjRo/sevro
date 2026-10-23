import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "../fixtures/cli-fixtures";
import { version } from "../../package.json";
import { RUN_OPTIONS } from "../../src/cli/run-options";

async function information(args: string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "sevro-cli-help-"));
  try {
    const child = Bun.spawn([process.execPath, cli, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(await readdir(cwd)).toEqual([]);
    return { stdout, stderr, code };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test.each([[], ["--help"], ["-h"], ["help"]].map((args) => ({ args })))(
  "CLI top-level help %j leads with common examples without preparing a run",
  async ({ args }) => {
    const result = await information(args);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: sevro");
    expect(result.stdout).toContain("sevro run --case-file");
    expect(result.stdout).toContain("sevro report --result-file");
    expect(result.stdout.indexOf("Examples:")).toBeLessThan(
      result.stdout.indexOf("Commands:"),
    );
    expect(result.stdout).toContain("sevro run --help");
    expect(result.stdout).toContain("--version");
  },
);

test.each(["run", "demo", "init", "report", "prune"])(
  "CLI command help after options bypasses input loading: %s",
  async (command) => {
    for (const flag of ["--help", "-h"]) {
      const result = await information([
        command,
        "--run-manifest-file",
        "missing.json",
        flag,
        "--json",
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`Usage: sevro ${command}`);
    }
  },
);

test("CLI demo recovery hint points to demo help", async () => {
  const result = await information(["demo", "--invalid", "--json"]);
  expect(result.code).toBe(64);
  expect(result.stderr).toContain("Run sevro demo --help");
  expect(result.stderr).not.toContain("sevro run --help");
});

test.each(
  [
    ["run", "--help"],
    ["run", "-h"],
    ["help", "run"],
  ].map((args) => ({ args })),
)(
  "CLI run help %j explains required options and defaults",
  async ({ args }) => {
    const result = await information(args);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.indexOf("Examples:")).toBeLessThan(
      result.stdout.indexOf("Required:"),
    );
    for (const option of Object.keys(RUN_OPTIONS))
      expect(result.stdout).toContain(`--${option}`);
    expect(result.stdout).toContain("--jobs <integer> (default: 3)");
    expect(result.stdout).toContain(
      "--config-root <path> (default: --project-root)",
    );
    expect(result.stdout).toContain(
      "--run-state-root <path> (default: --results-root)",
    );
    expect(result.stdout).toContain(
      "Relative run paths resolve from the current directory",
    );
    expect(result.stdout).toContain("--dry");
    expect(result.stdout).toContain("--json");
  },
);

test.each(
  [
    ["report", "--help"],
    ["report", "-h"],
    ["help", "report"],
  ].map((args) => ({ args })),
)(
  "CLI report help %j gives an example, required inputs and output default",
  async ({ args }) => {
    const result = await information(args);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.indexOf("Examples:")).toBeLessThan(
      result.stdout.indexOf("Required:"),
    );
    expect(result.stdout).toContain("--result-file <path>");
    expect(result.stdout).toContain("absolute");
    expect(result.stdout).toContain("Markdown by default");
    expect(result.stdout).toContain("sevro.report.v1");
  },
);

test.each([["--version"], ["-v"]].map((args) => ({ args })))(
  "CLI version %j reports the installed package version without a run",
  async ({ args }) => {
    const result = await information(args);
    expect(result).toEqual({
      code: 0,
      stderr: "",
      stdout: `sevro ${version}\n`,
    });
  },
);

test.each(
  [
    ["init", "--help"],
    ["init", "-h"],
    ["help", "init"],
  ].map((args) => ({ args })),
)(
  "CLI init help %j explains safe templates without writing files",
  async ({ args }) => {
    const result = await information(args);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("response|repository-skill|coding");
    expect(result.stdout).toContain("refuses existing paths");
    expect(result.stdout).toContain("--codex-auth-file");
    expect(result.stdout).toContain("sevro report --latest");
  },
);

test.each(
  [
    ["demo", "--help"],
    ["demo", "-h"],
    ["help", "demo"],
  ].map((args) => ({ args })),
)(
  "CLI demo help %j explains owned inputs and evidence without preparing a run",
  async ({ args }) => {
    const result = await information(args);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: sevro demo [--json]");
    expect(result.stdout).toContain(".sevro/results");
    expect(result.stdout).toContain("without model credentials");
  },
);

test.each(
  [
    ["prune", "--help"],
    ["prune", "-h"],
    ["help", "prune"],
  ].map((args) => ({ args })),
)(
  "CLI prune help %j explains default and explicit retention without deleting files",
  async ({ args }) => {
    const result = await information(args);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    for (const text of [
      "Usage: sevro prune",
      "10",
      "--older-than",
      "--keep",
      "--latest",
      "--results-root",
    ])
      expect(result.stdout).toContain(text);
  },
);
