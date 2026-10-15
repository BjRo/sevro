import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexHost } from "../../src/hosts/codex";
import {
  runEvaluation,
  type HostAdapter,
  type EvaluationOptions,
} from "../../src/engine";
import { defined } from "./assertions";

export function artifactEvaluation(
  root: string,
  host: HostAdapter,
  options: Partial<EvaluationOptions> = {},
) {
  return runEvaluation({
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      artifactDirectories: [{ name: "reviews", path: ".darrow/reviews" }],
    },
    shellIsolation: { protectedRoots: [] },
    case: {
      id: "candidate-artifacts",
      prompt: "Write private review evidence.",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "review",
          grader: "sevro.shell",
          configuration: {
            run: 'cat "$SEVRO_CANDIDATE_ARTIFACT_REVIEWS/result"',
            expectExact: "review",
          },
        },
      ],
    },
    ...options,
  });
}

export const nativeRoot =
  '{"type":"session_meta","payload":{"id":"runtime-test"},"future":"preserved"}';

export function createCodexFixture(roots: string[]) {
  async function codexFixture(
    command = "probe",
    additionalProtectedRoots: string[] = [],
    timeoutMs?: number,
  ) {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "sevro-runtime-host-")),
    );
    roots.push(root);
    const project = join(root, "project"),
      results = join(root, "results"),
      workspace = join(root, "workspace"),
      bin = join(root, "tools");
    await Promise.all(
      [project, results, workspace, bin].map((path) => mkdir(path)),
    );
    await writeFile(
      join(bin, "probe"),
      '#!/bin/sh\nprintf "%s" "$SEVRO_RUNTIME_SAMPLE"\n',
    );
    await chmod(join(bin, "probe"), 0o755);
    const codex = defined(Bun.which("codex"));
    const binary = join(root, "candidate");
    await writeFile(
      binary,
      `#!/bin/sh
/bin/cat >/dev/null
profile=$(/usr/bin/sed -n 's/^default_permissions = "\\(.*\\)"/\\1/p' "$CODEX_HOME/config.toml")
/bin/mkdir -p "$CODEX_HOME/sessions"
printf '%s' '${nativeRoot}' > "$CODEX_HOME/sessions/rollout-runtime-test.jsonl"
answer=$('${codex}' sandbox -P "$profile" -C "$PWD" -- /bin/sh -c '${command}' 2>"$PWD/sandbox-error") || answer=unavailable
printf '%s\\n' '{"type":"thread.started","thread_id":"runtime-test"}'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "$answer"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
    );
    await chmod(binary, 0o755);
    const auth = join(root, "auth.json");
    await writeFile(auth, "synthetic-auth");
    const host = createCodexHost({
      binary,
      sandboxBinary: codex,
      authFile: auth,
      projectRoot: project,
      resultsRoot: results,
      additionalProtectedRoots: [auth, ...additionalProtectedRoots],
      model: "synthetic",
      effort: "low",
      timeoutMs,
    });
    return { host, workspace, root, bin };
  }
  return codexFixture;
}

export async function waitForNativeCommand(path: string): Promise<void> {
  for (let index = 0; index < 3000; index++) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error("native command did not start");
}
