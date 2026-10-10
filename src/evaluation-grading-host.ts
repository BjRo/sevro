import { hostArtifacts } from "./evaluation-fixture";
import type { HostResult, ResolvedCase } from "./evaluation-types";
import type { RuntimePolicy } from "./runtime-config";
export function scopedHostArtifacts(
  response: HostResult,
  prefix: string,
  artifacts: { id: string }[],
  checks: ResolvedCase["checks"],
  reservedId: string,
) {
  return hostArtifacts(
    {
      ...response,
      artifacts: response.artifacts?.map((item) => ({
        ...item,
        id: `${prefix}${item.id}`,
      })),
    },
    new Set([
      ...artifacts.map((item) => item.id),
      ...checks.map((item) => item.id),
      reservedId,
    ]),
  );
}
export function gradingRuntimePolicy(policy: RuntimePolicy | undefined) {
  return policy ? { ...policy, hooks: undefined } : undefined;
}
