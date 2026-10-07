import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessGuide, failedChecks, followUpSources } from "./assessment";
import { followUpTurn, nativeInvocation } from "./native-invocation";
import { runGuideTurn } from "./native-turn";
import { inspectedSources } from "./observations";
import type { GuideCase, Host } from "./types";
import { fingerprint, guideEnvironment, guideFixture } from "./workspace";

async function trial(
  test: GuideCase,
  host: Host,
  output: string,
  model: string | undefined,
  temporary: string,
) {
  const project = join(temporary, "repository");
  const home = join(temporary, "private-host");
  await guideFixture(project, test.fixture);
  await mkdir(home, { mode: 0o700 });
  const before = await fingerprint(project);
  const env = await guideEnvironment(host, home);
  const session = randomUUID();
  const first = await runGuideTurn(
    host,
    project,
    test.prompt,
    env,
    session,
    model,
  );
  const invocation = await nativeInvocation(host, test, project, home, session);
  const follow = await followUpTurn(
    test,
    host,
    first,
    project,
    env,
    session,
    model,
  );
  const assessment = assessGuide(
    test,
    {
      first,
      follow,
      nativeInvocation: invocation,
      filesUnchanged: before === (await fingerprint(project)),
    },
    invocation !== undefined,
  );
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, `${test.id}.json`),
    JSON.stringify(
      {
        id: test.id,
        host,
        model: model ?? "native default; inspect host init events",
        fixtureDigest: before,
        passed: assessment.passed,
        acceptance: "automatic checks only; human claim grounding required",
        signals: assessment.signals,
        checks: assessment.checks,
        sourceReads: inspectedSources(first),
        followUpSourceReads: followUpSources(follow),
        nativeInvocation: invocation,
        effectAttempts: assessment.attempts,
        first,
        follow,
      },
      null,
      2,
    ),
  );
  console.log(
    `${assessment.passed ? "AUTO PASS" : "FAIL"} ${host}/${test.id}: ${failedChecks(assessment.checks, "all checks")}`,
  );
  return { id: test.id, passed: assessment.passed, checks: assessment.checks };
}

export async function evaluate(
  test: GuideCase,
  host: Host,
  output: string,
  model?: string,
) {
  const temporary = await mkdtemp(join(tmpdir(), "sevro-guide-trial-"));
  try {
    return await trial(test, host, output, model, temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
