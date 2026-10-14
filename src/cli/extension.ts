import { pathToFileURL } from "node:url";
import type { ResolvedCase } from "../engine";
import { openExtensionSession, type ExtensionCase } from "../extension-session";
import { resolvedFixture } from "../resolved-case";
import { InvocationError, type Invocation } from "./invocation";
import { parseCase, loadExtensionOptions } from "./loading";
import type { PreparedInvocation } from "./preparation";

function selectExtensionCase(
  cases: ExtensionCase[],
  caseId: string,
): { caseData: ResolvedCase; resolvedCase: ExtensionCase } {
  const resolvedCase = cases.find((item) => item.id === caseId);
  if (!resolvedCase)
    throw new InvocationError("extension did not resolve the selected case");
  const caseData = parseCase({
    ...resolvedCase,
    fixture: resolvedFixture(resolvedCase.fixture),
  });
  return { caseData, resolvedCase };
}

async function resolveSelectedExtension(
  prepared: PreparedInvocation,
  selected: NonNullable<Invocation["extension"]>,
  signal: AbortSignal,
) {
  const { invocation, host } = prepared;
  const options = await loadExtensionOptions(selected);
  const hostCapabilities = [
    ...(host.instrumentation ?? []).map((item) => item.id),
    ...(host.hostCapabilities ?? []),
  ];
  const session = await openExtensionSession({
    ...options,
    sourceFiles: selected.sourceFiles,
    engineCapabilities: [
      "sevro.host.exec",
      "sevro.fixture.setup",
      "sevro.case.host-route",
    ],
    hostCapabilities,
    taskVerdictPolicy: selected.taskVerdictPolicy,
    replaceBuiltinGraders: selected.replaceBuiltinGraders,
    signal,
  });
  const chosen = selectExtensionCase(
    await session.resolve(
      pathToFileURL(invocation.projectRoot).href,
      { caseIds: [selected.caseId] },
      {
        id: host.id,
        model: host.model,
        effort: host.effort,
        capabilities: hostCapabilities,
      },
    ),
    selected.caseId,
  );
  return {
    caseData: chosen.caseData,
    extension: { session, resolvedCase: chosen.resolvedCase },
  };
}

export async function selectedCase(
  prepared: PreparedInvocation,
  signal: AbortSignal,
) {
  if (prepared.invocation.extension)
    return resolveSelectedExtension(
      prepared,
      prepared.invocation.extension,
      signal,
    );
  if (!prepared.caseData)
    throw new InvocationError("invalid resolved case file");
  return { caseData: prepared.caseData, extension: undefined };
}
