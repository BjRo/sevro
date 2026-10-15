import type { HostResult } from "../evaluation/types";
import type { UsageEvidence } from "../contract-types";

export function usage(result: HostResult | null): UsageEvidence {
  return result === null
    ? { inputTokens: null, outputTokens: null, costUsd: null, complete: false }
    : availableUsage(result);
}

function availableUsage(result: HostResult): UsageEvidence {
  return {
    inputTokens: result.inputTokens ?? null,
    outputTokens: result.outputTokens ?? null,
    costUsd: result.costUsd ?? null,
    complete: result.usageComplete ?? false,
  };
}
