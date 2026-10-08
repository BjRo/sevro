import { readFile } from "node:fs/promises";
import { join } from "node:path";
import MarkdownIt from "markdown-it";
import { assertCliResult, assertRunEvidence } from "../src/schema";
import type { CliResultData } from "../src/schema-types";
import { runDocumentationCommand } from "./documentation-process";

export function shellExample(text: string, id: string): string {
  const tokens = new MarkdownIt({ html: true }).parse(text, {});
  const marker = tokens.findIndex(
    (token) =>
      token.type === "html_block" &&
      token.content.trim() === `<!-- sevro-example:${id} -->`,
  );
  const fence = tokens[marker + 1];
  if (marker < 0 || fence?.type !== "fence" || fence.info !== "sh")
    throw new Error(`Missing marked shell example: ${id}`);
  return fence.content;
}

function expectedResult(result: CliResultData, expected: string): boolean {
  const grading = expected === "passed" ? "completed" : "not_requested";
  return (
    result.exitCode === 0 &&
    result.execution.status === "completed" &&
    result.task.verdict === expected &&
    result.grading.status === grading
  );
}

async function tutorialCommand(cwd: string, command: string): Promise<void> {
  try {
    await runDocumentationCommand(["/bin/sh", "-eu", "-c", command], cwd);
  } catch (error) {
    throw new Error(
      `${String(error)}; retained CLI result: ${await readFile(join(cwd, "sevro-result.json"), "utf8")}`,
      { cause: error },
    );
  }
}

export async function verifyTutorial(
  cwd: string,
  command: string,
  expected: string,
): Promise<void> {
  await tutorialCommand(cwd, command);
  const result: unknown = JSON.parse(
    await readFile(join(cwd, "sevro-result.json"), "utf8"),
  );
  assertCliResult(result);
  if (!expectedResult(result, expected))
    throw new Error(`Unexpected tutorial result in ${cwd}`);
  if (!result.evidencePath?.startsWith(join(cwd, "sevro-results") + "/"))
    throw new Error(`Evidence escaped results root: ${result.evidencePath}`);
  await verifyTutorialEvidence(result.evidencePath, expected);
}

async function verifyTutorialEvidence(
  path: string,
  expected: string,
): Promise<void> {
  const evidence: unknown = JSON.parse(await readFile(path, "utf8"));
  assertRunEvidence(evidence);
  if (evidence.result.task.verdict !== expected || evidence.trials.length !== 1)
    throw new Error("Retained evidence differs from tutorial result");
}

export async function verifyTutorialModes(
  cwd: string,
  command: string,
): Promise<void> {
  await verifyTutorial(cwd, command, "passed");
  await verifyTutorial(
    cwd,
    command.replaceAll("graded.json", "prompt-only.json"),
    "not_assessed",
  );
}
