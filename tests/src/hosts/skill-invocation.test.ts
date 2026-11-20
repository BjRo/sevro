import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import { afterEach, expect, test } from "bun:test";
import {
  prepareHostInvocation,
  renderSkillInvocation,
  verifyCodexInvocation,
  verifyClaudeRepositoryMount,
  verifyClaudePluginInvocation,
} from "../../../src/hosts/index";
import { prepareArtifacts } from "../../../src/fixtures/index";
import {
  invocationKinds,
  invocationFixture,
  invocationCapabilities,
} from "../../fixtures/skill-invocation";

const { temporaryFixture, cleanupTemporaryFixtures } = createTemporaryFixtures(
  [],
);
afterEach(cleanupTemporaryFixtures);

test("host invocation preparation resolves a Codex repository declaration", async () => {
  const fixture = invocationFixture("codex-repository");
  const plan = prepareHostInvocation({
    case: { prompt: "Use {{sevro.skill_invocation}}." },
    hostCapabilities: invocationCapabilities,
    negotiatedCapabilities: invocationCapabilities,
    extensionPreparation: fixture.preparation,
    inlineArtifacts: await prepareArtifacts(fixture.preparation.artifacts, []),
  });
  expect(plan.invocationToken).toBe("$probe");
  expect(plan.configuration).toEqual({
    codexRepositorySkillInvocation: { skillName: "probe" },
  });
  expect(plan.hostRequest).toEqual({
    explicitSkillInvocation: {
      scope: "repository",
      skillName: "probe",
      token: "$probe",
    },
  });
});

test("host runtime invocation admission uses the host-owned mount seam", async () => {
  const workspace = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-invocation-")),
  );
  await mkdir(join(workspace, ".agents/skills/probe"), { recursive: true });
  await writeFile(
    join(workspace, ".agents/skills/probe/SKILL.md"),
    "skill body\n",
  );
  expect(
    verifyCodexInvocation({
      workspace,
      prompt: "$probe",
      condition: "passive",
      explicitSkillInvocation: {
        scope: "repository",
        skillName: "probe",
        token: "$probe",
      },
    }),
  ).resolves.toBeUndefined();
});

test("Claude repository admission returns the verified mounted body", async () => {
  const workspace = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-invocation-")),
  );
  const skillDir = join(workspace, ".claude/skills/probe");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "skill body\n");
  expect(
    await verifyClaudeRepositoryMount(
      {
        workspace,
        prompt: "/probe Return ready.",
        condition: "passive",
        explicitSkillInvocation: {
          scope: "repository",
          skillName: "probe",
          token: "/probe",
        },
      },
      true,
    ),
  ).toEqual({
    skillName: "probe",
    skillDir,
    skillText: "skill body\n",
    prompt: "/probe Return ready.",
  });
});

test("Claude plugin admission pins the follow-up-only contract disagreement", async () => {
  const fixture = invocationFixture("claude-plugin");
  const plan = prepareHostInvocation({
    case: {
      prompt: "Wait.",
      followUpPrompt: "{{sevro.skill_invocation}} Return ready.",
    },
    hostCapabilities: invocationCapabilities,
    negotiatedCapabilities: invocationCapabilities,
    extensionPreparation: fixture.preparation,
    inlineArtifacts: await prepareArtifacts(fixture.preparation.artifacts, []),
  });
  expect(plan.invocationToken).toBe("/probe:probe");
  const workspace = await realpath(
    await temporaryFixture(join(tmpdir(), "sevro-invocation-")),
  );
  await mkdir(join(workspace, "package/.claude-plugin"), { recursive: true });
  await mkdir(join(workspace, "package/skills/probe"), { recursive: true });
  await writeFile(
    join(workspace, "package/.claude-plugin/plugin.json"),
    '{"name":"probe"}',
  );
  await writeFile(join(workspace, "package/skills/probe/SKILL.md"), "body\n");
  const request = {
    ...plan.hostRequest,
    workspace,
    condition: "passive" as const,
    prompt: "Wait.",
    followUpPrompt: "/probe:probe Return ready.",
  };
  expect(verifyClaudePluginInvocation(request)).rejects.toThrow(
    "invalid Claude explicit skill invocation",
  );
  expect(
    await verifyClaudePluginInvocation({
      ...request,
      prompt: "/probe:probe Return ready.",
      followUpPrompt: "Wait.",
    }),
  ).toEqual([join(workspace, "package")]);
});

for (const kind of invocationKinds) {
  test(`${kind} host preparation preserves declaration errors and capabilities`, async () => {
    const fixture = invocationFixture(kind);
    const input = {
      case: { prompt: "{{sevro.skill_invocation}} Return ready." },
      hostCapabilities: invocationCapabilities,
      negotiatedCapabilities: invocationCapabilities,
      extensionPreparation: fixture.preparation,
      inlineArtifacts: await prepareArtifacts(
        fixture.preparation.artifacts,
        [],
      ),
    };
    const plan = prepareHostInvocation(input);
    expect(plan.invocationToken).toBe(fixture.token);
    expect(plan.hostRequest.explicitSkillInvocation?.skillName).toBe("probe");
    const host = kind.startsWith("codex") ? "Codex" : "Claude";
    const scope = kind.endsWith("repository") ? "repository" : "explicit";
    expect(() =>
      prepareHostInvocation({
        ...input,
        hostCapabilities: invocationCapabilities.filter(
          (c) => c !== fixture.capability,
        ),
      }),
    ).toThrow(`${host} ${scope} invocation capability was not negotiated`);
    expect(() =>
      prepareHostInvocation({
        ...input,
        inlineArtifacts: input.inlineArtifacts.filter(
          (a) => a.relativePath !== fixture.path,
        ),
      }),
    ).toThrow(
      `invalid ${host}${scope === "repository" ? " repository" : ""} skill invocation declaration`,
    );
  });
}

test("Claude repository preparation pins the missing command delimiter disagreement", async () => {
  const fixture = invocationFixture("claude-repository");
  const plan = prepareHostInvocation({
    case: { prompt: "{{sevro.skill_invocation}}." },
    hostCapabilities: invocationCapabilities,
    negotiatedCapabilities: invocationCapabilities,
    extensionPreparation: fixture.preparation,
    inlineArtifacts: await prepareArtifacts(fixture.preparation.artifacts, []),
  });
  expect(plan.invocationToken).toBe("/probe");
  const workspace = await temporaryFixture(join(tmpdir(), "sevro-invocation-"));
  expect(
    verifyClaudeRepositoryMount(
      {
        ...plan.hostRequest,
        workspace,
        condition: "passive",
        prompt: "/probe.",
      },
      true,
    ),
  ).rejects.toThrow("invalid Claude repository skill invocation");
});

test("Codex plugin admission counts the invocation across both turns", async () => {
  const fixture = invocationFixture("codex-plugin");
  const plan = prepareHostInvocation({
    case: {
      prompt: "Wait.",
      followUpPrompt: "{{sevro.skill_invocation}} Return ready.",
    },
    hostCapabilities: invocationCapabilities,
    negotiatedCapabilities: invocationCapabilities,
    extensionPreparation: fixture.preparation,
    inlineArtifacts: await prepareArtifacts(fixture.preparation.artifacts, []),
  });
  const request = {
    ...plan.hostRequest,
    workspace: "/unused",
    condition: "passive" as const,
    prompt: "Wait.",
    followUpPrompt: "$probe:probe Return ready.",
  };
  await verifyCodexInvocation(request);
  expect(
    verifyCodexInvocation({ ...request, prompt: "$probe:probe Wait." }),
  ).rejects.toThrow("invalid Codex explicit skill invocation");
});

test("host invocation rendering preserves neutral and legacy placeholder bytes", () => {
  expect(
    renderSkillInvocation("Use {{sevro.skill_invocation}}.\n", "$probe"),
  ).toBe("Use $probe.\n");
  expect(
    renderSkillInvocation(
      "{{sevro.codex.skill_invocation}} Return ready.",
      "$probe:probe",
    ),
  ).toBe("$probe:probe Return ready.");
  expect(renderSkillInvocation("Keep {{sevro.skill_invocation}}", null)).toBe(
    "Keep {{sevro.skill_invocation}}",
  );
});
