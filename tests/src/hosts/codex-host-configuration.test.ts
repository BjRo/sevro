import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCodexHost } from "../../../src/hosts/codex";
import {
  alterMarketplace,
  fixture,
  isolatedNativeHost,
  ordinaryCodexOptions,
  ordinaryCodexRequest,
  ordinaryMarketplace,
} from "../../fixtures/codex-host";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test.each([
  { label: "relative executable", change: { binary: "codex" } },
  { label: "relative authentication", change: { authFile: "auth.json" } },
  { label: "missing model", change: { model: "" } },
  { label: "missing effort", change: { effort: "" } },
  { label: "zero timeout", change: { timeoutMs: 0 } },
  { label: "fractional timeout", change: { timeoutMs: 1.5 } },
  { label: "overlong timeout", change: { timeoutMs: 30 * 60_000 + 1 } },
  { label: "zero concurrency", change: { agentConcurrencyLimit: 0 } },
  { label: "fractional concurrency", change: { agentConcurrencyLimit: 1.5 } },
  {
    label: "unsafe concurrency",
    change: { agentConcurrencyLimit: Number.MAX_SAFE_INTEGER + 1 },
  },
])("Codex host refuses $label configuration", ({ change }) => {
  expect(() => createCodexHost({ ...ordinaryCodexOptions, ...change })).toThrow(
    "invalid Codex host configuration",
  );
});

test("Codex state opt-in still refuses a configuration path that is a file", async () => {
  if (!isolatedNativeHost || !Bun.which("codex")) return;
  const { host, request } = await ordinaryCodexRequest(roots);
  await writeFile(join(request.workspace, ".codex"), "not a directory");
  expect(
    host.run({
      ...request,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        codexState: true,
      },
    }),
  ).rejects.toThrow("fixture Codex configuration must be a physical directory");
});

test.each([
  ["duplicate plugin names", "invalid Codex marketplace declaration"],
  ["invalid plugin name", "invalid Codex marketplace declaration"],
  ["duplicate artifact paths", "invalid Codex marketplace declaration"],
  ["artifact outside declared root", "invalid Codex marketplace declaration"],
  ["unreadable manifest", "Codex marketplace manifest is unreadable"],
  ["malformed manifest", "Codex marketplace manifest is unreadable"],
  ["nonobject manifest", "invalid Codex marketplace manifest"],
  [
    "mismatched manifest",
    "Codex marketplace manifest does not match declaration",
  ],
  [
    "missing declared file",
    "Codex marketplace package is missing declared files",
  ],
  ["linked package file", "Codex marketplace package contains a symlink"],
  ["relocated package root", "Codex marketplace escapes the workspace"],
])(
  "Codex marketplace refuses %s before model execution",
  async (kind, diagnostic) => {
    const selected = await ordinaryMarketplace(roots);
    await alterMarketplace(roots, selected, kind);
    expect(
      selected.host.run({
        ...selected.request,
        codexMarketplace: selected.declaration,
      }),
    ).rejects.toThrow(diagnostic);
    expect(readFile(join(selected.workspace, "argv.txt"))).rejects.toThrow();
  },
);

test("Codex installed plugin refuses an invoked skill missing from its declared package", async () => {
  if (!isolatedNativeHost || !Bun.which("codex")) return;
  const selected = await ordinaryMarketplace(roots);
  expect(
    selected.host.run({
      ...selected.request,
      prompt: "Use $probe:absent and return ready.",
      codexMarketplace: selected.declaration,
      explicitSkillInvocation: {
        pluginName: "probe",
        skillName: "absent",
        token: "$probe:absent",
      },
    }),
  ).rejects.toThrow("invoked Codex skill is absent from the installation");
  expect(readFile(join(selected.workspace, "argv.txt"))).rejects.toThrow();
});

test.each(["missing", "directory", "oversized"])(
  "Codex selected authentication %s refuses execution without fallback",
  async (kind) => {
    const selected = await ordinaryCodexRequest(roots);
    if (kind === "oversized")
      await writeFile(selected.paths.authFile, "x".repeat(1024 * 1024 + 1));
    else {
      await rm(selected.paths.authFile);
      if (kind === "directory") await mkdir(selected.paths.authFile);
    }
    expect(selected.host.run(selected.request)).rejects.toThrow(
      "Codex auth file is unreadable or oversized",
    );
    expect(readFile(join(selected.workspace, "argv.txt"))).rejects.toThrow();
  },
);

test.each([
  ["empty follow-up", "Codex follow-up prompt must be nonempty"],
  ["whitespace follow-up", "Codex follow-up prompt must be nonempty"],
  [
    "unsupported instrumentation",
    "Codex enforcement instrumentation is unavailable",
  ],
  ["external fixture tools", "fixture binary path is outside the workspace"],
  ["fixture configuration", "fixture Codex configuration is unsupported"],
])(
  "Codex request refuses %s before candidate launch",
  async (kind, diagnostic) => {
    const selected = await ordinaryCodexRequest(roots);
    const request: Parameters<typeof selected.host.run>[0] = {
      ...selected.request,
    };
    switch (kind) {
      case "empty follow-up":
        request.followUpPrompt = "";
        break;
      case "whitespace follow-up":
        request.followUpPrompt = " \n\t";
        break;
      case "unsupported instrumentation":
        request.instrumentation = [
          { id: "example.enforcement", configuration: {} },
        ];
        break;
      case "external fixture tools":
        request.fixtureBinDir = join(selected.workspace, "tools");
        break;
      default:
        await mkdir(join(selected.workspace, ".codex"));
    }
    expect(selected.host.run(request)).rejects.toThrow(diagnostic);
    expect(readFile(join(selected.workspace, "argv.txt"))).rejects.toThrow();
  },
);

test("CLI refuses a Codex configuration directory that is a regular file", async () => {
  const paths = await fixture(roots);
  await writeFile(
    join(paths.projectRoot, ".codex"),
    "ordinary configuration mistake",
  );
  const repo = resolve(import.meta.dir, "../../..");
  const child = Bun.spawnSync(
    [
      process.execPath,
      join(repo, "src/cli.ts"),
      "run",
      "--json",
      "--dry",
      "--case-file",
      join(repo, "examples/basic/prompt-only.json"),
      "--host",
      "codex",
      "--codex-bin",
      paths.fakeBinary,
      "--codex-auth-file",
      paths.authFile,
      "--model",
      "synthetic-codex",
      "--effort",
      "low",
      "--project-root",
      paths.projectRoot,
      "--results-root",
      paths.resultsRoot,
      "--condition",
      "passive",
      "--trials",
      "1",
      "--threshold",
      "1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(child.exitCode).toBe(64);
  expect(child.stdout.toString()).toContain("Cannot read Codex configuration:");
});

test.each([{ roles: [] }, { roles: ["candidate", "candidate"] }] as const)(
  "Codex refuses invalid programmatic seed role selection $roles",
  async ({ roles }) => {
    const selected = await ordinaryCodexRequest(roots);
    expect(
      selected.host.run({
        ...selected.request,
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
          seeds: [
            {
              source: selected.paths.projectRoot,
              target: "cache",
              sha256: "a".repeat(64),
              roles: [...roles],
            },
          ],
        },
      }),
    ).rejects.toThrow("runtime seed roles are invalid");
  },
);
