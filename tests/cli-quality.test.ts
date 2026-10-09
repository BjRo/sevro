import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, access, readFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import baseline from "../examples/basic/graded.json";
import {
  defined,
  number,
  parseCliResult,
  parseRecord,
  parseRunEvidence,
  string,
} from "./fixtures/assertions";
import { extensionFixtureCommand } from "./fixtures/extension-command";
import { wireCase, wireOptions } from "./fixtures/quality-engine-session";

const extensionCommand = extensionFixtureCommand();

const invalidCases = [
  ["empty id", { ...baseline, id: "" }],
  ["empty prompt", { ...baseline, prompt: "" }],
  ["blank continuation", { ...baseline, followUpPrompt: "  " }],
  ["nonstring continuation", { ...baseline, followUpPrompt: 42 }],
  ["null fixture", { ...baseline, fixture: null }],
  ["array fixture", { ...baseline, fixture: [] }],
  [
    "unknown fixture kind",
    { ...baseline, fixture: { kind: "unknown", files: {} } },
  ],
  [
    "nonstring inline contents",
    { ...baseline, fixture: { files: { "file.txt": 42 } } },
  ],
  ["missing inline files", { ...baseline, fixture: {} }],
  [
    "malformed generated commits",
    { ...baseline, fixture: { kind: "generated", commits: "invalid" } },
  ],
  [
    "unsafe generated path",
    {
      ...baseline,
      fixture: {
        kind: "generated",
        commits: [],
        files: { ".git/config": "override" },
      },
    },
  ],
  [
    "malformed repository reference",
    { ...baseline, fixture: { sourceRef: 42 } },
  ],
  ["null checks", { ...baseline, checks: null }],
  ["nonobject check", { ...baseline, checks: [null] }],
  [
    "nonobject check configuration",
    { ...baseline, checks: [{ id: "x", grader: "sevro.regex", cfg: [] }] },
  ],
  ["nonstring required evidence", { ...baseline, requiredEvidence: [42] }],
] as const;

function runArguments(root: string, caseFile: string): string[] {
  return [
    "run",
    "--json",
    "--case-file",
    caseFile,
    "--adapter-module",
    resolve(import.meta.dir, "fixtures/quality-cli-host.ts"),
    "--project-root",
    root,
    "--results-root",
    join(root, "results"),
    "--condition",
    "passive",
    "--trials",
    "1",
    "--threshold",
    "1",
  ];
}

async function invoke(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, result: parseCliResult(stdout), stderr };
}

async function refuse(
  root: string,
  args: string[],
  diagnostic: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const child = await invoke(args, env);
  expect(child.code).toBe(64);
  expect(child.result.execution.status).toBe("not_run");
  expect(child.result.cases).toEqual([]);
  expect(child.result.evidencePath).toBeNull();
  expect(child.result.diagnostic?.message).toContain(diagnostic);
  expect(
    await access(join(root, "results")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
}

test.each(invalidCases)(
  "CLI rejects malformed case %s before host execution or run storage",
  async (_, value) => {
    const root = await mkdtemp(join(tmpdir(), "sevro-cli-quality-"));
    try {
      const file = join(root, "case.json");
      await writeFile(file, JSON.stringify(value));
      await refuse(
        root,
        runArguments(root, file),
        "resolved case file is unreadable or invalid",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  "id",
  "model",
  "effort",
  "run",
  "instrumentation",
  "capabilityType",
  "capabilityNamespace",
  "capabilityDuplicate",
])(
  "CLI refuses malformed adapter %s at its public module boundary",
  async (variant) => {
    const root = await mkdtemp(join(tmpdir(), "sevro-cli-adapter-"));
    try {
      const file = join(root, "case.json");
      await writeFile(file, JSON.stringify(baseline));
      const args = runArguments(root, file);
      const index = args.indexOf("--adapter-module");
      args[index + 1] = resolve(
        import.meta.dir,
        "fixtures/quality-cli-invalid-host.ts",
      );
      await refuse(root, args, "host adapter", {
        ...process.env,
        SEVRO_QUALITY_INVALID_ADAPTER: variant,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

function extensionArguments(root: string): string[] {
  const args = runArguments(root, join(root, "unused-case.json"));
  args.splice(args.indexOf("--case-file"), 2);
  return [
    ...args,
    "--extension-command-file",
    join(root, "command.json"),
    "--extension-source-file",
    resolve(import.meta.dir, "fixtures/extension.ts"),
    "--case-id",
    "extension-case",
  ];
}

async function setupCancellationArguments(root: string): Promise<string[]> {
  const setupCode = `
    const fs = require("node:fs"), path = require("node:path");
    const root = process.argv[1];
    fs.writeFileSync(path.join(root, "setup-ready.tmp"), JSON.stringify({pid: process.pid, workspace: process.cwd(), home: process.env.HOME, lang: process.env.LANG}));
    fs.renameSync(path.join(root, "setup-ready.tmp"), path.join(root, "setup-ready.json"));
    setInterval(() => {}, 1000);
  `;
  const configured = wireOptions({
    describe: {
      extension: { id: "example.extension", version: "1.0.0" },
      protocols: ["sevro.extension.v1"],
      requiredCapabilities: ["sevro.fixture.setup"],
      optionalCapabilities: [],
      graders: ["example.extension"],
      taskVerdictPolicies: [],
    },
    resolve: {
      cases: [
        {
          ...wireCase,
          fixture: {
            kind: "generated",
            commits: [
              {
                message: "Setup baseline",
                files: { "README.md": "baseline\n" },
              },
            ],
          },
        },
      ],
    },
    prepare: {
      artifacts: [],
      requestedInstrumentation: [],
      fixtureSetup: { command: [process.execPath, "-e", setupCode, root] },
      extensionData: {},
    },
  });
  await writeFile(
    join(root, "command.json"),
    JSON.stringify(configured.command),
  );
  const adapter = join(root, "adapter.ts");
  await writeFile(
    adapter,
    `
    import { writeFileSync } from "node:fs";
    export default { id: "example.host", model: "fixture", effort: "none", run: async () => {
      writeFileSync(${JSON.stringify(join(root, "candidate-called"))}, "called");
      return { finalMessage: "ready", complete: true };
    } };
  `,
  );
  const args = extensionArguments(root);
  args[args.indexOf("--adapter-module") + 1] = adapter;
  args[args.indexOf("--extension-source-file") + 1] = resolve(
    import.meta.dir,
    "fixtures/quality-engine-extension.ts",
  );
  args[args.indexOf("--case-id") + 1] = wireCase.id;
  return [
    ...args,
    "--runner-build-digest",
    "a".repeat(64),
    "--project-digest",
    "b".repeat(64),
  ];
}

async function interruptReadyCli(
  root: string,
  args: string[],
  signal: "SIGINT" | "SIGTERM",
) {
  const ready = Promise.withResolvers<undefined>();
  const observer = watch(root, (_event, name) => {
    if (name === "setup-ready.json") ready.resolve(undefined);
  });
  const poll = setInterval(() => {
    if (existsSync(join(root, "setup-ready.json"))) ready.resolve(undefined);
  }, 20);
  const timer = setTimeout(() => {
    ready.reject(new Error("Setup readiness was not published"));
  }, 5000);
  const env = { ...process.env };
  delete env.LANG;
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  try {
    await Promise.race([
      ready.promise,
      child.exited.then(() => {
        throw new Error("CLI exited before setup readiness");
      }),
    ]);
    const receipt = parseRecord(
      await readFile(join(root, "setup-ready.json"), "utf8"),
    );
    child.kill(signal);
    const [out, err, code] = await Promise.all([stdout, stderr, child.exited]);
    return { result: parseCliResult(out), stderr: err, code, receipt };
  } finally {
    observer.close();
    clearInterval(poll);
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
  }
}

test.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)(
  "public CLI %s during trusted fixture setup retains a cancelled trial before candidate admission",
  async (signal, exitCode) => {
    const root = await mkdtemp(join(tmpdir(), "sevro-cli-setup-interrupt-"));
    try {
      const run = await interruptReadyCli(
        root,
        await setupCancellationArguments(root),
        signal,
      );
      expect(run.code).toBe(exitCode);
      expect(run.result.execution.status).toBe("cancelled");
      expect(run.result.grading.status).toBe("not_requested");
      expect(run.result.task.verdict).toBe("not_assessed");
      expect(run.receipt.lang).toBe("C");
      expect(
        await Bun.file(join(root, "candidate-called")).exists(),
      ).toBeFalse();
      expect(() => process.kill(number(run.receipt.pid), 0)).toThrow();
      const evidence = parseRunEvidence(
        await readFile(defined(run.result.evidencePath), "utf8"),
      );
      expect(evidence.result.exitCode).toBe(exitCode);
      expect(evidence.trials).toHaveLength(1);
      expect(
        defined(defined(evidence.result.cases[0]).trials[0]).execution.status,
      ).toBe("cancelled");
      expect(
        await Bun.file(
          join(string(run.receipt.workspace), "README.md"),
        ).exists(),
      ).toBeFalse();
      expect(
        await access(string(run.receipt.home)).then(
          () => true,
          () => false,
        ),
      ).toBeFalse();
      const checkpoint = parseRecord(
        await readFile(
          join(root, "results", defined(run.result.runId), "checkpoint.json"),
          "utf8",
        ),
      );
      expect(checkpoint.completedTrials).toHaveLength(1);
      const active = parseRecord(
        await readFile(
          join(root, "results", "active", `${defined(run.result.runId)}.json`),
          "utf8",
        ),
      );
      expect(active.status).toBe("interrupted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  ["condition", "other", "invalid --condition"],
  ["threshold", "NaN", "invalid --threshold"],
  ["threshold", "0", "invalid --threshold"],
  ["threshold", "1.01", "invalid --threshold"],
  ["runner-build-digest", "a".repeat(63), "64-character SHA-256 digest"],
  ["project-digest", "g".repeat(64), "64-character SHA-256 digest"],
  [
    "case-id",
    "example-case",
    "extension options require --extension-command-file",
  ],
  ["case-source-root", "/sources", "case sources require a root and map file"],
  ["task-verdict-policy", "unqualified", "invalid --task-verdict-policy"],
  ["replace-builtin-grader", "unqualified", "invalid --replace-builtin-grader"],
  ["claude-uv-cache-dir", "/cache", "Claude options require --host claude"],
  ["host", "unsupported", "unsupported --host"],
  ["protected-root", "relative", "--protected-root must be absolute"],
] as const)(
  "CLI refuses invalid --%s=%s before input loading or host execution",
  async (option, value, diagnostic) => {
    const root = await mkdtemp(join(tmpdir(), "sevro-cli-options-"));
    try {
      const args = runArguments(root, join(root, "unread-case.json"));
      const index = args.indexOf(`--${option}`);
      if (index < 0) args.push(`--${option}`, value);
      else args[index + 1] = value;
      await refuse(root, args, diagnostic);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  [
    "malformed JSON",
    "{broken",
    "extension command file is unreadable or invalid",
  ],
  ["object", "{}", "extension command must be an absolute argv array"],
  ["null", "null", "extension command must be an absolute argv array"],
  ["empty argv", "[]", "extension command must be an absolute argv array"],
  [
    "relative binary",
    '["relative-bun"]',
    "extension command must be an absolute argv array",
  ],
  [
    "nonstring argument",
    '["/missing/bun",42]',
    "extension command must be an absolute argv array",
  ],
  [
    "empty argument",
    '["/missing/bun",""]',
    "extension command must be an absolute argv array",
  ],
] as const)(
  "CLI refuses extension command %s before negotiation or storage",
  async (_, command, diagnostic) => {
    const root = await mkdtemp(join(tmpdir(), "sevro-cli-extension-command-"));
    try {
      await writeFile(join(root, "command.json"), command);
      await refuse(root, extensionArguments(root), diagnostic);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  [
    "private object",
    "[]",
    "{}",
    "extension configuration must be JSON objects",
  ],
  [
    "private null",
    "null",
    "{}",
    "extension configuration must be JSON objects",
  ],
  [
    "redacted object",
    "{}",
    "[]",
    "extension configuration must be JSON objects",
  ],
  [
    "redacted null",
    "{}",
    "null",
    "extension configuration must be JSON objects",
  ],
  [
    "private JSON",
    "{broken",
    "{}",
    "extension configuration file is unreadable or invalid",
  ],
  [
    "redacted JSON",
    "{}",
    "{broken",
    "redacted extension configuration file is unreadable or invalid",
  ],
] as const)(
  "CLI refuses invalid extension %s before negotiation or storage",
  async (_, configuration, redacted, diagnostic) => {
    const root = await mkdtemp(join(tmpdir(), "sevro-cli-extension-config-"));
    try {
      await writeFile(
        join(root, "command.json"),
        JSON.stringify([process.execPath]),
      );
      await writeFile(join(root, "private.json"), configuration);
      await writeFile(join(root, "redacted.json"), redacted);
      await refuse(
        root,
        [
          ...extensionArguments(root),
          "--extension-configuration-file",
          join(root, "private.json"),
          "--extension-redacted-configuration-file",
          join(root, "redacted.json"),
        ],
        diagnostic,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("CLI refuses an unresolved extension case before host execution or storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-cli-extension-selection-"));
  try {
    await writeFile(
      join(root, "command.json"),
      JSON.stringify(
        extensionCommand(
          resolve(import.meta.dir, "fixtures/extension.ts"),
          "lifecycle",
        ),
      ),
    );
    const args = extensionArguments(root);
    args[args.indexOf("--case-id") + 1] = "unresolved-case";
    await refuse(root, args, "extension did not resolve the selected case");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI human output retains extension domain outcomes independently of task verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-cli-domain-display-"));
  try {
    await writeFile(
      join(root, "command.json"),
      JSON.stringify(
        extensionCommand(
          resolve(import.meta.dir, "fixtures/extension.ts"),
          "lifecycle-domain-outcome",
        ),
      ),
    );
    const args = extensionArguments(root);
    args.splice(args.indexOf("--json"), 1);
    args[args.indexOf("--adapter-module") + 1] = resolve(
      import.meta.dir,
      "fixtures/host-adapter.ts",
    );
    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(
      "execution=completed grading=completed task=passed\n",
    );
    expect(stdout).toContain(
      "domain case=extension-case trial=1 outcome=example.extension.activation status=failed\n",
    );
    const evidencePath = stdout
      .split("\n")
      .find((line) => line.startsWith("evidence="))
      ?.slice("evidence=".length);
    expect(typeof evidencePath).toBe("string");
    if (!evidencePath)
      throw new Error("Human output omitted retained evidence");
    expect(
      await access(evidencePath).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["null", null],
  ["array", []],
  ["foreign URL", { reference: "https://example.com/source" }],
  ["nonstring URL", { reference: 42 }],
] as const)(
  "CLI refuses malformed source maps before admission %s",
  async (_, value) => {
    const root = await mkdtemp(join(tmpdir(), "sevro-cli-source-map-"));
    try {
      const file = join(root, "case.json"),
        map = join(root, "map.json");
      await writeFile(file, JSON.stringify(baseline));
      await writeFile(map, JSON.stringify(value));
      await refuse(
        root,
        [
          ...runArguments(root, file),
          "--case-source-root",
          root,
          "--case-source-map-file",
          map,
        ],
        "case source map must contain file URLs",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
