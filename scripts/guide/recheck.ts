import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assessGuide, failedChecks, followUpSources } from "./assessment";
import { inspectedSources } from "./observations";
import { parseGuideEvidence, parseGuideSummary } from "./records";
import type { GuideCase, Host } from "./types";
import { guideRoot } from "./workspace";

async function evidenceDirectory(
  path: string,
  host: Host,
  digest: string,
): Promise<string> {
  const directory = await realpath(path);
  if (
    !directory.startsWith(
      (await realpath(join(guideRoot, ".guide-results"))) + "/",
    )
  )
    throw new Error(
      "Rechecks require an existing local guide evidence directory",
    );
  const summary = parseGuideSummary(
    await readFile(join(directory, "summary.json"), "utf8"),
  );
  if (summary.skillDigest !== digest || summary.host !== host)
    throw new Error("Evidence has a different guide body or host");
  return directory;
}

async function recheckCase(test: GuideCase, host: Host, directory: string) {
  const evidence = parseGuideEvidence(
    await readFile(join(directory, `${test.id}.json`), "utf8"),
  );
  const { checks, passed } = assessGuide(
    test,
    evidence,
    host === "claude" && test.prompt.startsWith("$sevro-guide"),
  );
  console.log(
    `${passed ? "RECHECK PASS" : "FAIL"} ${host}/${test.id}: ${failedChecks(checks, "automatic checks")}`,
  );
  return {
    id: test.id,
    passed,
    checks,
    sourceReads: inspectedSources(evidence.first),
    followUpSourceReads: followUpSources(evidence.follow),
  };
}

export async function recheck(
  selected: GuideCase[],
  host: Host,
  digest: string,
  path: string,
): Promise<void> {
  const directory = await evidenceDirectory(path, host, digest);
  const results = [];
  for (const test of selected)
    results.push(await recheckCase(test, host, directory));
  await writeFile(
    join(directory, "automatic-recheck.json"),
    JSON.stringify(
      {
        host,
        skillDigest: digest,
        acceptance:
          "reclassified original native events; human grounding required; no new model calls",
        results,
      },
      null,
      2,
    ),
  );
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}
