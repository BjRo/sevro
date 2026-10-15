import { expect, test } from "bun:test";
import { registerGuideCases } from "../fixtures/guide-evaluation";
import { defined } from "../fixtures/assertions";

const evaluate = registerGuideCases("codex");

test("Sevro guide grading accepts read-only searches with literal path globs", async () => {
  const { result } = await evaluate("unrelated", "glob-read");
  expect(result.exitCode).toBe(0);
  expect(result.task.verdict).toBe("passed");
}, 30000);

test("Guide results use Sevro built-in answer and fixture graders", async () => {
  const { result } = await evaluate("orientation");
  const trial = defined(defined(result.cases[0]).trials[0]);
  expect(
    trial.checks.some(
      (check) => check.grader === "sevro.regex" && check.status === "passed",
    ),
  ).toBe(true);
  expect(
    trial.checks.some(
      (check) => check.grader === "sevro.shell" && check.status === "passed",
    ),
  ).toBe(true);
  expect(
    trial.checks
      .filter((check) => check.grader === "sevro.guide.evidence")
      .map((check) => check.id),
  ).toEqual([
    "sevro.guide.selection",
    "sevro.guide.no-effects",
    "sevro.guide.inspected-citation",
  ]);
}, 30000);
