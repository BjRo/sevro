import { createHash } from "node:crypto";
import type { PreparationResult } from "../../src/extensions/index";

export const invocationKinds = [
  "codex-plugin",
  "codex-repository",
  "claude-plugin",
  "claude-repository",
] as const;
export type InvocationKind = (typeof invocationKinds)[number];

export function invocationFixture(kind: InvocationKind) {
  const preparation: PreparationResult = {
    artifacts: [],
    requestedInstrumentation: [],
    extensionData: {},
  };
  let path: string;
  let token: string;
  let capability: string;
  switch (kind) {
    case "codex-plugin":
      preparation.codexMarketplace = {
        artifactRoot: "package",
        marketplaceName: "local",
        pluginNames: ["probe"],
      };
      preparation.codexSkillInvocation = {
        pluginName: "probe",
        skillName: "probe",
      };
      preparation.artifacts.push(
        artifact("package/.claude-plugin/marketplace.json"),
      );
      path = "package/plugin/skills/probe/SKILL.md";
      token = "$probe:probe";
      capability = "sevro.codex.explicit-invocation";
      break;
    case "codex-repository":
      preparation.codexRepositorySkillInvocation = { skillName: "probe" };
      path = ".agents/skills/probe/SKILL.md";
      token = "$probe";
      capability = "sevro.codex.repository-invocation";
      break;
    case "claude-plugin":
      preparation.claudePluginDirs = { artifactRoots: ["package"] };
      preparation.claudeSkillInvocation = {
        pluginName: "probe",
        skillName: "probe",
      };
      preparation.artifacts.push(
        artifact("package/.claude-plugin/plugin.json"),
      );
      path = "package/skills/probe/SKILL.md";
      token = "/probe:probe";
      capability = "sevro.claude.explicit-invocation";
      break;
    case "claude-repository":
      preparation.claudeRepositorySkillInvocation = { skillName: "probe" };
      path = ".claude/skills/probe/SKILL.md";
      token = "/probe";
      capability = "sevro.claude.repository-invocation";
  }
  preparation.artifacts.push(artifact(path));
  return { preparation, token, capability, path };
}

function artifact(relativePath: string) {
  const bytes = Buffer.from("independent skill fixture\n");
  return {
    id: `example.${createHash("sha256").update(relativePath).digest("hex").slice(0, 12)}`,
    relativePath,
    contentBase64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    gitExclude: true,
  };
}

export const invocationCapabilities = [
  "sevro.codex.plugin-marketplace",
  "sevro.codex.explicit-invocation",
  "sevro.codex.repository-invocation",
  "sevro.claude.plugin-dirs",
  "sevro.claude.explicit-invocation",
  "sevro.claude.repository-invocation",
  "sevro.host.continuation",
];
