import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runEvaluation, type HostAdapter } from "../../src/engine";
import { openExtensionSession } from "../../src/extension-session";
import { workspaceFingerprint } from "../../src/hosts/workspace-fingerprint";
import {
  packageBuildDigest,
  projectIdentityDigest,
  projectProvenance,
} from "../../src/provenance";
import { resolvedFixture } from "../../src/resolved-case";
import { atomicWriteJson } from "../../src/storage";
import { casesPath, fixtureSources, guideRoot } from "./fixture";
import { workspaceObservation } from "./grading";

export function observedHost(host: HostAdapter): HostAdapter {
  return {
    ...host,
    configuration: {
      ...host.configuration,
      "sevro.guide.workspace-observation": true,
    },
    async run(request) {
      const before = await workspaceFingerprint(request.workspace);
      const result = await host.run(request);
      const after = await workspaceFingerprint(request.workspace);
      const measured = before !== null && after !== null;
      return {
        ...result,
        observations: [
          ...(result.observations ?? []),
          {
            id: workspaceObservation,
            completeness: measured ? "complete" : "unavailable",
            data: { unchanged: measured && before === after },
          },
        ],
      };
    },
  };
}

export async function guideSession(host: HostAdapter, signal?: AbortSignal) {
  const code = [...new Bun.Glob("*.ts").scanSync({ cwd: import.meta.dir })];
  const sourceFiles = [
    ...new Set([
      ...code.map((name) => join(import.meta.dir, name)),
      join(guideRoot, casesPath),
      ...(await fixtureSources()).map((path) => join(guideRoot, path)),
      join(guideRoot, "src/value-guards.ts"),
      join(guideRoot, "src/generated/extension.cjs"),
      join(guideRoot, "src/hosts/codex-events.ts"),
      join(guideRoot, "src/hosts/claude-events.ts"),
    ]),
  ];
  return openExtensionSession({
    command: [process.execPath, join(import.meta.dir, "extension.ts")],
    sourceFiles,
    configuration: {},
    redactedConfiguration: {},
    engineCapabilities: ["sevro.host.exec", "sevro.case.host-route"],
    hostCapabilities: host.hostCapabilities ?? [],
    ...(signal ? { signal } : {}),
  });
}

export async function evaluateGuide(
  caseId: string,
  host: HostAdapter,
  options: { dry?: boolean; resultsRoot?: string; signal?: AbortSignal } = {},
) {
  const selected = observedHost(host);
  const session = await guideSession(selected, options.signal);
  const [resolvedCase] = await session.resolve(
    pathToFileURL(guideRoot).href,
    { caseIds: [caseId] },
    {
      id: selected.id,
      model: selected.model,
      effort: selected.effort,
      capabilities: selected.hostCapabilities ?? [],
    },
  );
  if (!resolvedCase) throw new Error("Guide extension resolved no case");
  const resultsRoot = options.resultsRoot ?? join(guideRoot, ".guide-results");
  const outcome = await runEvaluation({
    projectRoot: guideRoot,
    resultsRoot,
    case: { ...resolvedCase, fixture: resolvedFixture(resolvedCase.fixture) },
    extension: { session, resolvedCase },
    host: selected,
    runnerBuildDigest: await packageBuildDigest(),
    runnerCheckoutRoot: guideRoot,
    projectDigest: await projectIdentityDigest(
      guideRoot,
      await projectProvenance(guideRoot),
      [resultsRoot],
    ),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    ...options,
  });
  await atomicWriteJson(
    join(dirname(outcome.result.evidencePath), "result.json"),
    outcome.result,
  );
  return outcome;
}
