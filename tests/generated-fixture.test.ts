import { expectUnknown } from "./fixtures/assertions";
import {
  defined,
  objectContaining,
  parseRunEvidence,
} from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeGeneratedFixture,
  prepareGeneratedFixture,
} from "../src/generated-fixture";
import { runEvaluation, type HostAdapter } from "../src/engine";
const roots: string[] = [];
const digest = "a".repeat(64);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function git(workspace: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, error, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return out.trim();
}
const fixture = {
  kind: "generated" as const,
  commits: [
    { message: "chore: initialize", files: { "README.md": "first\n" } },
    { message: "feat: revise", files: { "README.md": "second\n" } },
  ],
  files: { "README.md": "staged\n", "notes.txt": "untracked\n" },
  staged: ["README.md"],
};
test("generated fixture builds stable history and a declared index state", async () => {
  const prepared = prepareGeneratedFixture(fixture);
  const first = await mkdtemp(join(tmpdir(), "sevro-generated-first-"));
  const second = await mkdtemp(join(tmpdir(), "sevro-generated-second-"));
  roots.push(first, second);
  await materializeGeneratedFixture(prepared, first);
  await materializeGeneratedFixture(prepared, second);
  expect(await git(first, "rev-parse", "HEAD")).toBe(
    await git(second, "rev-parse", "HEAD"),
  );
  expect(await git(first, "log", "-2", "--format=%s")).toBe(
    "feat: revise\nchore: initialize",
  );
  expect(await git(first, "status", "--porcelain=v1")).toContain(
    "M  README.md",
  );
  expect(await git(first, "status", "--porcelain=v1")).toContain(
    "?? notes.txt",
  );
  expect(await readFile(join(first, "README.md"), "utf8")).toBe("staged\n");
  expect(() =>
    prepareGeneratedFixture({
      kind: "generated",
      commits: [{ message: "bad", files: { ".git/config": "escape" } }],
    }),
  ).toThrow(/repository metadata/);
  expect(() =>
    prepareGeneratedFixture({
      kind: "generated",
      commits: [{ message: "bad", files: { "nested/.git/config": "escape" } }],
    }),
  ).toThrow(/repository metadata/);
  expect(() =>
    prepareGeneratedFixture({ ...fixture, staged: ["other.txt"] }),
  ).toThrow(/staging/);
  const scaffold = await mkdtemp(join(tmpdir(), "sevro-generated-scaffold-"));
  roots.push(scaffold);
  await materializeGeneratedFixture(
    prepareGeneratedFixture({
      kind: "generated",
      commits: fixture.commits,
      files: { "guide.txt": "scaffolding\n" },
      commitFiles: true,
    }),
    scaffold,
  );
  expect(await git(scaffold, "log", "-1", "--format=%s")).toBe(
    "Add evaluation scaffolding",
  );
  expect(await git(scaffold, "status", "--porcelain=v1")).toBe("");
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("Git HEAD grading binds the base revision outside candidate control", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-git-head-test-"));
  roots.push(projectRoot);
  const checks = [
    {
      id: "head-changed",
      grader: "sevro.git-head",
      configuration: { kind: "changed" },
    },
    {
      id: "base-ancestor",
      grader: "sevro.git-head",
      configuration: { kind: "base-ancestor" },
    },
  ];
  const run = async (mode: "advance" | "rewind" | "unchanged") => {
    const host: HostAdapter = {
      id: "sevro.host.synthetic",
      model: "synthetic-v1",
      effort: "none",
      async run({ workspace }) {
        if (mode === "advance") {
          await writeFile(join(workspace, "README.md"), "third\n");
          await git(workspace, "add", "README.md");
          await git(workspace, "commit", "-m", "feat: advance");
        } else if (mode === "rewind") {
          await git(workspace, "reset", "--hard", "HEAD~1");
        }
        return {
          finalMessage: "ready",
          complete: true,
          actualCondition: "passive",
        };
      },
    };
    const outcome = await runEvaluation({
      projectRoot,
      resultsRoot: join(projectRoot, `results-${mode}`),
      case: {
        id: `head-${mode}`,
        prompt: "Update the repository.",
        fixture: { kind: "generated", commits: fixture.commits },
        checks:
          mode === "unchanged"
            ? [
                {
                  id: "head-unchanged",
                  grader: "sevro.git-head",
                  configuration: { kind: "unchanged" },
                },
              ]
            : checks,
        requiredEvidence: ["sevro.observation.git-head"],
      },
      host,
      runnerBuildDigest: digest,
      projectDigest: digest,
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
    });
    const evidence = parseRunEvidence(
      await readFile(outcome.result.evidencePath, "utf8"),
    );
    return { outcome, evidence };
  };
  const advanced = await run("advance");
  expect(advanced.outcome.result.exitCode).toBe(0);
  expectUnknown(
    defined(defined(advanced.outcome.result.cases[0]).trials[0]).checks.map(
      (check) => check.status,
    ),
  ).toEqual(["passed", "passed"]);
  expectUnknown(
    defined(advanced.evidence.trials[0]).observations,
  ).toContainEqual(
    objectContaining({
      id: "sevro.observation.git-head",
      source: "sevro.git-head",
      completeness: "complete",
      data: objectContaining({ baseAncestor: true }),
    }),
  );
  const rewound = await run("rewind");
  expectUnknown(
    defined(defined(rewound.outcome.result.cases[0]).trials[0]).checks.map(
      (check) => check.status,
    ),
  ).toEqual(["passed", "failed"]);
  expect(rewound.outcome.result.task.verdict).toBe("failed");
  const unchanged = await run("unchanged");
  expect(unchanged.outcome.result.exitCode).toBe(0);
  expect(
    defined(
      defined(defined(unchanged.outcome.result.cases[0]).trials[0]).checks[0],
    ).status,
  ).toBe("passed");
});
test("Git HEAD checks reject invalid configuration and non-Git fixtures", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-git-head-invalid-"));
  roots.push(projectRoot);
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    run() {
      return Promise.reject(new Error("host must not run"));
    },
  };
  const options = {
    projectRoot,
    resultsRoot: join(projectRoot, "results"),
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive" as const,
    trialCount: 1,
    passThreshold: 1,
  };
  expect(
    runEvaluation({
      ...options,
      case: {
        id: "inline-head",
        prompt: "Return ready.",
        fixture: { files: { "README.md": "inline\n" } },
        checks: [
          {
            id: "head",
            grader: "sevro.git-head",
            configuration: { kind: "unchanged" },
          },
        ],
        requiredEvidence: [],
      },
    }),
  ).rejects.toThrow(/require a Git fixture/);
  expect(
    runEvaluation({
      ...options,
      case: {
        id: "invalid-head",
        prompt: "Return ready.",
        fixture: { kind: "generated", commits: fixture.commits },
        checks: [
          {
            id: "head",
            grader: "sevro.git-head",
            configuration: { kind: "guess" },
          },
        ],
        requiredEvidence: [],
      },
    }),
  ).rejects.toThrow(/invalid Git HEAD check declaration/);
});
test("generated Git hooks run for host commits after fixture preparation", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-hook-test-"));
  roots.push(projectRoot);
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run({ workspace }) {
      await git(workspace, "add", "READY.txt");
      const proc = Bun.spawn(
        [
          "git",
          "-c",
          "user.name=Candidate",
          "-c",
          "user.email=candidate@example.invalid",
          "commit",
          "-m",
          "Try to commit",
        ],
        { cwd: workspace, stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("hook blocked commit");
      expect(await git(workspace, "log", "-1", "--format=%s")).toBe(
        "Initialize",
      );
      return { finalMessage: "ready", complete: true };
    },
  };
  const result = await runEvaluation({
    projectRoot,
    resultsRoot: join(projectRoot, "results"),
    case: {
      id: "hook-case",
      prompt: "Return ready.",
      fixture: {
        kind: "generated",
        commits: [
          { message: "Initialize", files: { "README.md": "source\n" } },
        ],
        files: { "READY.txt": "new\n" },
        hooks: {
          "pre-commit": "#!/bin/sh\necho 'hook blocked commit' >&2\nexit 1\n",
        },
      },
      checks: [
        {
          id: "ready",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
      requiredEvidence: [],
    },
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(result.result.task.verdict).toBe("passed");
  expect(() =>
    prepareGeneratedFixture({
      kind: "generated",
      commits: [{ message: "Initialize", files: { "README.md": "source\n" } }],
      hooks: { "../pre-commit": "exit 1" },
    }),
  ).toThrow(/invalid fixture hooks/);
});
test("fixture binaries reach the host and isolated shell checks", async () => {
  if (process.platform !== "darwin") return;
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-bin-test-"));
  roots.push(projectRoot);
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run({ workspace, fixtureBinDir }) {
      expect(fixtureBinDir).toBe(join(workspace, ".git", "fixture-bin"));
      const proc = Bun.spawn(["fixture-tool"], {
        cwd: workspace,
        env: { PATH: `${fixtureBinDir}:/usr/bin:/bin` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, code] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      expect(stdout).toBe("fixture tool\n");
      return { finalMessage: "ready", complete: true };
    },
  };
  const result = await runEvaluation({
    projectRoot,
    resultsRoot: join(projectRoot, "results"),
    case: {
      id: "bin-case",
      prompt: "Return ready.",
      fixture: {
        kind: "generated",
        commits: [
          { message: "Initialize", files: { "README.md": "source\n" } },
        ],
        bin: { "fixture-tool": "#!/bin/sh\nprintf 'fixture tool\\n'\n" },
      },
      checks: [
        {
          id: "fixture-tool",
          grader: "sevro.shell",
          configuration: { run: "fixture-tool", expectExact: "fixture tool" },
        },
      ],
      requiredEvidence: [],
    },
    host,
    shellIsolation: { protectedRoots: [] },
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
  });
  expect(result.result.task.verdict).toBe("passed");
  expect(() =>
    prepareGeneratedFixture({
      kind: "generated",
      commits: [{ message: "Initialize", files: { "README.md": "source\n" } }],
      bin: { "../fixture-tool": "exit 0" },
    }),
  ).toThrow(/invalid fixture binaries/);
});
test("engine gives each generated trial the same history and a fresh working tree", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sevro-generated-engine-"));
  roots.push(projectRoot);
  const revisions: string[] = [];
  const host: HostAdapter = {
    id: "sevro.host.synthetic",
    model: "synthetic-v1",
    effort: "none",
    async run({ workspace }) {
      expect(
        await Bun.file(join(workspace, "scratch.txt")).exists(),
      ).toBeFalse();
      expect(await git(workspace, "status", "--porcelain=v1")).toContain(
        "M  README.md",
      );
      revisions.push(await git(workspace, "rev-parse", "HEAD"));
      await writeFile(join(workspace, "scratch.txt"), "trial\n");
      return { finalMessage: "ready", complete: true };
    },
  };
  const { result } = await runEvaluation({
    projectRoot,
    resultsRoot: join(projectRoot, "results"),
    case: {
      id: "generated-case",
      prompt: "Return ready.",
      fixture,
      checks: [
        {
          id: "ready",
          grader: "sevro.regex",
          configuration: { pattern: "^ready$" },
        },
      ],
      requiredEvidence: [],
    },
    host,
    runnerBuildDigest: digest,
    projectDigest: digest,
    condition: "passive",
    trialCount: 2,
    passThreshold: 1,
  });
  expect(result.exitCode).toBe(0);
  expect(revisions).toHaveLength(2);
  expect(defined(revisions[0])).toBe(defined(revisions[1]));
});
