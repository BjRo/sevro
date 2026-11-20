import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runEvaluation } from "../../../src/evaluation/index";
import { openExtensionSession } from "../../../src/extensions/index";
import { EvaluationConfigurationError as ConfigurationError } from "../../../src/host-contract/index";
import { defined } from "../../fixtures/assertions";
import { wireCase, wireOptions } from "../../fixtures/engine-session";
import { createEvaluation } from "../../fixtures/evaluation-fixtures";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import {
  invocationFixture,
  invocationKinds,
  invocationCapabilities,
  type InvocationKind,
} from "../../fixtures/skill-invocation";

const roots: string[] = [];
afterEach(createTemporaryFixtures(roots).cleanupTemporaryFixtures);
const evaluation = createEvaluation(roots);

async function fixture(kind: InvocationKind) {
  const selected = invocationFixture(kind);
  const options = await evaluation({ finalMessage: "ready", complete: true });
  const gitFixture = {
    kind: "generated" as const,
    commits: [{ message: "Baseline", files: { "README.md": "baseline\n" } }],
  };
  const sessionOptions = wireOptions({
    describe: {
      extension: { id: "example.extension", version: "1.0.0" },
      protocols: ["sevro.extension.v1"],
      requiredCapabilities: [],
      optionalCapabilities: invocationCapabilities,
      graders: [],
      taskVerdictPolicies: [],
    },
    resolve: {
      cases: [
        {
          ...wireCase,
          checks: [],
          prompt: "{{sevro.skill_invocation}} Return ready.",
          fixture: gitFixture,
        },
      ],
    },
    prepare: selected.preparation,
    evaluate: { checks: [], metrics: [] },
  });
  sessionOptions.engineCapabilities = invocationCapabilities;
  sessionOptions.hostCapabilities = invocationCapabilities;
  const session = await openExtensionSession(sessionOptions);
  const resolvedCase = defined(
    (await session.resolve(pathToFileURL(options.projectRoot).href, {}))[0],
  );
  // The real negotiated session supplies the declared package; changing its mutable
  // response lets each characterization exercise preparation through evaluation.
  session.prepare = () => Promise.resolve(selected.preparation);
  options.case = {
    ...resolvedCase,
    prompt: "{{sevro.skill_invocation}} Return ready.",
    fixture: gitFixture,
  };
  options.extension = { session, resolvedCase };
  options.host.hostCapabilities = invocationCapabilities;
  return { options, ...selected };
}

for (const kind of invocationKinds) {
  test(`${kind} evaluation preserves token, scope and capability`, async () => {
    const f = await fixture(kind);
    let called = false;
    f.options.host.run = (request) => {
      called = true;
      expect(request.prompt).toBe(`${f.token} Return ready.`);
      expect(request.explicitSkillInvocation).toEqual(
        kind.endsWith("repository")
          ? { scope: "repository", skillName: "probe", token: f.token }
          : { pluginName: "probe", skillName: "probe", token: f.token },
      );
      return Promise.resolve({ finalMessage: "ready", complete: true });
    };
    expect((await runEvaluation(f.options)).result.exitCode).toBe(0);
    expect(called).toBe(true);
  });

  for (const rejection of [
    "missing body",
    "missing placeholder",
    "repeated placeholder",
    "unnegotiated host",
    "unnegotiated extension",
  ] as const) {
    test(`${kind} evaluation pins ${rejection} diagnostic`, async () => {
      const f = await fixture(kind);
      switch (rejection) {
        case "missing body":
          f.preparation.artifacts = f.preparation.artifacts.filter(
            (a) => a.relativePath !== f.path,
          );
          break;
        case "missing placeholder":
          f.options.case.prompt = "Return ready.";
          break;
        case "repeated placeholder":
          f.options.case.prompt += " {{sevro.skill_invocation}}";
          break;
        case "unnegotiated host":
          f.options.host.hostCapabilities = invocationCapabilities.filter(
            (c) => c !== f.capability,
          );
          break;
        case "unnegotiated extension":
          f.options.extension = {
            ...defined(f.options.extension),
            session: {
              ...defined(f.options.extension).session,
              identity: {
                ...defined(f.options.extension).session.identity,
                capabilities: invocationCapabilities.filter(
                  (c) => c !== f.capability,
                ),
              },
            },
          };
          break;
      }
      defined(f.options.extension).resolvedCase.prompt = f.options.case.prompt;
      let calls = 0;
      f.options.host.run = () => {
        calls++;
        return Promise.resolve({ finalMessage: "ready", complete: true });
      };
      const message = rejectionMessage(kind, rejection);
      const error: unknown = await runEvaluation(f.options).catch(
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).toHaveProperty("message", message);
      expect(calls).toBe(0);
      expect(existsSync(f.options.resultsRoot)).toBe(false);
    });
  }
}

function rejectionMessage(kind: InvocationKind, rejection: string): string {
  const host = kind.startsWith("codex") ? "Codex" : "Claude";
  const repository = kind.endsWith("repository");
  if (rejection.startsWith("unnegotiated"))
    return `${host} ${repository ? "repository" : "explicit"} invocation capability was not negotiated`;
  return `invalid ${host}${repository ? " repository" : ""} skill invocation declaration`;
}
