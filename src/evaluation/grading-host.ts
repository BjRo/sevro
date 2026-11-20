import { runtimeSeedSources, type RuntimePolicy } from "../runtime/index";
/** Judge requests run without hooks and cannot read seed sources. */
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
