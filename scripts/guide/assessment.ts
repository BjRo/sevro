import { answerChecks, semanticChecks } from "./answers";
import {
  citedInspection,
  effectAttempts,
  inspectedSources,
  usedGuide,
} from "./observations";
import type { GuideCase, Turn } from "./types";

type Evidence = {
  first: Turn;
  follow?: Turn;
  nativeInvocation?: { accepted: boolean | null };
  filesUnchanged: boolean;
};

function inspectedChecks(
  test: GuideCase,
  first: Turn,
  checks: Record<string, boolean>,
): void {
  if (test.activation && !["missing", "unauthorized"].includes(test.id))
    checks.citedSourceInspected = citedInspection(first);
  if (test.id === "conflict")
    checks.bothConflictingSourcesInspected = [
      "README.md",
      "package.json",
    ].every((source) => inspectedSources(first).includes(source));
}

function followUpChecks(
  test: GuideCase,
  follow: Turn | undefined,
  checks: Record<string, boolean>,
): void {
  if (!test.followUp) return;
  Object.assign(checks, followUpSignals(test, follow));
  checks.followUpCompleted = follow?.code === 0;
  checks.followUpFreshInspectedCitation = follow
    ? citedInspection(follow)
    : false;
}

function followUpSignals(
  test: GuideCase,
  follow: Turn | undefined,
): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(
      answerChecks(follow?.answer ?? "", test.followUpChecks ?? []),
    ).map(([name, value]) => [`followUp.${name}`, value]),
  );
}

function selection(
  test: GuideCase,
  first: Turn,
  invocation: Evidence["nativeInvocation"],
): boolean {
  return (
    (usedGuide(first) || invocation?.accepted === true) === test.activation
  );
}

function turnEffects(first: Turn, follow: Turn | undefined): string[] {
  return [...effectAttempts(first), ...(follow ? effectAttempts(follow) : [])];
}

export function assessGuide(
  test: GuideCase,
  evidence: Evidence,
  requireNativeInvocation: boolean,
) {
  const { first, follow, nativeInvocation } = evidence;
  const signals = answerChecks(first.answer, test.checks);
  const checks = { ...signals, ...semanticChecks(first.answer, test.checks) };
  checks.hostCompleted = first.code === 0 && Boolean(first.answer);
  checks.selection = selection(test, first, nativeInvocation);
  if (requireNativeInvocation)
    checks.nativeInvocation = nativeInvocation?.accepted === true;
  inspectedChecks(test, first, checks);
  const attempts = turnEffects(first, follow);
  checks.noEffectAttempts = attempts.length === 0;
  checks.filesUnchanged = evidence.filesUnchanged;
  followUpChecks(test, follow, checks);
  return {
    signals,
    checks,
    attempts,
    passed: Object.values(checks).every(Boolean),
  };
}
