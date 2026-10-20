import { dirname, join } from "node:path";
import { atomicWriteJson } from "../storage";
import type { CliResult } from "../engine";
import { createReport } from "../report";
import { withResultsLock } from "../results-lock";

/** Latest means the last successfully retained CLI result, including dry/failing runs. */
export async function retainCliResult(result: CliResult, resultsRoot: string) {
  return withResultsLock(resultsRoot, async () => {
    const resultFile = join(dirname(result.evidencePath), "result.json");
    await atomicWriteJson(resultFile, result);
    await atomicWriteJson(join(resultsRoot, "latest.json"), result);
    return { resultFile, report: await createReport([resultFile]) };
  });
}
