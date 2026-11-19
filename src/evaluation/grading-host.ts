import { hostArtifacts } from "../evidence/index";
import type { HostResult } from "../host-contract/index";
import { runtimeSeedSources, type RuntimePolicy } from "../runtime/index";
export function scopedHostArtifacts(
  response: HostResult,
  prefix: string,
  artifacts: readonly { id: string }[],
  checks: readonly { id: string }[],
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
