import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfiguration, type HostAdapter } from "../../src/engine";
import { defined } from "../fixtures/assertions";
import { artifactEvaluation } from "../fixtures/runtime-host-fixtures";
import { createCodexFixture } from "../fixtures/runtime-host-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const codexFixture = createCodexFixture(roots);

test("Codex state opt-in exposes actual configuration without credential access", async () => {
  const { host, workspace } = await codexFixture(
    'test -s "$CODEX_HOME/config.toml" && ! cat "$CODEX_HOME/auth.json" >/dev/null 2>&1 && ! printf changed > "$CODEX_HOME/config.toml" 2>/dev/null && printf configured',
  );
  const runtimePolicy = {
    format: "sevro.runtime.v1" as const,
    environment: {},
    readOnlyRoots: [],
    codexState: true,
  };
  const result = await host.run({
    workspace,
    prompt: "Inspect the actual isolated configuration.",
    condition: "passive",
    runtimePolicy,
  });
  expect(result.finalMessage).toBe("configured");
});

test("Codex state opt-in keeps checkout configuration inert", async () => {
  const { host, workspace } = await codexFixture(
    'test -s "$CODEX_HOME/config.toml" && ! grep -q "= 99" "$CODEX_HOME/config.toml" && printf isolated',
  );
  await mkdir(join(workspace, ".codex"));
  const represented = "[agents]\nmax_concurrent_threads_per_session = 99\n";
  await writeFile(join(workspace, ".codex/config.toml"), represented);
  const runtimePolicy = {
    format: "sevro.runtime.v1" as const,
    environment: {},
    readOnlyRoots: [],
    codexState: true,
  };
  const result = await host.run({
    workspace,
    prompt:
      "Diagnose effective configuration rather than the represented checkout.",
    condition: "passive",
    runtimePolicy,
  });
  expect(result.finalMessage).toBe("isolated");
  expect(await readFile(join(workspace, ".codex/config.toml"), "utf8")).toBe(
    represented,
  );
});

test("Codex state grading observes actual user-skill creation with read-only grants", async () => {
  const { host, root } = await codexFixture(
    '/bin/mkdir -p "$CODEX_HOME/skills/created" && printf skill > "$CODEX_HOME/skills/created/SKILL.md" && printf "%s" "$CODEX_HOME" > native-home && printf created',
  );
  const runtimePolicy = {
    format: "sevro.runtime.v1" as const,
    environment: {},
    readOnlyRoots: [],
    codexState: true,
  };
  const { result } = await artifactEvaluation(root, host, {
    runtimePolicy,
    case: {
      id: "codex-user-skill-state",
      prompt: "Create a user-level skill.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "actual-user-skill",
          grader: "sevro.shell",
          configuration: {
            run: 'test "$SEVRO_CANDIDATE_ARTIFACT_CODEX_CONFIG" = "$(cat native-home)/config.toml" && test "$SEVRO_CANDIDATE_ARTIFACT_CODEX_SKILLS" = "$(cat native-home)/skills" && test -s "$SEVRO_CANDIDATE_ARTIFACT_CODEX_CONFIG" && cat "$SEVRO_CANDIDATE_ARTIFACT_CODEX_SKILLS/created/SKILL.md" && ! printf changed > "$SEVRO_CANDIDATE_ARTIFACT_CODEX_SKILLS/created/SKILL.md" 2>/dev/null && ! cat "$SEVRO_CANDIDATE_ARTIFACT_CODEX_SKILLS/../auth.json" >/dev/null 2>&1',
            expectExact: "skill",
          },
        },
      ],
    },
  });
  expect(result.exitCode).toBe(0);
  expect(result.task.verdict).toBe("passed");
});

test("Codex state grading observes agent-home skill creation", async () => {
  const { host, root } = await codexFixture(
    '/bin/mkdir -p "$SEVRO_CODEX_AGENT_SKILLS/created" && printf agent > "$SEVRO_CODEX_AGENT_SKILLS/created/SKILL.md" && printf "%s" "$SEVRO_CODEX_AGENT_SKILLS" > agent-root && printf created',
  );
  const runtimePolicy = {
    format: "sevro.runtime.v1" as const,
    environment: {},
    readOnlyRoots: [],
    codexState: true,
  };
  const { result } = await artifactEvaluation(root, host, {
    runtimePolicy,
    case: {
      id: "agent-user-skill-state",
      prompt: "Create an agent-home skill.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "agent-home-skill",
          grader: "sevro.shell",
          configuration: {
            run: 'test "$SEVRO_CANDIDATE_ARTIFACT_AGENT_SKILLS" = "$(cat agent-root)" && cat "$SEVRO_CANDIDATE_ARTIFACT_AGENT_SKILLS/created/SKILL.md"',
            expectExact: "agent",
          },
        },
      ],
    },
  });
  expect(result.exitCode).toBe(0);
});

test("runtime configuration opts into candidate-bound Codex state", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-codex-state-config-"));
  roots.push(root);
  await writeFile(
    join(root, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      codexState: true,
    }),
  );
  expect(defined(await loadRuntimeConfiguration(root)).codexState).toBe(true);
});

test.each([
  "codex_config",
  "codex_skills",
  "agent_skills",
  "command_agent_skills",
  "command_codex_skills",
])("Codex state artifact names cannot be rebound: %s", async (name) => {
  const root = await mkdtemp(join(tmpdir(), "sevro-codex-state-config-"));
  roots.push(root);
  await writeFile(
    join(root, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      codexState: true,
      runtime: { artifactDirectories: [{ name, path: ".darrow/reviews" }] },
    }),
  );
  expect(loadRuntimeConfiguration(root)).rejects.toThrow(
    "reserved for Codex state",
  );
});

test("Codex state grading observes command-home skill creation", async () => {
  const { host, root } = await codexFixture(
    '/bin/mkdir -p "$HOME/.agents/skills/created" && printf command > "$HOME/.agents/skills/created/SKILL.md" && printf "%s" "$HOME" > command-home && printf created',
  );
  const runtimePolicy = {
    format: "sevro.runtime.v1" as const,
    environment: {},
    readOnlyRoots: [],
    codexState: true,
  };
  const { result } = await artifactEvaluation(root, host, {
    runtimePolicy,
    case: {
      id: "command-user-skill-state",
      prompt: "Create a skill below the command HOME.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "command-home-skill",
          grader: "sevro.shell",
          configuration: {
            run: 'test "$SEVRO_CANDIDATE_ARTIFACT_COMMAND_AGENT_SKILLS" = "$(cat command-home)/.agents/skills" && cat "$SEVRO_CANDIDATE_ARTIFACT_COMMAND_AGENT_SKILLS/created/SKILL.md"',
            expectExact: "command",
          },
        },
      ],
    },
  });
  expect(result.exitCode).toBe(0);
});

const codexStatePolicy = {
  format: "sevro.runtime.v1" as const,
  environment: {},
  readOnlyRoots: [],
  codexState: true,
};

test("Codex state keeps bundled system skills read-only", async () => {
  const { host, workspace } = await codexFixture(
    'if mkdir -p "$CODEX_HOME/skills/.system/new" 2>/dev/null && printf changed > "$CODEX_HOME/skills/.system/new/SKILL.md" 2>/dev/null; then printf writable; else printf protected; fi',
  );
  const response = await host.run({
    workspace,
    prompt: "Preserve bundled skills.",
    condition: "passive",
    runtimePolicy: codexStatePolicy,
  });
  expect(response.finalMessage).toBe("protected");
});

test.each([
  "none",
  "codex",
  "agent",
  "command_agent",
  "command_codex",
  "agent/.system",
  "command_agent/.system",
  "command_codex/.system",
] as const)(
  "Codex state absence grading detects %s user-skill state",
  async (location) => {
    const homes = {
      codex: "$CODEX_HOME/skills",
      agent: "$SEVRO_CODEX_AGENT_SKILLS",
      command_agent: "$HOME/.agents/skills",
      command_codex: "$HOME/.codex/skills",
      "agent/.system": "$SEVRO_CODEX_AGENT_SKILLS/.system",
      "command_agent/.system": "$HOME/.agents/skills/.system",
      "command_codex/.system": "$HOME/.codex/skills/.system",
    };
    const create =
      location === "none"
        ? ""
        : `/bin/mkdir -p "${homes[location]}/new"; printf created > "${homes[location]}/new/SKILL.md"; `;
    const { host, root } = await codexFixture(`${create}printf ready`);
    const { result } = await artifactEvaluation(root, host, {
      runtimePolicy: codexStatePolicy,
      case: {
        id: "user-skill-absence",
        prompt: "Do not create a user skill.",
        fixture: { files: {} },
        requiredEvidence: [],
        checks: [
          {
            id: "no-user-skills",
            grader: "sevro.shell",
            configuration: {
              run: 'for root in "$SEVRO_CANDIDATE_ARTIFACT_CODEX_SKILLS" "$SEVRO_CANDIDATE_ARTIFACT_AGENT_SKILLS" "$SEVRO_CANDIDATE_ARTIFACT_COMMAND_AGENT_SKILLS" "$SEVRO_CANDIDATE_ARTIFACT_COMMAND_CODEX_SKILLS"; do test -d "$root" || exit 2; find "$root" -path "$SEVRO_CANDIDATE_ARTIFACT_CODEX_SKILLS/.system" -prune -o -type f -name SKILL.md -print; done',
              expectExact: "",
            },
          },
        ],
      },
    });
    expect(result.exitCode).toBe(location === "none" ? 0 : 1);
  },
);

test.each([
  "success",
  "candidate-failure",
  "grader-failure",
  "cancelled",
  "transport-failure",
] as const)("Codex state cleanup covers %s", async (mode) => {
  const { host, root } = await codexFixture(
    'printf "%s" "$CODEX_HOME" > native-home; printf ready',
  );
  const controller = new AbortController();
  let nativeHome = "";
  const candidate: HostAdapter = {
    ...host,
    async run(request) {
      const response = await host.run(request);
      nativeHome = await readFile(
        join(request.workspace, "native-home"),
        "utf8",
      );
      expect(existsSync(join(nativeHome, "config.toml"))).toBe(true);
      if (mode === "cancelled") controller.abort();
      if (mode === "transport-failure") throw new Error("transport failed");
      return { ...response, executionFailed: mode === "candidate-failure" };
    },
  };
  const { result } = await artifactEvaluation(root, candidate, {
    runtimePolicy: codexStatePolicy,
    signal: controller.signal,
    case: {
      id: "codex-state-cleanup",
      prompt: "Return ready.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "state",
          grader: "sevro.shell",
          configuration: {
            run:
              mode === "grader-failure"
                ? "exit 1"
                : 'test -s "$SEVRO_CANDIDATE_ARTIFACT_CODEX_CONFIG"',
          },
        },
      ],
    },
  });
  expect(result.exitCode === 0).toBe(mode === "success");
  expect(existsSync(nativeHome)).toBe(false);
});

test.each([
  "missing",
  "symlink",
  "hardlink",
  "config-symlink",
  "config-directory",
] as const)("Codex state grading refuses %s evidence", async (kind) => {
  const actions = {
    missing: 'rm -rf "$CODEX_HOME/skills"',
    symlink: 'ln -s "$CODEX_HOME/auth.json" "$CODEX_HOME/skills/SKILL.md"',
    hardlink:
      'printf skill > "$CODEX_HOME/skills/original"; ln "$CODEX_HOME/skills/original" "$CODEX_HOME/skills/SKILL.md"',
    "config-symlink":
      'rm "$CODEX_HOME/config.toml"; ln -s "$CODEX_HOME/auth.json" "$CODEX_HOME/config.toml"',
    "config-directory":
      'rm "$CODEX_HOME/config.toml"; mkdir "$CODEX_HOME/config.toml"',
  };
  const { host, root } = await codexFixture(
    'printf "%s" "$CODEX_HOME" > native-home; printf ready',
  );
  const candidate: HostAdapter = {
    ...host,
    async run(request) {
      const response = await host.run(request);
      // A trusted transport deliberately corrupts native evidence after execution.
      const nativeHome = await readFile(
        join(request.workspace, "native-home"),
        "utf8",
      );
      const child = Bun.spawn(["/bin/sh", "-c", actions[kind]], {
        env: { CODEX_HOME: nativeHome },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
      return response;
    },
  };
  const { result } = await artifactEvaluation(root, candidate, {
    runtimePolicy: codexStatePolicy,
  });
  expect(result.exitCode).toBe(3);
});

test("Codex state cannot be fabricated by a host without native evidence", async () => {
  const { root } = await codexFixture("printf ready");
  const host: HostAdapter = {
    id: "synthetic",
    model: "synthetic",
    effort: "low",
    run: () => Promise.resolve({ finalMessage: "ready", complete: true }),
  };
  const { result } = await artifactEvaluation(root, host, {
    runtimePolicy: codexStatePolicy,
  });
  expect(result.exitCode).toBe(3);
  expect(defined(result.diagnostic).message).toContain("missing or unsafe");
});

test("Codex state command visibility does not enable evaluator state sharing", async () => {
  const { host, root } = await codexFixture(
    'test -s "$CODEX_HOME/config.toml" && printf "%s" "$CODEX_HOME" > native-home && mkdir -p "$HOME/.darrow/reviews" && printf review > "$HOME/.darrow/reviews/result" && printf review',
  );
  let nativeHome = "";
  const candidate: HostAdapter = {
    ...host,
    configuration: {
      ...host.configuration,
      "fixture.command-config-visibility": true,
    },
    async run(request) {
      const response = await host.run({
        ...request,
        runtimePolicy: { ...defined(request.runtimePolicy), codexState: true },
      });
      expect(response.finalMessage).toBe("review");
      nativeHome = await readFile(
        join(request.workspace, "native-home"),
        "utf8",
      );
      return response;
    },
  };
  const { result } = await artifactEvaluation(root, candidate, {
    case: {
      id: "command-only-config-visibility",
      prompt: "Read local configuration and create review evidence.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "declared-artifacts-only",
          grader: "sevro.shell",
          configuration: {
            run: 'test -z "$SEVRO_CANDIDATE_ARTIFACT_CODEX_CONFIG" && test -z "$SEVRO_CANDIDATE_ARTIFACT_CODEX_SKILLS" && test -z "$SEVRO_CANDIDATE_ARTIFACT_AGENT_SKILLS" && test -z "$SEVRO_CANDIDATE_ARTIFACT_COMMAND_AGENT_SKILLS" && test -z "$SEVRO_CANDIDATE_ARTIFACT_COMMAND_CODEX_SKILLS" && cat "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result"',
            expectExact: "review",
          },
        },
      ],
    },
  });
  expect(result.exitCode).toBe(0);
  expect(existsSync(nativeHome)).toBe(false);
});

test("Codex state evidence stays bound to each native request", async () => {
  const { host, root } = await codexFixture(
    'printf "%s" "$CODEX_HOME" > native-home; printf ready',
  );
  const nativeHomes = new Set<string>();
  const candidate: HostAdapter = {
    ...host,
    async run(request) {
      const response = await host.run(request);
      nativeHomes.add(
        await readFile(join(request.workspace, "native-home"), "utf8"),
      );
      expect(host.run(request)).rejects.toThrow(
        "already bound to a native request",
      );
      return response;
    },
  };
  const { result } = await artifactEvaluation(root, candidate, {
    runtimePolicy: codexStatePolicy,
    trialCount: 2,
    jobs: 2,
    case: {
      id: "bound-codex-state",
      prompt: "Return ready.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "same-request",
          grader: "sevro.shell",
          configuration: {
            run: 'test "$SEVRO_CANDIDATE_ARTIFACT_CODEX_CONFIG" = "$(cat native-home)/config.toml" && test -s "$SEVRO_CANDIDATE_ARTIFACT_CODEX_CONFIG"',
          },
        },
      ],
    },
  });
  expect(result.exitCode).toBe(0);
  expect(nativeHomes.size).toBe(2);
  for (const home of nativeHomes) expect(existsSync(home)).toBe(false);
});
