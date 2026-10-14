import { expectUnknown } from "../fixtures/assertions";
import { defined, fixtureCase, parseRunEvidence } from "../fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isolatedNativeHost,
  extensionSource,
  invoke,
  git,
  installLinuxCodexHelper,
} from "../fixtures/cli-fixtures";
import { createFixture } from "../fixtures/cli-fixtures";
import { extensionFixtureCommand } from "../fixtures/extension-command";

const testDirectory = join(import.meta.dir, "..");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixture = createFixture(roots);
const fixtureExtensionCommand = extensionFixtureCommand();

const instrumentedAdapter = join(
  testDirectory,
  "fixtures",
  "instrumented-adapter.ts",
);

function availableNativeCodex() {
  return isolatedNativeHost ? Bun.which("codex") : null;
}

test("CLI dry run retains preparation without calling the host", async () => {
  const { args, caseFile } = await fixture();
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify(
      fixtureExtensionCommand(extensionSource, "lifecycle-artifact"),
    ),
  );
  const command = args.filter(
    (part, index) =>
      part !== "--case-file" && args[index - 1] !== "--case-file",
  );
  command.push(
    "--extension-command-file",
    commandFile,
    "--extension-source-file",
    extensionSource,
    "--case-id",
    "extension-case",
    "--dry",
  );
  const run = await invoke(command, "fail");
  expect(run.code).toBe(0);
  expect(run.result).toMatchObject({
    execution: { status: "not_run" },
    grading: { status: "not_requested" },
    task: { verdict: "not_assessed" },
  });
  expectUnknown(defined(defined(run.result.cases[0]).trials[0]).checks).toEqual(
    [],
  );
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  expect(defined(evidence.trials[0]).executionMode).toBe("dry");
  expectUnknown(defined(evidence.trials[0]).metrics).toEqual([]);
  const [artifact] = defined(evidence.trials[0]).artifactRefs;
  expect(await readFile(new URL(defined(artifact).path), "utf8")).toBe(
    "prepared data\n",
  );
});

test("CLI negotiates and records enforced host instrumentation", async () => {
  const { args, caseFile } = await fixture();
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify(
      fixtureExtensionCommand(
        extensionSource,
        "lifecycle-instrumentation-supported",
      ),
    ),
  );
  const command = args.filter(
    (part, index) =>
      part !== "--case-file" && args[index - 1] !== "--case-file",
  );
  command[command.indexOf("--adapter-module") + 1] = instrumentedAdapter;
  command[command.indexOf("--condition") + 1] = "enforced";
  command.push(
    "--extension-command-file",
    commandFile,
    "--extension-source-file",
    extensionSource,
    "--case-id",
    "extension-case",
  );
  const enforced = await invoke(command);
  expect(enforced.code).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(enforced.result.evidencePath), "utf8"),
  );
  expect(evidence.condition).toMatchObject({
    requested: "enforced",
    actual: "enforced",
    requestedInstrumentation: [
      { id: "example.extension.guard", configuration: {} },
    ],
    appliedInstrumentation: [
      { id: "example.extension.guard", configuration: {} },
    ],
  });
  const passive = [...command];
  passive[passive.indexOf("--condition") + 1] = "passive";
  const rejected = await invoke(passive);
  expect(rejected.code).toBe(64);
  expect(rejected.result.evidencePath).toBeNull();
});

test("CLI mounts only declared preparation source files", async () => {
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const commandFile = join(projectRoot, "extension-command.json");
  const sourceRoot = join(projectRoot, "sources");
  const sourceFile = join(sourceRoot, "data.txt");
  const mapFile = join(projectRoot, "source-map.json");
  await Bun.write(sourceFile, "prepared data\n");
  await writeFile(
    commandFile,
    JSON.stringify(
      fixtureExtensionCommand(extensionSource, "lifecycle-source-artifact"),
    ),
  );
  await writeFile(
    mapFile,
    JSON.stringify({ "input-data": pathToFileURL(sourceFile).href }),
  );
  const command = args.filter(
    (part, index) =>
      part !== "--case-file" && args[index - 1] !== "--case-file",
  );
  command.push(
    "--extension-command-file",
    commandFile,
    "--extension-source-file",
    extensionSource,
    "--case-id",
    "extension-case",
    "--case-source-root",
    sourceRoot,
    "--case-source-map-file",
    mapFile,
  );
  const run = await invoke(command);
  expect(run.code).toBe(0);
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const [artifact] = defined(evidence.trials[0]).artifactRefs;
  expect(await readFile(new URL(defined(artifact).path), "utf8")).toBe(
    "prepared data\n",
  );
  await writeFile(
    mapFile,
    JSON.stringify({ "input-data": pathToFileURL(commandFile).href }),
  );
  const escaped = await invoke(command);
  expect(escaped.code).toBe(64);
  expect(escaped.result.evidencePath).toBeNull();
  expect(defined(escaped.result.diagnostic).message).toMatch(
    /escapes its declared root/,
  );
});

// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("CLI executes a declared repository fixture", async () => {
  const { args, caseFile } = await fixture();
  const projectRoot = join(caseFile, "..");
  const sourceRoot = join(projectRoot, "sources");
  const repository = join(sourceRoot, "example");
  const mapFile = join(projectRoot, "source-map.json");
  await mkdir(repository, { recursive: true });
  await git(repository, "init", "-b", "main");
  await writeFile(join(repository, "README.md"), "repository fixture\n");
  await git(repository, "add", "README.md");
  await git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Create fixture",
  );
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "repository-case",
      prompt: "Return ready.",
      fixture: { sourceRef: "fixture-repo" },
      checks: [
        {
          id: "ready",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
      requiredEvidence: [],
    }),
  );
  await writeFile(
    mapFile,
    JSON.stringify({ "fixture-repo": pathToFileURL(repository).href }),
  );
  const run = await invoke([
    ...args,
    "--case-source-root",
    sourceRoot,
    "--case-source-map-file",
    mapFile,
  ]);
  expect(run.code).toBe(0);
  expect(run.result.task.verdict).toBe("passed");
  const missingMap = await invoke(args);
  expect(missingMap.code).toBe(64);
  const commandFile = join(projectRoot, "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify(
      fixtureExtensionCommand(extensionSource, "lifecycle-repository"),
    ),
  );
  const extensionCommand = args.filter(
    (part, index) =>
      part !== "--case-file" && args[index - 1] !== "--case-file",
  );
  const extended = await invoke([
    ...extensionCommand,
    "--extension-command-file",
    commandFile,
    "--extension-source-file",
    extensionSource,
    "--case-id",
    "extension-case",
    "--case-source-root",
    sourceRoot,
    "--case-source-map-file",
    mapFile,
    "--shell-isolation",
  ]);
  expect(extended.code).toBe(0);
  expectUnknown(
    defined(defined(extended.result.cases[0]).trials[0]).checks.map(
      (check: { id: string }) => check.id,
    ),
  ).toEqual(["ready", "repository-overlay", "example.extension.ready"]);
});

for (const route of ["shell", "native"] as const) {
  // The native route launches candidate, semantic, and advisory processes.
  test(
    `CLI isolates mapped repository worktrees for ${route} execution`,
    // eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
    async () => {
      const installedCodex = availableNativeCodex();
      if (!installedCodex) return;
      const { args, caseFile } = await fixture();
      const projectRoot = join(caseFile, "..");
      const primary = await mkdtemp(join(tmpdir(), "sevro-source-primary-"));
      const sourceRoot = await mkdtemp(join(tmpdir(), "sevro-source-cache-"));
      const siblingRoot = await mkdtemp(join(tmpdir(), "sevro-source-peer-"));
      roots.push(primary, sourceRoot, siblingRoot);
      const mapped = join(sourceRoot, "mapped");
      const sibling = join(siblingRoot, "linked");
      await git(primary, "init", "-q");
      await writeFile(join(primary, "README.md"), "repository fixture\n");
      await git(primary, "add", "README.md");
      await git(
        primary,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "Create fixture",
      );
      await git(primary, "worktree", "add", "-q", "--detach", mapped);
      await git(primary, "worktree", "add", "-q", "--detach", sibling);
      const definition = fixtureCase();
      definition.fixture = { sourceRef: "fixture-repo" };
      definition.checks.push(
        {
          id: "cloned",
          grader: "sevro.shell",
          configuration: {
            run: "test \"$(cat README.md)\" = 'repository fixture'",
          },
        },
        ...[primary, mapped, sibling].map((root, index) => ({
          id: `source-private-${index}`,
          grader: "sevro.shell",
          configuration: { run: `! cat '${root}/README.md' >/dev/null 2>&1` },
        })),
      );
      const mapFile = join(projectRoot, "source-map.json");
      await writeFile(
        mapFile,
        JSON.stringify({ "fixture-repo": pathToFileURL(mapped).href }),
      );
      let selectedArgs = [
        ...args,
        "--case-source-root",
        sourceRoot,
        "--case-source-map-file",
        mapFile,
        "--shell-isolation",
      ];
      if (route === "native") {
        definition.checks.push({
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The response promises readiness." },
        });
        const authFile = join(projectRoot, "auth.json");
        const binary = join(siblingRoot, "codex-wrapper");
        await installLinuxCodexHelper(binary, defined(installedCodex));
        await writeFile(authFile, "test-only-auth\n", { mode: 0o600 });
        const semantic = JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify({
              checks: [
                { id: "meaning", verdict: "pass", reason: "Ready is stated" },
              ],
            }),
          },
        });
        const advisory = JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify({
              verdict: "pass",
              overallScore: 5,
              dimensions: {
                correctness: 5,
                maintainability: 5,
                testQuality: 5,
                scopeDiscipline: 5,
              },
              strengths: ["Ready"],
              weaknesses: [],
              summary: "Ready.",
            }),
          },
        });
        await writeFile(
          binary,
          `#!/bin/sh
if [ "$1" = --version ]; then printf 'synthetic-codex\\n'; exit 0; fi
if [ "$1" = sandbox ]; then shift; exec "${installedCodex}" sandbox "$@"; fi
if [ "$1" != exec ]; then exit 99; fi
profile=
for arg in "$@"; do
  case "$arg" in default_permissions=*) profile=$(printf '%s' "$arg" | cut -d= -f2 | tr -d '"');; esac
done
test -n "$profile" || exit 92
"${installedCodex}" sandbox -P "$profile" -C "$PWD" /bin/sh -c 'for source; do if /bin/cat "$source/README.md" >/dev/null 2>&1; then exit 91; fi; done' sevro-source-probe '${primary}' '${mapped}' '${sibling}' || exit 93
printf '%s\\n' '{"type":"thread.started","thread_id":"source-private-cli"}'
message='{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}'
for arg in "$@"; do
  if [ "$arg" = synthetic-judge ]; then message='${semantic}'; fi
  if [ "$arg" = synthetic-reviewer ]; then message='${advisory}'; fi
done
printf '%s\\n' "$message"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
          { mode: 0o700 },
        );
        selectedArgs = selectedArgs.filter(
          (value, index) =>
            value !== "--adapter-module" &&
            selectedArgs[index - 1] !== "--adapter-module",
        );
        selectedArgs.push(
          "--host",
          "codex",
          "--codex-bin",
          binary,
          "--codex-auth-file",
          authFile,
          "--model",
          "synthetic-candidate",
          "--effort",
          "low",
          "--semantic-host",
          "codex",
          "--semantic-model",
          "synthetic-judge",
          "--semantic-effort",
          "low",
          "--advisory-host",
          "codex",
          "--advisory-model",
          "synthetic-reviewer",
          "--advisory-effort",
          "low",
        );
      }
      await writeFile(caseFile, JSON.stringify(definition));
      const run = await invoke(selectedArgs);
      const retained = parseRunEvidence(
        await readFile(defined(run.result.evidencePath), "utf8"),
      );
      expect(
        run.code,
        JSON.stringify({ result: run.result, trial: retained.trials[0] }),
      ).toBe(0);
      expect(run.result.task.verdict).toBe("passed");
      expectUnknown(
        defined(defined(run.result.cases[0]).trials[0]).checks.map(
          (check: { status: string }) => check.status,
        ),
      ).toEqual(definition.checks.map(() => "passed"));
      if (route === "native") {
        const evidence = parseRunEvidence(
          await readFile(defined(run.result.evidencePath), "utf8"),
        );
        expect(defined(evidence.trials[0]).advisoryReview).toMatchObject({
          status: "completed",
          assessment: { verdict: "pass" },
        });
      }
      for (const root of [primary, mapped, sibling]) {
        expect(await readFile(join(root, "README.md"), "utf8")).toBe(
          "repository fixture\n",
        );
      }
    },
    route === "native" ? 60_000 : undefined,
  );
}

test("CLI accepts generated Git history from a case or extension", async () => {
  const { args, caseFile } = await fixture();
  const definition = fixtureCase();
  definition.fixture = {
    kind: "generated",
    commits: [
      { message: "chore: initialize", files: { "README.md": "fixture\n" } },
    ],
    files: { "README.md": "staged\n" },
    staged: ["README.md"],
  };
  await writeFile(caseFile, JSON.stringify(definition));
  expect((await invoke(args)).code).toBe(0);
  const commandFile = join(caseFile, "..", "extension-command.json");
  await writeFile(
    commandFile,
    JSON.stringify(
      fixtureExtensionCommand(extensionSource, "lifecycle-generated"),
    ),
  );
  const extensionCommand = args.filter(
    (part, index) =>
      part !== "--case-file" && args[index - 1] !== "--case-file",
  );
  extensionCommand.push(
    "--extension-command-file",
    commandFile,
    "--extension-source-file",
    extensionSource,
    "--case-id",
    "extension-case",
  );
  expect((await invoke(extensionCommand)).code).toBe(0);
  defined(definition.fixture.commits[0]).files = { ".git/config": "escape" };
  await writeFile(caseFile, JSON.stringify(definition));
  const invalid = await invoke(args);
  expect(invalid.code).toBe(64);
  expect(invalid.result.evidencePath).toBeNull();
});

test("CLI runs shell checks only with explicit isolation roots", async () => {
  if (!isolatedNativeHost) return;
  const { args, caseFile } = await fixture();
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "shell-case",
      prompt: "Return ready.",
      fixture: { files: { "README.md": "fixture\n" } },
      checks: [
        {
          id: "fixture-file",
          grader: "sevro.shell",
          configuration: { run: "test -f README.md" },
        },
      ],
      requiredEvidence: [],
    }),
  );
  const missingIsolation = await invoke(args);
  expect(missingIsolation.code).toBe(64);
  expect(defined(missingIsolation.result.diagnostic).message).toMatch(
    /protected source roots/,
  );
  const isolated = await invoke([
    ...args,
    "--shell-isolation",
    "--protected-root",
    join(caseFile, ".."),
  ]);
  expect(isolated.code).toBe(0);
  expect(
    defined(defined(defined(isolated.result.cases[0]).trials[0]).checks[0]),
  ).toMatchObject({
    id: "fixture-file",
    status: "passed",
  });
  const relativeRoot = await invoke([
    ...args,
    "--shell-isolation",
    "--protected-root",
    "relative",
  ]);
  expect(relativeRoot.code).toBe(64);
});
