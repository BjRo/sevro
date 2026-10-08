import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isRecord, isUnknownArray, isStringArray } from "../src/value-guards";
import { contained } from "./documentation-links";

interface Question {
  id: string;
  sources: string[];
  destination: string;
  cases: string[];
}
function questionPaths(value: Record<string, unknown>) {
  if (
    !isStringArray(value.sources) ||
    !isStringArray(value.cases) ||
    typeof value.destination !== "string"
  )
    throw new Error("invalid guide inventory");
  return {
    sources: value.sources,
    cases: value.cases,
    destination: value.destination,
  };
}
function question(value: unknown): Question {
  const identity = questionIdentity(value),
    paths = questionPaths(identity.value);
  if (!identity.id || !paths.sources.length || !paths.cases.length)
    throw new Error("empty inventory item");
  return { id: identity.id, ...paths };
}
function questionIdentity(value: unknown) {
  if (!isRecord(value) || typeof value.id !== "string")
    throw new Error("invalid guide inventory");
  return { id: value.id, value };
}
function questions(value: unknown): Question[] {
  if (!isRecord(value) || !isUnknownArray(value.questions))
    throw new Error("invalid guide inventory");
  return value.questions.map(question);
}
function caseId(value: unknown): string {
  if (!isRecord(value) || typeof value.id !== "string")
    throw new Error("invalid guide inventory");
  return value.id;
}
function caseIds(value: unknown): Set<string> {
  if (!isUnknownArray(value)) throw new Error("invalid guide inventory");
  return new Set(value.map(caseId));
}
async function verifyQuestionTargets(
  root: string,
  item: Question,
): Promise<void> {
  for (const target of [...item.sources, item.destination]) {
    const path = resolve(root, target);
    if (!contained(root, await realpath(path)))
      throw new Error(`inventory target escapes repository: ${target}`);
    await stat(path);
  }
}
function recordQuestionCases(
  item: Question,
  ids: Set<string>,
  covered: Set<string>,
): void {
  for (const id of item.cases) {
    if (!ids.has(id)) throw new Error(`inventory names absent case: ${id}`);
    covered.add(id);
  }
}
async function verifyInventory(root: string, canonical: string): Promise<void> {
  const raw: unknown = JSON.parse(
    await readFile(resolve(canonical, "evals/inventory.json"), "utf8"),
  );
  const cases: unknown = JSON.parse(
    await readFile(resolve(canonical, "evals/cases.json"), "utf8"),
  );
  const entries = questions(raw),
    ids = caseIds(cases),
    covered = new Set<string>();
  for (const item of entries) {
    await verifyQuestionTargets(root, item);
    recordQuestionCases(item, ids, covered);
  }
  if (covered.size !== ids.size)
    throw new Error("inventory does not cover every case");
}
export async function guideChecks(root: string): Promise<string[]> {
  const errors: string[] = [];
  const canonical = resolve(root, ".agents/skills/sevro-guide"),
    mirror = resolve(root, ".claude/skills/sevro-guide/SKILL.md"),
    source = resolve(canonical, "SKILL.md");
  try {
    if (!(await readFile(source)).equals(await readFile(mirror)))
      errors.push(`${mirror}: guide differs from ${source}`);
    await verifyInventory(root, canonical);
  } catch (error) {
    errors.push(
      `${canonical}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return errors;
}
