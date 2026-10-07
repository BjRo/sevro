import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { evaluate } from "./evaluation";
import { parseGuideCases } from "./records";
import { recheck } from "./recheck";
import type { CaseResult, GuideCase, Host } from "./types";
import { guidePath, guideRoot } from "./workspace";

function parseHost(value: string | undefined): Host {
  if (value !== "codex" && value !== "claude")
    throw new Error("--host codex|claude is required");
  return value;
}

async function checkedTrial(
  test: GuideCase,
  host: Host,
  output: string,
  model: string | undefined,
): Promise<CaseResult> {
  try {
    return await evaluate(test, host, output, model);
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    console.error(`${test.id}: ${diagnostic}`);
    return { id: test.id, passed: false, diagnostic };
  }
}

async function nativeTrials(
  selected: GuideCase[],
  host: Host,
  digest: string,
  model: string | undefined,
  jobsValue: string | undefined,
): Promise<void> {
  const output = join(guideRoot, ".guide-results", `${Date.now()}-${host}`);
  const results: CaseResult[] = [];
  const jobs = Number(jobsValue ?? "2");
  if (![1, 2].includes(jobs)) throw new Error("--jobs must be 1 or 2");
  for (let offset = 0; offset < selected.length; offset += jobs)
    results.push(
      ...(await Promise.all(
        selected
          .slice(offset, offset + jobs)
          .map((test) => checkedTrial(test, host, output, model)),
      )),
    );
  const version = Bun.spawnSync([host, "--version"]).stdout.toString().trim();
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "summary.json"),
    JSON.stringify(
      {
        host,
        version,
        platform: process.platform,
        arch: process.arch,
        bun: Bun.version,
        skillDigest: digest,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`Native guide evidence: ${output}`);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}

function options() {
  return parseArgs({
    args: Bun.argv.slice(2),
    options: {
      host: { type: "string" },
      case: { type: "string" },
      model: { type: "string" },
      jobs: { type: "string" },
      recheck: { type: "string" },
      dry: { type: "boolean" },
    },
    strict: true,
  }).values;
}

export async function guideMain(): Promise<void> {
  const values = options();
  const host = parseHost(values.host);
  const cases = parseGuideCases(
    await readFile(
      join(guideRoot, ".agents/skills/sevro-guide/evals/cases.json"),
      "utf8",
    ),
  );
  const selected = values.case
    ? cases.filter((test) => test.id === values.case)
    : cases;
  if (!selected.length) throw new Error("No matching guide case");
  const digest = createHash("sha256")
    .update(await readFile(join(guideRoot, guidePath)))
    .digest("hex");
  if (values.recheck) await recheck(selected, host, digest, values.recheck);
  else if (values.dry)
    console.log(
      `Dry validation: ${selected.length} cases, ${resolve(guideRoot, guidePath)}, sha256 ${digest}. Native host remains unverified.`,
    );
  else await nativeTrials(selected, host, digest, values.model, values.jobs);
}
