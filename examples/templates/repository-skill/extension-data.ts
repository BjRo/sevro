import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const description = {
  extension: { id: "template.startup", version: "1.0.0" },
  protocols: ["sevro.extension.v1"],
  requiredCapabilities: ["sevro.codex.repository-invocation"],
  optionalCapabilities: [],
  graders: [],
  taskVerdictPolicies: [],
};

export const resolved = {
  cases: [
    {
      id: "repository-skill",
      prompt:
        "{{sevro.skill_invocation}} Explain the application's start command and port. Do not change files.",
      fixture: {
        kind: "generated",
        commits: [
          {
            message: "Initialize application",
            files: { "README.md": "Run bun run dev on port 3000.\n" },
          },
        ],
      },
      checks: [
        {
          id: "start-command",
          grader: "sevro.regex",
          configuration: { pattern: "bun run dev" },
        },
        {
          id: "port",
          grader: "sevro.regex",
          configuration: { pattern: "\\b3000\\b" },
        },
      ],
      requiredEvidence: ["sevro.codex.explicit-invocation"],
      extensionData: {},
    },
  ],
};

export async function prepare() {
  const relativePath = ".agents/skills/startup-guide/SKILL.md";
  const body = await readFile(join(import.meta.dirname, relativePath));
  return {
    artifacts: [
      {
        id: "template.startup-skill",
        relativePath,
        sha256: createHash("sha256").update(body).digest("hex"),
        contentBase64: body.toString("base64"),
        gitExclude: true,
      },
    ],
    requestedInstrumentation: [],
    extensionData: {},
    codexRepositorySkillInvocation: { skillName: "startup-guide" },
  };
}
