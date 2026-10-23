import { syntheticClaudeLogin } from "./fixtures/claude-login";
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  array,
  defined,
  parseCliResult,
  parseRecord,
  parseRunEvidence,
  record,
  string,
} from "./fixtures/assertions";
import { extensionFixtureCommand } from "./fixtures/extension-command";
import { runEvaluation, type HostAdapter } from "../src/engine";
import { createCodexHost } from "../src/hosts/codex";

const roots: string[] = [];
const extensionCommand = extensionFixtureCommand();
const cli = join(import.meta.dir, "../src/cli.ts");
const digest = "a".repeat(64);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("evaluation persists diagnostics while native state still exists", async () => {
  const { root, project, auth, binary } = await executionFailure("exec");
  const marker = join(root, "native-home");
  await writeFile(
    binary,
    '#!/bin/sh\nif [ "$1" = sandbox ]; then exit 0; fi\n' +
      `printf '%s' "$CODEX_HOME" > '${marker}'\nprintf '%s\\n' '{"type":"turn.failed"}'\nexit 31\n`,
    { mode: 0o700 },
  );
  const native = createCodexHost({
    binary,
    authFile: auth,
    model: "synthetic",
    effort: "low",
    projectRoot: project,
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
    retainHostDiagnostics: true,
  });
  let retainedBeforeCleanup = false;
  const host: HostAdapter = {
    ...native,
    async run(request) {
      return native.run({
        ...request,
        async retainHostDiagnostics(bytes) {
          const home = await readFile(marker, "utf8");
          expect(existsSync(home)).toBe(true);
          await defined(request.retainHostDiagnostics)(bytes);
          const results = new Bun.Glob("**/*sevro.host.diagnostics.bin");
          retainedBeforeCleanup =
            (await Array.fromAsync(results.scan(join(root, "results"))))
              .length === 1;
        },
      });
    },
  };
  const outcome = await runEvaluation({
    projectRoot: project,
    resultsRoot: join(root, "results"),
    host,
    case: {
      id: "guide-visual-present",
      prompt: "Return ready.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [],
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(outcome.result.exitCode).toBe(2);
  expect(retainedBeforeCleanup).toBe(true);
  expect(existsSync(await readFile(marker, "utf8"))).toBe(false);
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  expect(
    defined(evidence.trials[0]).artifactRefs.some(
      (ref) => ref.id === "sevro.host.diagnostics",
    ),
  ).toBe(true);
});

async function marketplaceFailure() {
  const root = await mkdtemp(join(tmpdir(), "sevro-host-diagnostics-"));
  roots.push(root);
  const project = join(root, "project");
  await mkdir(project);
  const binary = join(root, "codex");
  const auth = join(root, "auth.json");
  const command = join(root, "extension.json");
  const extension = join(import.meta.dir, "fixtures/extension.ts");
  await writeFile(
    binary,
    "#!/bin/sh\nprintf 'marketplace stdout\\n'\nprintf 'marketplace refused\\n' >&2\nexit 23\n",
    { mode: 0o700 },
  );
  await writeFile(auth, "synthetic");
  await writeFile(
    join(project, "sevro.json"),
    JSON.stringify({ format: "sevro.runtime.v1", nativeTranscripts: true }),
  );
  await writeFile(
    command,
    JSON.stringify(extensionCommand(extension, "lifecycle-codex-marketplace")),
  );
  const args = [
    process.execPath,
    cli,
    "run",
    "--json",
    "--extension-command-file",
    command,
    "--extension-source-file",
    extension,
    "--case-id",
    "extension-case",
    "--host",
    "codex",
    "--codex-bin",
    binary,
    "--codex-auth-file",
    auth,
    "--model",
    "synthetic",
    "--effort",
    "low",
    "--project-root",
    project,
    "--results-root",
    join(root, "results"),
    "--runner-build-digest",
    digest,
    "--project-digest",
    digest,
    "--condition",
    "passive",
    "--trials",
    "1",
    "--threshold",
    "1",
  ];
  return { root, project, auth, binary, args };
}

async function invoke(
  args: string[],
  environment: Record<string, string> = {},
) {
  const process = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...globalThis.process.env, ...environment },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { result: parseCliResult(stdout), stderr, code };
}

async function executionFailure(
  entrypoint: "exec" | "app-server",
  prompt = "Return ready.",
) {
  const fixture = await marketplaceFailure();
  const { args, root, binary } = fixture;
  args.splice(args.indexOf("--extension-command-file"), 6);
  const caseFile = join(root, "case.json");
  await writeFile(
    caseFile,
    JSON.stringify({
      id:
        entrypoint === "exec"
          ? "guide-visual-present"
          : "goal-preflight-high-risk-routine",
      prompt,
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [],
    }),
  );
  args.push("--case-file", caseFile, "--codex-entrypoint", entrypoint);
  await writeFile(
    binary,
    '#!/bin/sh\nif [ "$1" = sandbox ]; then exit 0; fi\n' +
      (entrypoint === "exec"
        ? "printf '%s\\n' '{\"type\":\"turn.failed\"}'\n"
        : "IFS= read -r request\n") +
      "printf 'startup failed\\n' >&2\nexit 31\n",
    { mode: 0o700 },
  );
  return fixture;
}

test("CLI retains marketplace failure diagnostics without a native session", async () => {
  const { args } = await marketplaceFailure();
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  expect(run.code, run.stderr).toBe(2);
  expect(run.result).toMatchObject({
    execution: { status: "failed" },
    grading: { status: "not_requested" },
    task: { verdict: "not_assessed" },
  });
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const trial = defined(evidence.trials[0]);
  const artifact = defined(
    trial.artifactRefs.find((ref) => ref.id === "sevro.host.diagnostics"),
  );
  const diagnostics = parseRecord(
    await readFile(new URL(artifact.path), "utf8"),
  );
  expect(diagnostics).toMatchObject({
    format: "sevro.host-diagnostics.v1",
    host: "codex",
    role: "candidate",
    stage: "marketplace-install",
    error: {
      name: "Error",
      message: "Codex local marketplace installation failed",
    },
  });
  const failure = record(defined(array(diagnostics.processes)[0]));
  expect(failure).toMatchObject({
    stage: "marketplace-install",
    code: 23,
    signal: null,
    stdout: "marketplace stdout\n",
    stderr: "marketplace refused\n",
  });
  expect(failure.durationMs).toBeGreaterThanOrEqual(0);
  expect((await stat(new URL(artifact.path))).mode & 0o777).toBe(0o600);
  const bundle = defined(
    trial.artifactRefs.find(
      (ref) => ref.id === "sevro.native-transcripts.bundle",
    ),
  );
  expect(
    parseRecord(await readFile(new URL(bundle.path), "utf8")),
  ).toMatchObject({
    rootSessionId: null,
    completeness: "unavailable",
    files: [],
  });
});

test("CLI retains an early app-server failure for the goal example", async () => {
  const { args } = await executionFailure("app-server");
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  expect(run.code).toBe(2);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const trial = defined(evidence.trials[0]);
  expect(trial.rawResult.path).toBeNull();
  const artifact = defined(
    trial.artifactRefs.find((ref) => ref.id === "sevro.host.diagnostics"),
  );
  const diagnostics = parseRecord(
    await readFile(new URL(artifact.path), "utf8"),
  );
  expect(diagnostics).toMatchObject({
    stage: "app-server",
  });
  expect(string(record(diagnostics.error).message)).toMatch(
    /App-server (stdout closed|exited) before settlement/,
  );
  expect(record(defined(array(diagnostics.processes).at(-1)))).toMatchObject({
    stage: "app-server",
    code: 31,
    signal: null,
    stdout: "",
    stderr: "startup failed\n",
  });
});

async function shutdownFailure(
  signal: string,
  errorCode: string,
  priorFailure: boolean,
) {
  const { args, root, binary } = await executionFailure("app-server");
  const preload = join(root, "deny-signal.ts");
  const peer = join(root, "resistant-peer.ts");
  const pidPath = join(root, "peer.pid");
  await writeFile(
    preload,
    `const kill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid < 0 && signal === ${JSON.stringify(signal)})
    throw Object.assign(new Error("shutdown signal denied"), { code: ${JSON.stringify(errorCode)} });
  return kill(pid, signal);
};
`,
  );
  await writeFile(
    peer,
    `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(".git", { recursive: true });
if (${String(priorFailure)}) writeFileSync("failure.txt", "");
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
process.stdin.on("end", () => { setTimeout(() => process.exit(0), 7000); });
await import(${JSON.stringify(join(import.meta.dir, "fixtures/app-server-peer.ts"))});
`,
  );
  await writeFile(
    binary,
    `#!/bin/sh\nif [ "$1" = sandbox ]; then exit 0; fi\nexec '${process.execPath}' '${peer}' "$@"\n`,
    { mode: 0o700 },
  );
  return { args, preload, pidPath };
}

test.each([
  ["SIGTERM", "EPERM", false, 2, "shutdown signal denied"],
  ["SIGKILL", "EPERM", false, 2, "shutdown signal denied"],
  ["SIGTERM", "ESRCH", false, 0, null],
  ["SIGTERM", "EPERM", true, 2, "App-server reported a fatal turn error"],
] as const)(
  "CLI reports app-server shutdown signal failures without crashing: %s %s prior failure=%s",
  async (signal, errorCode, priorFailure, expectedCode, failureMessage) => {
    const { args, preload, pidPath } = await shutdownFailure(
      signal,
      errorCode,
      priorFailure,
    );
    const child = Bun.spawn(
      [
        defined(args[0]),
        "--preload",
        preload,
        ...args.slice(1),
        "--retain-host-diagnostics",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(expectedCode);
      const result = parseCliResult(stdout);
      expect(result.execution.status).toBe(
        expectedCode === 0 ? "completed" : "failed",
      );
      expect(result.task.verdict).toBe("not_assessed");
      if (expectedCode === 0) return;
      const evidence = parseRunEvidence(
        await readFile(defined(result.evidencePath), "utf8"),
      );
      const artifact = defined(
        defined(evidence.trials[0]).artifactRefs.find(
          (ref) => ref.id === "sevro.host.diagnostics",
        ),
      );
      expect(
        parseRecord(await readFile(new URL(artifact.path), "utf8")),
      ).toMatchObject({
        stage: "app-server",
        error: { message: failureMessage },
      });
    } finally {
      child.kill();
      const pid = Number(await readFile(pidPath, "utf8"));
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        expect(record(error).code).toBe("ESRCH");
      }
    }
  },
  20000,
);

test("CLI retains an early exec failure for the guide example", async () => {
  const { args } = await executionFailure("exec");
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  expect(run.code).toBe(2);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const trial = defined(evidence.trials[0]);
  expect(trial.rawResult.path).toBeNull();
  const artifact = defined(
    trial.artifactRefs.find((ref) => ref.id === "sevro.host.diagnostics"),
  );
  const diagnostics = parseRecord(
    await readFile(new URL(artifact.path), "utf8"),
  );
  expect(diagnostics).toMatchObject({
    stage: "exec",
    error: { message: "Codex event stream has no thread start" },
  });
  expect(record(defined(array(diagnostics.processes).at(-1)))).toMatchObject({
    stage: "exec",
    code: 31,
    signal: null,
    stdout: '{"type":"turn.failed"}\n',
    stderr: "startup failed\n",
  });
});

test("CLI retains the original preparation error and cause without transcript opt-in", async () => {
  const { args, project, auth } = await marketplaceFailure();
  await rm(auth);
  await rm(join(project, "sevro.json"));
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  expect(run.code).toBe(2);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const refs = defined(evidence.trials[0]).artifactRefs;
  const artifact = defined(
    refs.find((ref) => ref.id === "sevro.host.diagnostics"),
  );
  const diagnostics = parseRecord(
    await readFile(new URL(artifact.path), "utf8"),
  );
  expect(diagnostics).toMatchObject({
    stage: "state-preparation",
    error: {
      message: "Codex auth file is unreadable or oversized",
      cause: { code: "ENOENT" },
    },
    processes: [],
  });
  expect(refs.some((ref) => ref.id === "sevro.native-transcripts.bundle")).toBe(
    false,
  );
});

test("CLI retains request validation failures before native state allocation", async () => {
  const { args, root } = await executionFailure("exec");
  await writeFile(
    join(root, "case.json"),
    JSON.stringify({
      id: "guide-visual-present",
      prompt: "Return ready.",
      fixture: {
        files: { ".codex/config.toml": "untrusted fixture settings" },
      },
      requiredEvidence: [],
      checks: [],
    }),
  );
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  expect(run.code).toBe(2);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (ref) => ref.id === "sevro.host.diagnostics",
    ),
  );
  expect(
    parseRecord(await readFile(new URL(artifact.path), "utf8")),
  ).toMatchObject({
    stage: "request-validation",
    error: { message: "fixture Codex configuration is unsupported" },
    processes: [],
  });
});

test("CLI bounds and redacts app-server output without losing its prefix", async () => {
  const { args, binary, auth } = await executionFailure("app-server");
  const credential = "opaque-native-credential";
  await writeFile(
    auth,
    JSON.stringify({ tokens: { access_token: credential } }),
  );
  await writeFile(
    binary,
    `#!${process.execPath}
if (process.argv[2] === "sandbox") process.exit(0);
await new Promise(resolve => process.stdin.once("data", resolve));
await new Promise(resolve => process.stderr.write(
  "Authorization: Bearer public-shaped-secret\\n${credential}\\n" + "x".repeat(70_000), resolve));
await new Promise(resolve => process.stdout.write("{broken\\n" + "y".repeat(70_000), resolve));
process.exit(37);
`,
    { mode: 0o700 },
  );
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  expect(run.code).toBe(2);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (ref) => ref.id === "sevro.host.diagnostics",
    ),
  );
  const bytes = await readFile(new URL(artifact.path), "utf8");
  const diagnostics = parseRecord(bytes);
  const receipt = record(defined(array(diagnostics.processes).at(-1)));
  expect(string(receipt.stdout).startsWith("{broken\n")).toBe(true);
  expect(string(receipt.stderr).startsWith("Authorization: [redacted]\n")).toBe(
    true,
  );
  expect(Buffer.byteLength(string(receipt.stdout))).toBeLessThanOrEqual(65536);
  expect(Buffer.byteLength(string(receipt.stderr))).toBeLessThanOrEqual(65536);
  expect(receipt).toMatchObject({
    stdoutTruncated: true,
    stderrTruncated: true,
  });
  expect(bytes).not.toContain(credential);
  expect(bytes).not.toContain("public-shaped-secret");
});

test.each([
  ["ordinary output", "", "Return ready."],
  ["truncated UTF-8", "\\342\\202", "Return ready."],
  ["blocked stdin", "", "x".repeat(2 * 1024 * 1024)],
] as const)(
  "CLI retains exec timeout termination and partial output: %s",
  async (_label, trailing, prompt) => {
    const { args, binary } = await executionFailure("exec", prompt);
    await writeFile(
      binary,
      '#!/bin/sh\nif [ "$1" = sandbox ]; then exit 0; fi\n' +
        `printf '%s\\n' '{"type":"turn.failed"}'\nprintf '${trailing}'\nprintf 'waiting for host' >&2\n/bin/sleep 10\n`,
      { mode: 0o700 },
    );
    const run = await invoke([
      ...args,
      "--retain-host-diagnostics",
      "--codex-timeout-ms",
      "100",
    ]);
    expect(run.code).toBe(2);
    const evidence = parseRunEvidence(
      await readFile(defined(run.result.evidencePath), "utf8"),
    );
    const artifact = defined(
      defined(evidence.trials[0]).artifactRefs.find(
        (ref) => ref.id === "sevro.host.diagnostics",
      ),
    );
    const diagnostics = parseRecord(
      await readFile(new URL(artifact.path), "utf8"),
    );
    const receipt = record(defined(array(diagnostics.processes).at(-1)));
    expect(receipt).toMatchObject({
      stage: "exec",
      reason: "timeout",
      signal: "SIGKILL",
      stdout: '{"type":"turn.failed"}\n' + (trailing ? "�" : ""),
      stderr: "waiting for host",
    });
    expect(receipt.durationMs).toBeGreaterThanOrEqual(100);
    const processArtifact = defined(
      defined(evidence.trials[0]).artifactRefs.find(
        (ref) => ref.id === "codex.process",
      ),
    );
    expect(
      parseRecord(await readFile(new URL(processArtifact.path), "utf8")),
    ).toMatchObject({
      phase: "execution",
      reason: "timeout",
      timeoutMs: 100,
      signal: "SIGKILL",
    });
  },
);

async function cancelledCodexEvaluation() {
  const { root, project, auth, binary } = await executionFailure("exec");
  const marker = join(root, "exec-started");
  await writeFile(
    binary,
    '#!/bin/sh\nif [ "$1" = sandbox ]; then exit 0; fi\n' +
      `printf '\\342\\202'\nprintf 'cancelled host' >&2\nprintf started > '${marker}'\n/bin/sleep 10\n`,
    { mode: 0o700 },
  );
  const controller = new AbortController();
  const pending = runEvaluation({
    projectRoot: project,
    resultsRoot: join(root, "results"),
    host: createCodexHost({
      binary,
      authFile: auth,
      model: "synthetic",
      effort: "low",
      projectRoot: project,
      resultsRoot: join(root, "results"),
      additionalProtectedRoots: [],
      retainHostDiagnostics: true,
    }),
    signal: controller.signal,
    case: {
      id: "cancel",
      prompt: "Return ready.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [],
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  return { pending, marker, controller };
}

test("evaluation retains Codex cancellation evidence after a UTF-8 drain rejection", async () => {
  const { pending, marker, controller } = await cancelledCodexEvaluation();
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw new Error("Codex peer did not start");
      await Bun.sleep(10);
    }
    controller.abort("SIGTERM");
    const outcome = await pending;
    expect(outcome.result.exitCode).toBe(143);
    expect(
      defined(defined(outcome.result.cases[0]).trials[0]).execution.status,
    ).toBe("cancelled");
    const evidence = parseRunEvidence(
      await readFile(outcome.result.evidencePath, "utf8"),
    );
    const trial = defined(evidence.trials[0]);
    const processArtifact = defined(
      trial.artifactRefs.find((ref) => ref.id === "codex.process"),
    );
    expect(
      parseRecord(await readFile(new URL(processArtifact.path), "utf8")),
    ).toMatchObject({
      phase: "execution",
      reason: "cancelled",
      signal: "SIGKILL",
    });
    const artifact = defined(
      trial.artifactRefs.find((ref) => ref.id === "sevro.host.diagnostics"),
    );
    const diagnostics = parseRecord(
      await readFile(new URL(artifact.path), "utf8"),
    );
    expect(record(defined(array(diagnostics.processes).at(-1)))).toMatchObject({
      stage: "exec",
      reason: "cancelled",
      signal: "SIGKILL",
      stdout: "�",
      stderr: "cancelled host",
    });
  } finally {
    controller.abort();
    await pending;
  }
});

test("CLI retains subprocess evidence when exec output exceeds the event limit", async () => {
  const { args, binary } = await executionFailure("exec");
  await writeFile(
    binary,
    `#!${process.execPath}
if (process.argv[2] === "sandbox") process.exit(0);
process.stderr.write("oversized native stream");
await new Promise(resolve => process.stdout.write("z".repeat(9 * 1024 * 1024), resolve));
`,
    { mode: 0o700 },
  );
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  expect(run.code).toBe(2);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (ref) => ref.id === "sevro.host.diagnostics",
    ),
  );
  const diagnostics = parseRecord(
    await readFile(new URL(artifact.path), "utf8"),
  );
  expect(diagnostics).toMatchObject({
    stage: "exec",
    error: { message: "Codex event stream exceeds the size limit" },
  });
  const receipt = record(defined(array(diagnostics.processes).at(-1)));
  expect(receipt).toMatchObject({
    reason: "error",
    stdoutTruncated: true,
    stderr: "oversized native stream",
  });
  expect(string(receipt.stdout)).toBe("z".repeat(65536));
  expect(receipt.durationMs).toBeGreaterThanOrEqual(0);
  expect(receipt.code).not.toBeNull();
});

test("CLI retains Claude preparation failures with the same opt-in", async () => {
  const { args, auth } = await executionFailure("exec");
  args[args.indexOf("--host") + 1] = "claude";
  args[args.indexOf("--codex-bin")] = "--claude-bin";
  args[args.indexOf("--codex-auth-file")] = "--claude-credential-file";
  args.splice(args.indexOf("--codex-entrypoint"), 2);
  await rm(auth);
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  expect(run.code).toBe(2);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (ref) => ref.id === "sevro.host.diagnostics",
    ),
  );
  expect(
    parseRecord(await readFile(new URL(artifact.path), "utf8")),
  ).toMatchObject({
    host: "claude",
    role: "candidate",
    stage: "state-preparation",
    error: { cause: { code: "ENOENT" } },
    processes: [],
  });
});

test("CLI retains a failed Claude process without a final response", async () => {
  const { args, auth, binary } = await executionFailure("exec");
  await writeFile(auth, syntheticClaudeLogin());
  args[args.indexOf("--host") + 1] = "claude";
  args[args.indexOf("--codex-bin")] = "--claude-bin";
  args[args.indexOf("--codex-auth-file")] = "--claude-credential-file";
  args.splice(args.indexOf("--codex-entrypoint"), 2);
  const event =
    '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"model unavailable"}';
  await writeFile(
    binary,
    `#!/bin/sh\nprintf '%s\\n' '${event}'\nprintf 'claude startup failed' >&2\nexit 29\n`,
    { mode: 0o700 },
  );
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  expect(run.code).toBe(2);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (ref) => ref.id === "sevro.host.diagnostics",
    ),
  );
  const diagnostics = parseRecord(
    await readFile(new URL(artifact.path), "utf8"),
  );
  expect(diagnostics).toMatchObject({
    host: "claude",
    stage: "claude-execution",
  });
  expect(record(defined(array(diagnostics.processes).at(-1)))).toMatchObject({
    code: 29,
    signal: null,
    stderr: "claude startup failed",
    stdout: event + "\n",
  });
});

test("diagnostic persistence failure remains an internal runner failure", async () => {
  const { root, project, auth, binary } = await executionFailure("exec");
  const native = createCodexHost({
    binary,
    authFile: auth,
    model: "synthetic",
    effort: "low",
    projectRoot: project,
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
    retainHostDiagnostics: true,
  });
  const host: HostAdapter = {
    ...native,
    run(request) {
      return native.run({
        ...request,
        retainHostDiagnostics() {
          return Promise.reject(new Error("simulated disk full"));
        },
      });
    },
  };
  expect(
    runEvaluation({
      projectRoot: project,
      resultsRoot: join(root, "results"),
      host,
      case: {
        id: "guide-visual-present",
        prompt: "Return ready.",
        fixture: { files: {} },
        requiredEvidence: [],
        checks: [],
      },
      runnerBuildDigest: digest,
      projectDigest: digest,
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
    }),
  ).rejects.toThrow("host diagnostic persistence failed");
});

async function secondaryFailure(
  role: "semantic" | "advisory",
  failPersistence = false,
) {
  const { root, project, auth, binary } = await executionFailure("exec");
  const marker = join(root, "native-home");
  await writeFile(
    binary,
    '#!/bin/sh\nif [ "$1" = sandbox ]; then exit 0; fi\n' +
      `printf '%s' "$CODEX_HOME" > '${marker}'\nprintf '%s\\n' '{"type":"turn.failed"}'\nexit 31\n`,
    { mode: 0o700 },
  );
  const native = createCodexHost({
    binary,
    authFile: auth,
    model: "synthetic",
    effort: "low",
    projectRoot: project,
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
    retainHostDiagnostics: true,
  });
  let retainedBeforeCleanup = false;
  const secondary: HostAdapter = {
    ...native,
    run(request) {
      return native.run({
        ...request,
        async retainHostDiagnostics(bytes) {
          expect(existsSync(await readFile(marker, "utf8"))).toBe(true);
          if (failPersistence) throw new Error("simulated disk full");
          await defined(request.retainHostDiagnostics)(bytes);
          retainedBeforeCleanup = true;
        },
      });
    },
  };
  const outcome = await runEvaluation({
    projectRoot: project,
    resultsRoot: join(root, "results"),
    host: {
      id: "test.candidate",
      model: "synthetic",
      effort: "none",
      run() {
        return Promise.resolve({ finalMessage: "ready", complete: true });
      },
    },
    semanticHost: role === "semantic" ? secondary : undefined,
    advisoryHost: role === "advisory" ? secondary : undefined,
    case: {
      id: "secondary-diagnostics",
      prompt: "Return ready.",
      fixture: {
        kind: "generated",
        commits: [{ message: "Initial", files: { "README.md": "fixture" } }],
      },
      requiredEvidence: [],
      checks:
        role === "semantic"
          ? [
              {
                id: "ready",
                grader: "sevro.semantic",
                configuration: { proposition: "The response is ready." },
              },
            ]
          : [],
    },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  const evidence = parseRunEvidence(
    await readFile(outcome.result.evidencePath, "utf8"),
  );
  return { outcome, evidence, retainedBeforeCleanup };
}

test("semantic native host diagnostics are persisted before cleanup", async () => {
  const { outcome, evidence, retainedBeforeCleanup } =
    await secondaryFailure("semantic");
  expect(outcome.result.exitCode).toBe(3);
  expect(retainedBeforeCleanup).toBe(true);
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (ref) => ref.id === "sevro.semantic.sevro.host.diagnostics",
    ),
  );
  expect(
    parseRecord(await readFile(new URL(artifact.path), "utf8")),
  ).toMatchObject({
    role: "semantic",
    stage: "exec",
  });
});

test("advisory native host diagnostics are persisted before cleanup", async () => {
  const { outcome, evidence, retainedBeforeCleanup } =
    await secondaryFailure("advisory");
  expect(outcome.result.exitCode).toBe(0);
  expect(retainedBeforeCleanup).toBe(true);
  const trial = defined(evidence.trials[0]);
  expect(defined(trial.advisoryReview).status).toBe("failed");
  const artifact = defined(
    trial.artifactRefs.find(
      (ref) => ref.id === "sevro.advisory.sevro.host.diagnostics",
    ),
  );
  expect(
    parseRecord(await readFile(new URL(artifact.path), "utf8")),
  ).toMatchObject({
    role: "advisory",
    stage: "exec",
  });
});

test("CLI retains preflight subprocess diagnostics with a failing stage", async () => {
  const { args, binary } = await executionFailure("exec");
  await writeFile(
    binary,
    "#!/bin/sh\nprintf 'policy syntax issue' >&2\nexit 70\n",
    { mode: 0o700 },
  );
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  expect(run.code).toBe(2);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (ref) => ref.id === "sevro.host.diagnostics",
    ),
  );
  const diagnostics = parseRecord(
    await readFile(new URL(artifact.path), "utf8"),
  );
  expect(diagnostics).toMatchObject({
    stage: "isolation-preflight",
    error: { message: "Codex isolation preflight failed" },
  });
  expect(record(defined(array(diagnostics.processes).at(-1)))).toMatchObject({
    stage: "isolation-preflight",
    code: 70,
    stderr: "policy syntax issue",
  });
});

test("CLI distinguishes plugin installation from marketplace installation", async () => {
  const { args, binary } = await marketplaceFailure();
  await writeFile(
    binary,
    "#!/bin/sh\nif [ \"$2\" = marketplace ]; then printf '{}'; exit 0; fi\n" +
      "printf 'plugin refused' >&2\nexit 24\n",
    { mode: 0o700 },
  );
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  expect(run.code).toBe(2);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (ref) => ref.id === "sevro.host.diagnostics",
    ),
  );
  const diagnostics = parseRecord(
    await readFile(new URL(artifact.path), "utf8"),
  );
  expect(diagnostics).toMatchObject({
    stage: "plugin-install",
    error: { message: "Codex local plugin installation failed" },
  });
  expect(record(defined(array(diagnostics.processes).at(-1)))).toMatchObject({
    stage: "plugin-install",
    code: 24,
    stderr: "plugin refused",
  });
});

test("native diagnostic journals stay within the artifact budget across many plugins", async () => {
  const { root, project, auth, binary } = await marketplaceFailure();
  const workspace = join(root, "workspace");
  const marketplace = join(workspace, "marketplace");
  await mkdir(join(root, "results"));
  const pluginNames = Array.from(
    { length: 40 },
    (_, index) => `plugin-${index}`,
  );
  await mkdir(join(marketplace, ".claude-plugin"), { recursive: true });
  const manifest = "marketplace/.claude-plugin/marketplace.json";
  await writeFile(
    join(workspace, manifest),
    JSON.stringify({
      name: "diagnostic-probe",
      plugins: pluginNames.map((name) => ({ name, source: "./" + name })),
    }),
  );
  for (const name of pluginNames) await mkdir(join(marketplace, name));
  await writeFile(
    binary,
    `#!${process.execPath}
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
if (process.argv[3] === "marketplace") { console.log("{}"); process.exit(0); }
const name = process.argv[4].split("@")[0];
await new Promise(resolve => process.stderr.write("\\0".repeat(65536), resolve));
if (name === "plugin-39") process.exit(24);
const installedPath = join(process.env.CODEX_HOME, "plugins/cache/diagnostic-probe", name);
await mkdir(installedPath, {recursive:true});
console.log(JSON.stringify({name, marketplaceName:"diagnostic-probe", installedPath}));
`,
    { mode: 0o700 },
  );
  const host = createCodexHost({
    binary,
    authFile: auth,
    model: "synthetic",
    effort: "low",
    projectRoot: project,
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
    retainHostDiagnostics: true,
  });
  const result = await host.run({
    prompt: "Return ready.",
    workspace,
    condition: "passive",
    codexMarketplace: {
      artifactRoot: "marketplace",
      marketplaceName: "diagnostic-probe",
      pluginNames,
      artifactPaths: [manifest],
    },
  });
  expect(result.executionFailed).toBe(true);
  const artifact = defined(
    result.artifacts?.find((item) => item.id === "sevro.host.diagnostics"),
  );
  const diagnostics = parseRecord(Buffer.from(artifact.bytes).toString("utf8"));
  expect(diagnostics).toMatchObject({
    stage: "plugin-install",
    error: { message: "Codex local plugin installation failed" },
  });
  expect(array(diagnostics.processes).length).toBeLessThanOrEqual(32);
  expect(diagnostics.processesDropped).toBeGreaterThan(0);
  expect(artifact.bytes.byteLength).toBeLessThan(8 * 1024 * 1024);
  expect(record(defined(array(diagnostics.processes).at(-1)))).toMatchObject({
    stage: "plugin-install",
    code: 24,
  });
});

test("CLI failure results expose the retained diagnostic artifact location", async () => {
  const { args } = await marketplaceFailure();
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (ref) => ref.id === "sevro.host.diagnostics",
    ),
  );
  expect(defined(run.result.diagnostic).message).toContain(artifact.path);
  expect(existsSync(new URL(artifact.path))).toBe(true);
});

test("native cleanup failure does not replace the original execution failure", async () => {
  const { args, binary, root } = await executionFailure("exec");
  const marker = join(root, "native-home");
  await writeFile(
    binary,
    '#!/bin/sh\nif [ "$1" = sandbox ]; then exit 0; fi\n' +
      `printf '%s' "$CODEX_HOME" > '${marker}'\nchmod 000 "$CODEX_HOME"\n` +
      "printf '%s\\n' '{\"type\":\"turn.failed\"}'\nexit 31\n",
    { mode: 0o700 },
  );
  try {
    const run = await invoke([...args, "--retain-host-diagnostics"]);
    expect(run.code).toBe(2);
    const evidence = parseRunEvidence(
      await readFile(defined(run.result.evidencePath), "utf8"),
    );
    const artifact = defined(
      defined(evidence.trials[0]).artifactRefs.find(
        (ref) => ref.id === "sevro.host.diagnostics",
      ),
    );
    expect(
      parseRecord(await readFile(new URL(artifact.path), "utf8")),
    ).toMatchObject({
      stage: "exec",
      error: { message: "Codex event stream has no thread start" },
    });
  } finally {
    const home = await readFile(marker, "utf8");
    if (existsSync(home)) await chmod(home, 0o700);
    await rm(dirname(home), { recursive: true, force: true });
  }
});

test("Claude diagnostics redact inherited opaque credentials", async () => {
  const { args, binary } = await executionFailure("exec");
  args[args.indexOf("--host") + 1] = "claude";
  args[args.indexOf("--codex-bin")] = "--claude-bin";
  args.splice(args.indexOf("--codex-auth-file"), 2);
  args.splice(args.indexOf("--codex-entrypoint"), 2);
  const secret = "opaque-inherited-native-credential";
  await writeFile(
    binary,
    "#!/bin/sh\nprintf '%s' \"$ANTHROPIC_API_KEY\" >&2\nexit 29\n",
    { mode: 0o700 },
  );
  const run = await invoke([...args, "--retain-host-diagnostics"], {
    ANTHROPIC_API_KEY: secret,
  });
  expect(run.code).toBe(2);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (ref) => ref.id === "sevro.host.diagnostics",
    ),
  );
  const text = await readFile(new URL(artifact.path), "utf8");
  expect(text).not.toContain(secret);
  const receipt = record(defined(array(parseRecord(text).processes).at(-1)));
  expect(receipt.stderr).toBe("[redacted]");
});

test.each(["exec", "app-server"] as const)(
  "CLI records an %s launch failure without inventing an exit code",
  async (entrypoint) => {
    const { args, binary } = await executionFailure(entrypoint);
    await writeFile(
      binary,
      '#!/bin/sh\nif [ "$1" = sandbox ]; then /bin/rm "$0"; exit 0; fi\nexit 31\n',
      { mode: 0o700 },
    );
    const run = await invoke([...args, "--retain-host-diagnostics"]);
    expect(run.code).toBe(2);
    const evidence = parseRunEvidence(
      await readFile(defined(run.result.evidencePath), "utf8"),
    );
    const artifact = defined(
      defined(evidence.trials[0]).artifactRefs.find(
        (ref) => ref.id === "sevro.host.diagnostics",
      ),
    );
    const diagnostics = parseRecord(
      await readFile(new URL(artifact.path), "utf8"),
    );
    expect(diagnostics).toMatchObject({
      stage: entrypoint,
      error: { code: "ENOENT" },
    });
    const receipt = record(defined(array(diagnostics.processes).at(-1)));
    expect(receipt).toMatchObject({
      stage: entrypoint,
      code: null,
      signal: null,
      reason: "spawn",
      stdout: "",
      stderr: "",
    });
    expect(receipt.durationMs).toBeGreaterThanOrEqual(0);
  },
);

test("CLI identifies cleanup as the stage when a completed host cannot be cleaned", async () => {
  const { args, binary, root } = await executionFailure("exec");
  const marker = join(root, "native-home");
  await writeFile(
    binary,
    '#!/bin/sh\nif [ "$1" = sandbox ]; then exit 0; fi\n' +
      `printf '%s' "$CODEX_HOME" > '${marker}'\nmkdir "$CODEX_HOME/locked"\ntouch "$CODEX_HOME/locked/file"\nchmod 000 "$CODEX_HOME/locked"\n` +
      `printf '%s\\n' '{"type":"thread.started","thread_id":"root"}' '{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}' '{"type":"turn.completed"}'\n`,
    { mode: 0o700 },
  );
  try {
    const run = await invoke([...args, "--retain-host-diagnostics"]);
    expect(run.code).toBe(2);
    const evidence = parseRunEvidence(
      await readFile(defined(run.result.evidencePath), "utf8"),
    );
    const artifact = defined(
      defined(evidence.trials[0]).artifactRefs.find(
        (ref) => ref.id === "sevro.host.diagnostics",
      ),
    );
    expect(
      parseRecord(await readFile(new URL(artifact.path), "utf8")),
    ).toMatchObject({
      stage: "cleanup",
      error: { code: "EACCES" },
    });
  } finally {
    const home = await readFile(marker, "utf8");
    const locked = join(home, "locked");
    if (existsSync(locked)) await chmod(locked, 0o700);
    if (existsSync(home)) await chmod(home, 0o700);
    await rm(dirname(home), { recursive: true, force: true });
  }
});

test("CLI distinguishes result processing failures from a successful exec process", async () => {
  const { args, binary, root } = await executionFailure("exec");
  const marker = join(root, "native-home");
  await writeFile(
    binary,
    '#!/bin/sh\nif [ "$1" = sandbox ]; then exit 0; fi\n' +
      `printf '%s' "$CODEX_HOME" > '${marker}'\nchmod 000 "$CODEX_HOME"\n` +
      `printf '%s\\n' '{"type":"thread.started","thread_id":"root"}' '{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}' '{"type":"turn.completed"}'\n`,
    { mode: 0o700 },
  );
  try {
    const run = await invoke([...args, "--retain-host-diagnostics"]);
    expect(run.code).toBe(2);
    const evidence = parseRunEvidence(
      await readFile(defined(run.result.evidencePath), "utf8"),
    );
    const artifact = defined(
      defined(evidence.trials[0]).artifactRefs.find(
        (ref) => ref.id === "sevro.host.diagnostics",
      ),
    );
    const diagnostics = parseRecord(
      await readFile(new URL(artifact.path), "utf8"),
    );
    expect(diagnostics).toMatchObject({
      stage: "result-processing",
      error: { code: "EACCES" },
    });
    expect(record(defined(array(diagnostics.processes).at(-1)))).toMatchObject({
      stage: "exec",
      code: 0,
    });
  } finally {
    const home = await readFile(marker, "utf8");
    if (existsSync(home)) await chmod(home, 0o700);
    await rm(dirname(home), { recursive: true, force: true });
  }
});

test("CLI attributes an installed plugin manifest failure to hook preparation", async () => {
  const { args, binary } = await marketplaceFailure();
  await writeFile(
    binary,
    `#!${process.execPath}
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
if (process.argv[3] === "marketplace") { console.log("{}"); process.exit(0); }
const installedPath = join(process.env.CODEX_HOME, "plugins/cache/sevro-probe/probe/1");
await mkdir(join(installedPath, ".claude-plugin"), {recursive:true});
await writeFile(join(installedPath, ".claude-plugin/plugin.json"), "{broken");
console.log(JSON.stringify({name:"probe", marketplaceName:"sevro-probe", installedPath}));
`,
    { mode: 0o700 },
  );
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  expect(run.code).toBe(2);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (ref) => ref.id === "sevro.host.diagnostics",
    ),
  );
  const diagnostics = parseRecord(
    await readFile(new URL(artifact.path), "utf8"),
  );
  expect(diagnostics).toMatchObject({
    stage: "hooks-preparation",
    error: { name: "SyntaxError" },
  });
  expect(
    array(diagnostics.processes).map((entry) => record(entry).code),
  ).toEqual([0, 0]);
});

test("CLI diagnostic stream caps remain byte-bounded at UTF-8 boundaries", async () => {
  const { args, binary } = await marketplaceFailure();
  await writeFile(
    binary,
    `#!${process.execPath}
const output = "xxx" + "🙂".repeat(20_000);
await new Promise(resolve => process.stdout.write(output, resolve));
await new Promise(resolve => process.stderr.write(output, resolve));
process.exit(23);
`,
    { mode: 0o700 },
  );
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  expect(run.code).toBe(2);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (ref) => ref.id === "sevro.host.diagnostics",
    ),
  );
  const receipt = record(
    defined(
      array(
        parseRecord(await readFile(new URL(artifact.path), "utf8")).processes,
      ).at(-1),
    ),
  );
  expect(Buffer.byteLength(string(receipt.stdout))).toBeLessThanOrEqual(65536);
  expect(Buffer.byteLength(string(receipt.stderr))).toBeLessThanOrEqual(65536);
  expect(receipt).toMatchObject({
    stdoutTruncated: true,
    stderrTruncated: true,
  });
});

test("CLI diagnostics redact a credential cut by the stream byte limit", async () => {
  const { args, binary, auth } = await marketplaceFailure();
  const secret = "opaque-native-credential-at-the-byte-boundary";
  await writeFile(auth, JSON.stringify({ tokens: { access_token: secret } }));
  await writeFile(
    binary,
    `#!${process.execPath}
await new Promise(resolve => process.stderr.write("x".repeat(65520) + ${JSON.stringify(secret)}, resolve));
process.exit(23);
`,
    { mode: 0o700 },
  );
  const run = await invoke([...args, "--retain-host-diagnostics"]);
  expect(run.code).toBe(2);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const artifact = defined(
    defined(evidence.trials[0]).artifactRefs.find(
      (ref) => ref.id === "sevro.host.diagnostics",
    ),
  );
  const text = await readFile(new URL(artifact.path), "utf8");
  expect(text).not.toContain(secret.slice(0, 16));
  const receipt = record(defined(array(parseRecord(text).processes).at(-1)));
  expect(string(receipt.stderr).endsWith("[redacted]")).toBe(true);
  expect(receipt.stderrTruncated).toBe(true);
});

test.each(["semantic", "advisory"] as const)(
  "secondary native diagnostic persistence failures stay internal: %s",
  (role) => {
    expect(secondaryFailure(role, true)).rejects.toThrow(
      "host diagnostic persistence failed",
    );
  },
);
