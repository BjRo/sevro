import type { FileCoverageData, Range } from "istanbul-lib-coverage";
import { analyzeCompilerFlow } from "./compiler-flow";
import type { FlowProof } from "./compiler-flow";
import { analyzeCounterCopies } from "./compiler-counter-copy";

export type CompilerExemption = {
  metric: "statements" | "branches";
  id: string;
  outcome?: number;
  location: Range;
  proofLocation: Range;
  reason: "compiler-local-guard" | "unreachable-guard-arm";
};
export type GuardProof = FlowProof & { branchId: string };

function position(location: Range): string {
  return `${location.start.line}:${location.start.column}`;
}

export function deriveCompilerExemptions(text: string, file: FileCoverageData) {
  const byLocation = new Map(
    [...analyzeCounterCopies(text), ...analyzeCompilerFlow(text)].map(
      (proof) => [position(proof.location), proof],
    ),
  );
  const proofs = Object.entries(file.branchMap).flatMap(
    ([branchId, branch]): GuardProof[] => {
      const proof = byLocation.get(position(branch.loc));
      return branch.type === "if" && proof ? [{ ...proof, branchId }] : [];
    },
  );
  const entries = [
    ...guardExemptions(proofs, file),
    ...deadStatementExemptions(proofs, file),
    ...deadBranchExemptions(proofs, file),
  ];
  const unique = new Map<string, CompilerExemption>();
  for (const entry of entries)
    if (!unique.has(exemptionKey(entry)))
      unique.set(exemptionKey(entry), entry);
  return { proofs, exemptions: [...unique.values()] };
}

export function exemptionKey(entry: CompilerExemption): string {
  return `${entry.metric}:${entry.id}:${entry.outcome ?? ""}`;
}

function guardExemptions(
  proofs: GuardProof[],
  file: FileCoverageData,
): CompilerExemption[] {
  return proofs.map((proof) => ({
    metric: "branches",
    id: proof.branchId,
    outcome: proof.outcome,
    location: file.branchMap[proof.branchId]?.loc ?? proof.location,
    proofLocation: proof.location,
    reason: "compiler-local-guard",
  }));
}

function containingProof(
  proofs: GuardProof[],
  location: Range,
): GuardProof | undefined {
  return proofs.find(
    (proof) =>
      proof.unreachableRange && contains(proof.unreachableRange, location),
  );
}

function contains(outer: Range, inner: Range): boolean {
  return before(outer.start, inner.start) && before(inner.end, outer.end);
}

function before(left: Range["start"], right: Range["start"]): boolean {
  return (
    left.line < right.line ||
    (left.line === right.line && left.column <= right.column)
  );
}

function deadStatementExemptions(
  proofs: GuardProof[],
  file: FileCoverageData,
): CompilerExemption[] {
  return Object.entries(file.statementMap).flatMap(
    ([id, location]): CompilerExemption[] => {
      const proof = containingProof(proofs, location);
      return proof
        ? [
            {
              metric: "statements",
              id,
              location,
              proofLocation: proof.location,
              reason: "unreachable-guard-arm",
            },
          ]
        : [];
    },
  );
}

function deadBranchExemptions(
  proofs: GuardProof[],
  file: FileCoverageData,
): CompilerExemption[] {
  return Object.entries(file.branchMap).flatMap(
    ([id, branch]): CompilerExemption[] => {
      const proof = containingProof(proofs, branch.loc);
      if (!proof) return [];
      return branch.locations.map((_, outcome) => ({
        metric: "branches",
        id,
        outcome,
        location: branch.loc,
        proofLocation: proof.location,
        reason: "unreachable-guard-arm",
      }));
    },
  );
}
