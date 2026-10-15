import {
  artifact,
  pluginArtifacts,
  repositoryArtifacts,
} from "./extension-artifacts";

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

export function describe(mode: string, host: string) {
  const capabilities: Record<string, string[]> = {
    lifecycle: [],
    "repository-skill": [`sevro.${host}.repository-invocation`],
    plugins:
      host === "codex"
        ? ["sevro.codex.plugin-marketplace", "sevro.codex.explicit-invocation"]
        : ["sevro.claude.plugin-dirs", "sevro.claude.explicit-invocation"],
  };
  const requiredCapabilities = capabilities[mode];
  if (!requiredCapabilities) throw new Error("Unknown extension recipe");
  return {
    extension: { id: "recipes.startup", version: "1.0.0" },
    protocols: ["sevro.extension.v1"],
    requiredCapabilities,
    optionalCapabilities: [],
    graders: ["recipes.startup"],
    taskVerdictPolicies: [],
  };
}

function requiredInvocation(mode: string, host: string): string[] {
  if (mode !== "repository-skill") return [];
  return [
    host === "codex"
      ? "sevro.codex.explicit-invocation"
      : "sevro.claude.repository-invocation",
  ];
}

export function resolveCase(mode: string, host: string, fail: boolean) {
  const invocation = mode === "lifecycle" ? "" : "{{sevro.skill_invocation}} ";
  const prompt = fail
    ? "Deliberate negative control: return only wrong."
    : "Read README.md. Explain the application's start command and port. Do not change files.";
  const requiredEvidence = requiredInvocation(mode, host);
  return {
    cases: [
      {
        id: "recipe-extension",
        prompt: invocation + prompt,
        fixture: {
          kind: "generated",
          commits: [
            {
              message: "chore: initialize sample",
              files: { "README.md": "Run bun run dev on port 3000.\n" },
            },
          ],
        },
        checks: [
          {
            id: "startup-command",
            grader: "sevro.regex",
            configuration: { pattern: "bun run dev" },
          },
          {
            id: "prepared-input",
            grader: "sevro.shell",
            configuration: {
              run: "test \"$(cat startup.txt)\" = 'prepared startup data'",
            },
          },
          ...(mode === "plugins"
            ? [
                {
                  id: "plugin-hook",
                  grader: "sevro.shell",
                  configuration: {
                    run: "cat hook-ran.txt",
                    expectExact: "hook ran",
                  },
                },
              ]
            : []),
          {
            id: "recipes.startup.answer",
            grader: "recipes.startup",
            configuration: {},
          },
        ],
        requiredEvidence,
        extensionData: { "recipes.startup": { mode, host } },
      },
    ],
  };
}

export async function prepare(mode: string, host: string) {
  const base = {
    artifacts: [artifact("startup.txt", "prepared startup data\n")],
    requestedInstrumentation: [],
    extensionData: { "recipes.startup": { mode, host } },
  };
  switch (mode) {
    case "repository-skill":
      return {
        ...base,
        artifacts: [...base.artifacts, ...(await repositoryArtifacts(host))],
        ...(host === "codex"
          ? { codexRepositorySkillInvocation: { skillName: "startup-guide" } }
          : {
              claudeRepositorySkillInvocation: { skillName: "startup-guide" },
            }),
      };
    case "plugins":
      return {
        ...base,
        artifacts: [...base.artifacts, ...pluginArtifacts()],
        ...(host === "codex"
          ? {
              codexMarketplace: {
                artifactRoot: "marketplace",
                marketplaceName: "recipes",
                pluginNames: ["startup"],
              },
              codexSkillInvocation: {
                pluginName: "startup",
                skillName: "startup-guide",
              },
            }
          : {
              claudePluginDirs: { artifactRoots: ["marketplace/plugin"] },
              claudeSkillInvocation: {
                pluginName: "startup",
                skillName: "startup-guide",
              },
            }),
      };
    default:
      return base;
  }
}

function answerStatus(observation: Record<string, unknown>) {
  if (observation.completeness !== "complete") return "unavailable";
  const text = record(observation.data).text;
  return typeof text === "string" && /\b3000\b/.test(text)
    ? "passed"
    : "failed";
}

export function evaluate(params: Record<string, unknown>) {
  if (!Array.isArray(params.observations))
    throw new Error("Missing observations");
  const observations: unknown[] = params.observations;
  const observation = observations
    .map(record)
    .find((item) => item.id === "sevro.observation.final-message");
  if (!observation) throw new Error("Missing final-message observation");
  const status = answerStatus(observation);
  return {
    checks: [
      {
        id: "recipes.startup.answer",
        status,
        evidenceRefs: ["sevro.observation.final-message"],
      },
    ],
    metrics: [],
  };
}
