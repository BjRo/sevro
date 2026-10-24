import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCodexHost } from "../../../src/hosts/codex";
import {
  defined,
  expectUnknown,
  objectContaining,
} from "../../fixtures/assertions";
import {
  fixture,
  isolatedNativeHost,
  ordinaryCodexOptions,
  ordinaryCodexRequest,
} from "../../fixtures/codex-host";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("Codex continuation stays partial when the workspace fingerprint cannot be read", async () => {
  if (!isolatedNativeHost || !Bun.which("codex")) return;
  const { host, request } = await ordinaryCodexRequest(roots);
  const path = join(request.workspace, "unreadable.txt");
  await writeFile(path, "private content");
  await chmod(path, 0);
  try {
    const result = await host.run({ ...request, followUpPrompt: "Continue." });
    expect(result.complete).toBe(true);
    expect(
      result.observations?.find(
        (item) => item.id === "sevro.codex.continuation",
      ),
    ).toMatchObject({
      completeness: "partial",
      data: { preFollowUpWorktreeUnchanged: null },
    });
  } finally {
    await chmod(path, 0o600);
  }
});

test("failed app-server execution cannot yield a complete owner-dispatch receipt", async () => {
  if (!isolatedNativeHost || !Bun.which("codex")) return;
  const selected = await ordinaryCodexRequest(roots);
  await mkdir(join(selected.workspace, ".git"));
  await writeFile(join(selected.workspace, "failure.txt"), "Fail the turn");
  const skillRoot = join(selected.workspace, ".agents/skills/probe");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: probe\n---\nRead the skill.\n",
  );
  const binary = join(dirname(selected.paths.fakeBinary), "failed-owner-peer");
  await writeFile(
    binary,
    `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "../../fixtures/app-server-peer.ts")}' "$@"\n`,
    { mode: 0o700 },
  );
  const host = createCodexHost({
    ...ordinaryCodexOptions,
    ...selected.paths,
    binary,
    authFile: selected.paths.authFile,
    sandboxBinary: defined(Bun.which("codex")),
    entrypoint: "app-server",
  });
  const result = await host.run({
    ...selected.request,
    prompt: "Use $probe and return ready.",
    explicitSkillInvocation: {
      scope: "repository",
      skillName: "probe",
      token: "$probe",
    },
  });
  expect(result.complete).toBe(false);
  expectUnknown(result.observations).toContainEqual({
    id: "sevro.codex.explicit-invocation",
    completeness: "partial",
    data: {
      method: "explicit_invocation",
      primarySkill: "probe",
    },
  });
});

test("Codex host refuses an otherwise valid stream without a completed turn", async () => {
  if (!isolatedNativeHost || !Bun.which("codex")) return;
  const selected = await ordinaryCodexRequest(roots);
  await writeFile(join(selected.workspace, "incomplete.flag"), "");
  expect(selected.host.run(selected.request)).rejects.toThrow(
    "Codex turn did not complete",
  );
  expect(await readFile(join(selected.workspace, "prompt.txt"), "utf8")).toBe(
    selected.request.prompt,
  );
});

test("Codex continuation keeps combined usage unknown when the initial turn omits usage", async () => {
  if (!isolatedNativeHost || !Bun.which("codex")) return;
  const selected = await ordinaryCodexRequest(roots);
  await writeFile(join(selected.workspace, "unknown-usage.flag"), "");
  const result = await selected.host.run({
    ...selected.request,
    followUpPrompt: "Continue.",
  });
  expect(result.complete).toBe(true);
  expect(result.finalMessage).toBe("follow-up ready");
  expect(result.inputTokens).toBeNull();
  expect(result.outputTokens).toBeNull();
  expect(result.usageComplete).toBe(false);
});

test("Codex host resumes a second prompt in the initial thread", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture(roots);
  const workspace = await temporaryFixture(
    join(tmpdir(), "sevro-codex-continuation-"),
  );

  await writeFile(join(workspace, "native-calls.flag"), "\n");
  await writeFile(join(workspace, "native-feedback.flag"), "\n");
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  const result = await host.run({
    prompt: "Initial instruction.",
    followUpPrompt: "Continue in this thread.",
    workspace,
    condition: "passive",
  });
  expect(await readFile(join(workspace, "prompt.txt"), "utf8")).toBe(
    "Initial instruction.",
  );
  expect(await readFile(join(workspace, "follow-up-prompt.txt"), "utf8")).toBe(
    "Continue in this thread.",
  );
  expect(await readFile(join(workspace, "argv.txt"), "utf8")).not.toContain(
    "--ephemeral",
  );
  const resumeArgv = await readFile(join(workspace, "resume-argv.txt"), "utf8");
  expect(resumeArgv).toContain("thread-1");
  expect(resumeArgv).toContain('approval_policy="never"');
  expect(result.finalMessage).toBe("follow-up ready");
  expect(result.inputTokens).toBe(17);
  expect(result.outputTokens).toBe(6);
  expect(result.usageComplete).toBe(true);
  expectUnknown(result.artifacts?.map((artifact) => artifact.id)).toEqual([
    "sevro.codex.events",
    "sevro.codex.follow-up-events",
  ]);
  expectUnknown(result.observations).toContainEqual({
    id: "sevro.codex.continuation",
    completeness: "complete",
    data: {
      method: "same_thread_resume",
      threadId: "thread-1",
      nativeAfterOrdinal: 0,
      preFollowUpWorktreeUnchanged: false,
    },
  });
  expectUnknown(result.observations).toContainEqual(
    objectContaining({
      id: "sevro.codex.native-calls",
      completeness: "complete",
      data: objectContaining({
        feedbackCalls: [
          {
            ordinal: 1,
            tool: "followup_task",
            target: "owner",
            responseObserved: true,
            messageRepresentation: "plaintext",
            messageMatchesFollowUpPrompt: true,
          },
        ],
      }),
    }),
  );
});

test("Codex continuation ignores Git-private fixture state at the boundary", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture(roots);
  const workspace = await temporaryFixture(
    join(tmpdir(), "sevro-codex-unchanged-"),
  );

  await mkdir(join(workspace, ".git"));
  await writeFile(join(workspace, ".git", "unchanged.flag"), "");
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  const result = await host.run({
    prompt: "Wait.",
    followUpPrompt: "Continue.",
    workspace,
    condition: "passive",
  });
  expectUnknown(result.observations).toContainEqual({
    id: "sevro.codex.continuation",
    completeness: "complete",
    data: {
      method: "same_thread_resume",
      threadId: "thread-1",
      nativeAfterOrdinal: null,
      preFollowUpWorktreeUnchanged: true,
    },
  });
});

test("Codex host refuses a continuation from another thread", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture(roots);
  const workspace = await temporaryFixture(
    join(tmpdir(), "sevro-codex-wrong-thread-"),
  );

  await writeFile(join(workspace, "wrong-thread.flag"), "");
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  expect(
    host.run({
      prompt: "Initial instruction.",
      followUpPrompt: "Continue.",
      workspace,
      condition: "passive",
    }),
  ).rejects.toThrow(/original thread/);
});
