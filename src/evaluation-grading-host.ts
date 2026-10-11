import { hostArtifacts } from "./evaluation-fixture";
import type { HostResult, ResolvedCase } from "./evaluation-types";
import { runtimeSeedSources, type RuntimePolicy } from "./runtime-config";
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
export function gradingRuntimePolicy(
  policy: RuntimePolicy | undefined,
  responseOnly = false,
) {
  if (!policy) return undefined;
  return {
    ...policy,
    hooks: undefined,
    seedReadDenyRoots: runtimeSeedSources(policy),
    seeds: responseOnly
      ? (policy.seeds ?? []).filter((seed) => seed.roles?.includes("semantic"))
      : policy.seeds,
  };
}
