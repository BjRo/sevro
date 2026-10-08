export {};

import { createHash } from "node:crypto";

const scenario = process.argv[2] ?? "echo";
const claudeRepository = scenario.startsWith("lifecycle-claude-repository");
const repositoryInvocation =
  claudeRepository || scenario.startsWith("lifecycle-codex-repository");
const repositoryDirectory = claudeRepository ? ".claude" : ".agents";
const request = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;

if (scenario === "wait") {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

if (scenario === "nonzero") {
  process.stderr.write("private diagnostic\n");
  process.exit(7);
}

if (scenario === "malformed") {
  process.stdout.write("{broken");
  process.exit(0);
}

const discovery = {
  extension: { id: "example.extension", version: "1.0.0" },
  protocols: ["sevro.extension.v1"],
  requiredCapabilities: [
    "sevro.host.exec",
    ...(scenario === "lifecycle-host-route" ? ["sevro.case.host-route"] : []),
  ],
  optionalCapabilities: [
    "sevro.host.extra",
    ...(repositoryInvocation && !scenario.endsWith("unnegotiated")
      ? [
          claudeRepository
            ? "sevro.claude.repository-invocation"
            : "sevro.codex.repository-invocation",
        ]
      : []),
    ...(scenario.endsWith("later") ? ["sevro.host.continuation"] : []),
    ...(scenario === "lifecycle-instrumentation-supported"
      ? ["example.extension.guard"]
      : []),
    ...(scenario === "lifecycle-instrumentation-observational"
      ? ["example.extension.trace"]
      : []),
    ...(scenario.startsWith("lifecycle-setup") &&
    scenario !== "lifecycle-setup-unnegotiated"
      ? ["sevro.fixture.setup"]
      : []),
    ...(scenario.startsWith("lifecycle-codex-marketplace") &&
    scenario !== "lifecycle-codex-marketplace-unnegotiated"
      ? ["sevro.codex.plugin-marketplace"]
      : []),
    ...(scenario.startsWith("lifecycle-claude-plugin") &&
    scenario !== "lifecycle-claude-plugin-unnegotiated"
      ? ["sevro.claude.plugin-dirs"]
      : []),
    ...(scenario.startsWith("lifecycle-codex-marketplace") &&
    scenario.includes("explicit-invocation") &&
    !scenario.endsWith("unnegotiated")
      ? ["sevro.codex.explicit-invocation"]
      : []),
    ...(scenario.startsWith("lifecycle-claude-plugin") &&
    scenario.includes("explicit-invocation") &&
    !scenario.endsWith("unnegotiated")
      ? ["sevro.claude.explicit-invocation"]
      : []),
  ],
  graders: ["example.extension"],
  taskVerdictPolicies: scenario.startsWith("lifecycle-policy")
    ? ["example.policy"]
    : [],
};
let hostArtifactReady = true;
if (scenario === "lifecycle-host-artifact" && request.method === "evaluate") {
  const params = request.params as {
    artifacts?: { id: string; path: string }[];
  };
  const trace = params.artifacts?.find(
    (item) => item.id === "example.host.trace",
  );
  hostArtifactReady = Boolean(
    trace &&
    (await Bun.file(new URL(trace.path))
      .text()
      .catch(() => "")) === "host trace\n",
  );
}
const builtinCheck =
  scenario === "lifecycle-replace-shell"
    ? { id: "ready", grader: "sevro.shell", configuration: { run: "exit 0" } }
    : scenario === "lifecycle-replace-semantic"
      ? {
          id: "ready",
          grader: "sevro.semantic",
          configuration: { proposition: "The response promises readiness." },
        }
      : {
          id: "ready",
          grader: "sevro.regex",
          configuration: {
            pattern:
              scenario.startsWith("lifecycle-policy") ||
              scenario.startsWith("lifecycle-replace")
                ? "never"
                : scenario === "lifecycle-host-route"
                  ? '"model":"synthetic-v1"'
                  : "ready",
          },
        };
const marketplaceFiles = {
  "marketplace/.claude-plugin/marketplace.json": JSON.stringify({
    name: "sevro-probe",
    owner: { name: "Sevro" },
    plugins: [{ name: "probe", source: "./plugin", description: "Probe" }],
  }),
  "marketplace/plugin/.claude-plugin/plugin.json": JSON.stringify({
    name: "probe",
    version: "0.1.0",
  }),
  "marketplace/plugin/.codex-plugin/plugin.json": JSON.stringify({
    name: "probe",
    version: "0.1.0",
    skills: "./skills/",
  }),
  "marketplace/plugin/skills/probe/SKILL.md":
    "---\nname: probe\ndescription: Test probe\n---\nRead this skill.\n",
};
const result = scenario.startsWith("lifecycle")
  ? request.method === "resolve"
    ? {
        cases: [
          {
            id: "extension-case",
            prompt:
              scenario === "lifecycle-host-route"
                ? JSON.stringify(
                    (request.params as Record<string, unknown>).host ?? null,
                  )
                : claudeRepository
                  ? scenario.endsWith("repeated")
                    ? "{{sevro.skill_invocation}} {{sevro.skill_invocation}}"
                    : scenario.endsWith("nonleading")
                      ? "Use {{sevro.skill_invocation}} and return ready."
                      : "{{sevro.skill_invocation}} Return ready."
                  : scenario.includes("explicit-invocation")
                    ? scenario.endsWith("repeated")
                      ? scenario.startsWith("lifecycle-claude-plugin")
                        ? "Use {{sevro.skill_invocation}} and {{sevro.skill_invocation}}."
                        : "Use {{sevro.codex.skill_invocation}} and {{sevro.codex.skill_invocation}}."
                      : scenario.endsWith("later")
                        ? "Wait for the next request."
                        : scenario.startsWith("lifecycle-claude-plugin")
                          ? "Use {{sevro.skill_invocation}} and return ready."
                          : "Use {{sevro.codex.skill_invocation}} and return ready."
                    : "Return ready.",
            ...(scenario.endsWith("later")
              ? {
                  followUpPrompt:
                    "Use {{sevro.codex.skill_invocation}} and return ready.",
                }
              : {}),
            fixture:
              scenario === "lifecycle-repository"
                ? {
                    kind: "repository",
                    sourceRef: "fixture-repo",
                    files: { "README.md": "overlay\n" },
                    staged: ["README.md"],
                  }
                : scenario === "lifecycle-generated" ||
                    scenario.startsWith("lifecycle-setup") ||
                    scenario === "lifecycle-git-excluded-artifact" ||
                    scenario.startsWith("lifecycle-codex-marketplace") ||
                    repositoryInvocation ||
                    scenario.startsWith("lifecycle-claude-plugin")
                  ? {
                      kind: "generated",
                      commits: [
                        {
                          message: "chore: initialize",
                          files: { "README.md": "fixture\n" },
                        },
                      ],
                      ...(scenario === "lifecycle-generated"
                        ? {
                            files: { "README.md": "staged\n" },
                            staged: ["README.md"],
                          }
                        : {}),
                    }
                  : { kind: "inline", files: { "README.md": "fixture\n" } },
            checks: [
              builtinCheck,
              ...(scenario === "lifecycle-repository"
                ? [
                    {
                      id: "repository-overlay",
                      grader: "sevro.shell",
                      configuration: {
                        run: 'test "$(cat README.md)" = overlay',
                      },
                    },
                  ]
                : []),
              ...(scenario === "lifecycle-replace-no-extension"
                ? []
                : [
                    {
                      id: "example.extension.ready",
                      grader: "example.extension",
                      configuration: {},
                    },
                  ]),
            ],
            requiredEvidence:
              scenario === "lifecycle-host-observation"
                ? ["darrow.activation"]
                : scenario === "lifecycle-host-artifact"
                  ? ["example.host.trace"]
                  : scenario === "lifecycle-policy-unavailable"
                    ? ["example.missing"]
                    : [],
            extensionData: { "example.extension": { marker: "resolved" } },
          },
        ],
      }
    : request.method === "prepare"
      ? {
          artifacts: repositoryInvocation
            ? [
                {
                  id: "repository-skill",
                  relativePath: scenario.endsWith("missing-mount")
                    ? `${repositoryDirectory}/skills/other/SKILL.md`
                    : `${repositoryDirectory}/skills/probe/SKILL.md`,
                  sha256: createHash("sha256")
                    .update(
                      marketplaceFiles[
                        "marketplace/plugin/skills/probe/SKILL.md"
                      ],
                    )
                    .digest("hex"),
                  contentBase64: Buffer.from(
                    marketplaceFiles[
                      "marketplace/plugin/skills/probe/SKILL.md"
                    ],
                  ).toString("base64"),
                  gitExclude: !scenario.endsWith("not-excluded"),
                },
              ]
            : scenario.startsWith("lifecycle-codex-marketplace") ||
                scenario.startsWith("lifecycle-claude-plugin")
              ? Object.entries(marketplaceFiles)
                  .map(([relativePath, content]) => ({
                    id: `marketplace-${relativePath}`,
                    relativePath,
                    sha256: createHash("sha256").update(content).digest("hex"),
                    contentBase64: Buffer.from(content).toString("base64"),
                    gitExclude:
                      scenario !== "lifecycle-claude-plugin-not-excluded",
                  }))
                  .filter(
                    (artifact) =>
                      scenario !== "lifecycle-claude-plugin-no-manifest" ||
                      !artifact.relativePath.endsWith(
                        "/.claude-plugin/plugin.json",
                      ),
                  )
              : scenario.includes("artifact") ||
                  scenario.startsWith("lifecycle-setup")
                ? [
                    {
                      id: "generated-file",
                      relativePath:
                        scenario === "lifecycle-git-excluded-artifact" ||
                        scenario === "lifecycle-setup-link"
                          ? ".agents/skills/example/SKILL.md"
                          : "generated/data.txt",
                      sha256:
                        scenario === "lifecycle-bad-artifact"
                          ? "a".repeat(64)
                          : createHash("sha256")
                              .update(
                                scenario === "lifecycle-executable-artifact"
                                  ? "#!/bin/sh\nprintf 'ready\\n'\n"
                                  : "prepared data\n",
                              )
                              .digest("hex"),
                      ...(scenario === "lifecycle-source-artifact"
                        ? { sourceRef: "input-data" }
                        : {
                            contentBase64: Buffer.from(
                              scenario === "lifecycle-executable-artifact"
                                ? "#!/bin/sh\nprintf 'ready\\n'\n"
                                : "prepared data\n",
                            ).toString("base64"),
                          }),
                      ...(scenario.startsWith("lifecycle-git-excluded")
                        ? { gitExclude: true }
                        : {}),
                      ...(scenario === "lifecycle-executable-artifact"
                        ? { executable: true }
                        : {}),
                    },
                  ]
                : [],
          requestedInstrumentation:
            scenario === "lifecycle-instrumentation-observational"
              ? [{ id: "example.extension.trace", configuration: {} }]
              : scenario === "lifecycle-instrumentation" ||
                  scenario === "lifecycle-instrumentation-supported"
                ? [{ id: "example.extension.guard", configuration: {} }]
                : [],
          ...(scenario.startsWith("lifecycle-codex-marketplace")
            ? {
                codexMarketplace: {
                  artifactRoot:
                    scenario === "lifecycle-codex-marketplace-bad-root"
                      ? "../marketplace"
                      : "marketplace",
                  marketplaceName: "sevro-probe",
                  pluginNames: ["probe"],
                },
              }
            : {}),
          ...(scenario.startsWith("lifecycle-claude-plugin")
            ? {
                claudePluginDirs: {
                  artifactRoots: [
                    scenario === "lifecycle-claude-plugin-bad-root"
                      ? "../marketplace/plugin"
                      : "marketplace/plugin",
                  ],
                },
              }
            : {}),
          ...(scenario.startsWith("lifecycle-codex-marketplace") &&
          scenario.includes("explicit-invocation")
            ? {
                codexSkillInvocation: {
                  pluginName: "probe",
                  skillName: "probe",
                },
              }
            : {}),
          ...(repositoryInvocation
            ? claudeRepository
              ? { claudeRepositorySkillInvocation: { skillName: "probe" } }
              : { codexRepositorySkillInvocation: { skillName: "probe" } }
            : {}),
          ...(repositoryInvocation && scenario.endsWith("conflicting")
            ? {
                codexSkillInvocation: {
                  pluginName: "probe",
                  skillName: "probe",
                },
              }
            : {}),
          ...(scenario.startsWith("lifecycle-claude-plugin") &&
          scenario.includes("explicit-invocation")
            ? {
                claudeSkillInvocation: {
                  pluginName: "probe",
                  skillName: "probe",
                },
              }
            : {}),
          ...(scenario.startsWith("lifecycle-setup")
            ? {
                fixtureSetup: {
                  command: [
                    process.execPath,
                    "-e",
                    scenario === "lifecycle-setup-link"
                      ? 'const fs = await import("node:fs/promises"); await fs.mkdir(process.env.OUTSIDE, { recursive: true }); await fs.symlink(process.env.OUTSIDE, ".agents");'
                      : 'if (await Bun.file("generated/data.txt").exists()) throw new Error("artifact mounted early"); await Bun.write("setup.txt", process.env.CASE_ROOT + "\\n");',
                  ],
                  environment:
                    scenario === "lifecycle-setup-link"
                      ? { OUTSIDE: "{{sevro.project}}/outside" }
                      : { CASE_ROOT: "{{sevro.project}}/cases" },
                },
              }
            : {}),
          extensionData: { "example.extension": { marker: "prepared" } },
        }
      : request.method === "evaluate"
        ? {
            checks:
              scenario === "lifecycle-missing-check"
                ? []
                : [
                    {
                      id: "example.extension.ready",
                      status: hostArtifactReady ? "passed" : "unavailable",
                      evidenceRefs:
                        scenario === "lifecycle-empty-evidence"
                          ? []
                          : scenario === "lifecycle-host-observation"
                            ? ["darrow.activation"]
                            : scenario === "lifecycle-host-artifact"
                              ? ["example.host.trace"]
                              : ["sevro.observation.final-message"],
                    },
                  ],
            metrics: [
              { id: "example.extension.score", value: 1, unit: "ratio" },
            ],
            ...(scenario.startsWith("lifecycle-domain-outcome")
              ? {
                  domainOutcomes: [
                    {
                      id: "example.extension.activation",
                      status:
                        scenario === "lifecycle-domain-outcome-invalid"
                          ? "passed"
                          : "failed",
                      evidenceRefs:
                        scenario === "lifecycle-domain-outcome-invalid"
                          ? []
                          : ["sevro.observation.final-message"],
                      data: { primarySkill: "other-skill" },
                    },
                  ],
                }
              : {}),
            ...(scenario.startsWith("lifecycle-policy") &&
            scenario !== "lifecycle-policy-missing" &&
            (request.params as Record<string, unknown>)
              .selectedTaskVerdictPolicy === "example.policy"
              ? { taskVerdictRecommendation: "passed" }
              : {}),
          }
        : discovery
  : discovery;
const response = {
  protocol: request.protocol,
  id: scenario === "wrong-id" ? "different" : request.id,
  method: request.method,
  result: preparationDataResult(result),
};
if (scenario === "oversized") {
  process.stdout.write("x".repeat(8 * 1024 * 1024 + 1));
  process.exit(0);
}
process.stdout.write(JSON.stringify(serializedResponse(response)));

function preparationDataResult(value: unknown): unknown {
  if (!scenario.startsWith("prepare-key")) return value;
  const suffixLength = scenario === "prepare-key128" ? 120 : 121;
  return {
    artifacts: [],
    requestedInstrumentation: [],
    extensionData: { ["example." + "a".repeat(suffixLength)]: null },
  };
}

function serializedResponse(value: Record<string, unknown>): unknown {
  switch (scenario) {
    case "wrong-protocol":
      return { ...value, protocol: "foreign.extension.v1" };
    case "id-array":
      return { ...value, id: [] };
    case "result-array":
      return { ...value, result: [] };
    case "null-root":
      return null;
    default:
      return value;
  }
}
