import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type {
  EvaluationRequest,
  EvaluationResult,
} from "../../src/extension-session";
import { summarizeCodexEvents } from "../../src/hosts/codex-events";
import { summarizeClaudeEvents } from "../../src/hosts/claude-events";
import { isRecord } from "../../src/value-guards";
import { assessGuide } from "./assessment";
import { parseGuideCases } from "./records";
import type { GuideCase, Host, Turn } from "./types";

export const workspaceObservation = "sevro.guide.workspace";

export function guideCheckId(name: string): string {
  return (
    "sevro.guide." +
    name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())
  );
}

export function invocationObservation(host: Host): string {
  return host === "codex"
    ? "sevro.codex.explicit-invocation"
    : "sevro.claude.repository-invocation";
}

export function eventArtifact(
  host: Host,
  phase: "initial" | "follow-up",
  followUp: boolean,
): string {
  if (phase === "follow-up") return `sevro.${host}.follow-up-events`;
  return host === "claude" && followUp
    ? "sevro.claude.initial-events"
    : `sevro.${host}.events`;
}

export function guideChecks(test: GuideCase): string[] {
  return Object.keys(
    assessGuide(
      test,
      {
        first: { answer: "", code: 1, diagnostic: "", events: [] },
        filesUnchanged: false,
      },
      test.prompt.startsWith("$sevro-guide"),
    ).checks,
  );
}

function parseEvents(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) throw new Error("Invalid guide host event");
      return value;
    });
}

function turnSummary(host: Host, text: string): Turn | undefined {
  const summary =
    host === "codex"
      ? summarizeCodexEvents(text, 0)
      : summarizeClaudeEvents(text, 0);
  if (!summary.complete || summary.finalMessage === null) return undefined;
  return {
    answer: summary.finalMessage,
    code: 0,
    diagnostic: "",
    events: parseEvents(text),
  };
}

async function eventBytes(path: URL): Promise<Buffer> {
  if (path.protocol !== "file:") throw new Error("Invalid guide artifact URL");
  if ((await stat(path)).size > 8 * 1024 * 1024)
    throw new Error("Oversized guide event artifact");
  const bytes = await readFile(path);
  if (bytes.byteLength > 8 * 1024 * 1024)
    throw new Error("Oversized guide event artifact");
  return bytes;
}

async function retainedTurn(
  request: EvaluationRequest,
  host: Host,
  id: string,
): Promise<Turn | undefined> {
  const artifact = request.artifacts.find((item) => item.id === id);
  if (!artifact) return undefined;
  const path = new URL(artifact.path);
  const bytes = await eventBytes(path);
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
    throw new Error("Guide event artifact digest differs");
  return turnSummary(host, bytes.toString("utf8"));
}

function completeObservation(request: EvaluationRequest, id: string) {
  return request.observations.find(
    (item) => item.id === id && item.completeness === "complete",
  );
}

function nativeInvocation(request: EvaluationRequest, host: Host) {
  const receipt = completeObservation(request, invocationObservation(host));
  if (!receipt) return undefined;
  const data = receipt.data;
  const accepted =
    host === "codex"
      ? data.method === "explicit_invocation" &&
        data.primarySkill === "sevro-guide"
      : data.accepted === true && data.skill === "sevro-guide";
  return { accepted };
}

export async function gradeGuide(
  request: EvaluationRequest,
): Promise<EvaluationResult> {
  const evidence = await guideEvidence(request);
  const { test, first, follow, workspace, explicit, receipt, refs } = evidence;
  const available = evidenceAvailable(evidence);
  const assessment = assessGuide(
    test,
    {
      first: first ?? { answer: "", code: 1, diagnostic: "", events: [] },
      ...followEvidence(follow, receipt),
      filesUnchanged: workspace?.data.unchanged === true,
    },
    explicit,
  );
  return {
    checks: Object.entries(assessment.checks).map(([name, passed]) => ({
      id: guideCheckId(name),
      status: available ? (passed ? "passed" : "failed") : "unavailable",
      evidenceRefs: available ? refs : [],
    })),
    metrics: [],
  };
}

function followEvidence(
  follow: Turn | undefined,
  receipt: { accepted: boolean } | undefined,
) {
  return {
    ...(follow ? { follow } : {}),
    ...(receipt ? { nativeInvocation: receipt } : {}),
  };
}

async function guideEvidence(request: EvaluationRequest) {
  const { test, host } = guideCaseData(request);
  const initialId = eventArtifact(host, "initial", Boolean(test.followUp));
  const first = await retainedTurn(request, host, initialId);
  const followId = eventArtifact(host, "follow-up", true);
  const follow = await followTurn(request, host, test.followUp);
  const workspace = completeObservation(request, workspaceObservation);
  const explicit = test.prompt.startsWith("$sevro-guide");
  const receipt = nativeInvocation(request, host);
  const refs = [initialId, workspaceObservation];
  if (test.followUp) refs.push(followId);
  if (explicit) refs.push(invocationObservation(host));
  return { test, first, follow, workspace, explicit, receipt, refs };
}

function guideCaseData(request: EvaluationRequest): {
  test: GuideCase;
  host: Host;
} {
  const [test] = parseGuideCases(
    JSON.stringify([request.extensionData["sevro.guide.case"]]),
  );
  if (!test) throw new Error("Missing guide case");
  const host = request.extensionData["sevro.guide.host"];
  if (host !== "codex" && host !== "claude")
    throw new Error("Invalid guide host");
  return { test, host };
}

async function followTurn(
  request: EvaluationRequest,
  host: Host,
  followUp?: string,
) {
  if (!followUp) return undefined;
  return retainedTurn(request, host, eventArtifact(host, "follow-up", true));
}

function evidenceAvailable(
  evidence: Awaited<ReturnType<typeof guideEvidence>>,
): boolean {
  if (!evidence.first || !evidence.workspace) return false;
  return optionalEvidenceAvailable(evidence);
}

function optionalEvidenceAvailable(
  evidence: Awaited<ReturnType<typeof guideEvidence>>,
): boolean {
  if (evidence.test.followUp && !evidence.follow) return false;
  if (evidence.explicit) return evidence.receipt !== undefined;
  return true;
}
