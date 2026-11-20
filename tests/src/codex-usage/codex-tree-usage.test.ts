import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexTreeUsage } from "../../../src/codex-usage/index";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

type Entry = Record<string, unknown>;

function meta(id: string, parent?: string): Entry {
  return {
    ordinal: 0,
    type: "session_meta",
    payload: {
      id,
      source: parent
        ? { subagent: { thread_spawn: { parent_thread_id: parent } } }
        : "exec",
    },
  };
}

function tokens(input: number, output: number): Entry {
  return {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: 0,
          output_tokens: output,
        },
      },
    },
  };
}

const rateLimitsOnly: Entry = {
  type: "event_msg",
  payload: { type: "token_count", info: null },
};

async function home(sessions: Record<string, (Entry | string)[]>) {
  const codexHome = await temporaryFixture(join(tmpdir(), "sevro-usage-"));
  const directory = join(codexHome, "sessions/2026/11/20");
  await mkdir(directory, { recursive: true });
  for (const [name, entries] of Object.entries(sessions))
    await writeFile(
      join(directory, `rollout-2026-11-20T00-00-00-${name}.jsonl`),
      entries
        .map((entry) =>
          typeof entry === "string" ? entry : JSON.stringify(entry),
        )
        .join("\n") + "\n",
    );
  return { codexHome, directory };
}

test("sums the last total of the root and nested subagents", async () => {
  const { codexHome } = await home({
    root: [meta("root"), tokens(10, 1), rateLimitsOnly, tokens(40, 4)],
    child: [meta("child", "root"), tokens(20, 2)],
    grandchild: [meta("grandchild", "child"), tokens(5, 1)],
    unrelated: [meta("unrelated"), tokens(1000, 100)],
    orphan: [meta("orphan", "missing"), tokens(7, 7)],
  });
  expect(await codexTreeUsage(codexHome, "root")).toEqual({
    inputTokens: 65,
    outputTokens: 7,
    complete: true,
    observation: {
      id: "sevro.codex.usage",
      completeness: "complete",
      data: {
        scope: "thread_tree",
        threads: 3,
        rootInputTokens: 40,
        rootOutputTokens: 4,
        unlinkedSessions: 2,
        incompleteReasons: [],
      },
    },
  });
});

test("adds each cumulative segment once when a session's totals restart", async () => {
  const { codexHome } = await home({
    root: [meta("root"), tokens(10, 1), tokens(20, 2), tokens(5, 1)],
  });
  expect(await codexTreeUsage(codexHome, "root")).toMatchObject({
    inputTokens: 25,
    outputTokens: 3,
    complete: true,
  });
});

test.each([
  [
    "a missing usage total",
    [meta("child", "root"), rateLimitsOnly],
    "session_usage_missing",
  ],
  [
    "a malformed counted entry",
    [meta("child", "root"), '{"token_count":'],
    "session_unreadable",
  ],
  ["a non-object entry", ["[]"], "session_unreadable"],
  [
    "an invalid usage total",
    [meta("child", "root"), tokens(-1, 2)],
    "session_unreadable",
  ],
] as const)(
  "keeps the root total but stays incomplete for %s",
  async (_name, child, reason) => {
    const { codexHome } = await home({
      root: [meta("root"), tokens(10, 1)],
      child: [...child],
    });
    const usage = await codexTreeUsage(codexHome, "root");
    expect(usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 1,
      complete: false,
      observation: {
        completeness: "partial",
        data: { incompleteReasons: [reason] },
      },
    });
  },
);

test("leaves usage unmeasured without a root session", async () => {
  const { codexHome } = await home({
    child: [meta("child", "root"), tokens(20, 2)],
  });
  expect(await codexTreeUsage(codexHome, "root")).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    complete: false,
    observation: {
      data: {
        threads: 0,
        unlinkedSessions: 1,
        incompleteReasons: ["root_session_unavailable"],
      },
    },
  });
});

test("refuses an ambiguous root session", async () => {
  const { codexHome, directory } = await home({
    root: [meta("root"), tokens(10, 1)],
  });
  await writeFile(
    join(directory, "rollout-copy-root.jsonl"),
    JSON.stringify(tokens(10, 1)) + "\n",
  );
  expect(await codexTreeUsage(codexHome, "root")).toMatchObject({
    inputTokens: null,
    complete: false,
    observation: { data: { incompleteReasons: ["root_session_unavailable"] } },
  });
});

test("counts a root without session metadata by its rollout name", async () => {
  const { codexHome } = await home({ root: [tokens(10, 1)] });
  expect(await codexTreeUsage(codexHome, "root")).toMatchObject({
    inputTokens: 10,
    outputTokens: 1,
    complete: true,
  });
});

test("reports an oversized session as unreadable", async () => {
  const { codexHome, directory } = await home({
    root: [meta("root"), tokens(10, 1)],
  });
  const child = join(directory, "rollout-large-child.jsonl");
  await writeFile(child, "");
  await truncate(child, 64 * 1024 * 1024 + 1);
  expect(await codexTreeUsage(codexHome, "root")).toMatchObject({
    inputTokens: 10,
    complete: false,
    observation: { data: { incompleteReasons: ["session_unreadable"] } },
  });
});

test("refuses a session directory it cannot list", async () => {
  const { codexHome, directory } = await home({
    root: [meta("root"), tokens(10, 1)],
  });
  const locked = join(directory, "locked");
  await mkdir(locked);
  await chmod(locked, 0);
  try {
    expect(await codexTreeUsage(codexHome, "root")).toMatchObject({
      inputTokens: null,
      observation: { data: { incompleteReasons: ["sessions_incomplete"] } },
    });
  } finally {
    await chmod(locked, 0o700);
  }
});

test.each(["symlink", "overflow"] as const)(
  "refuses an incomplete session search: %s",
  async (shape) => {
    const { codexHome, directory } = await home({
      root: [meta("root"), tokens(10, 1)],
    });
    if (shape === "symlink")
      await symlink(join(directory, "missing"), join(directory, "link.jsonl"));
    else
      for (let index = 0; index < 1024; index++)
        await writeFile(join(directory, `note-${index}.txt`), "");
    expect(await codexTreeUsage(codexHome, "root")).toMatchObject({
      inputTokens: null,
      complete: false,
      observation: { data: { incompleteReasons: ["sessions_incomplete"] } },
    });
  },
);

test.each([
  ["a missing sessions directory", "root", false],
  ["an invalid thread identifier", "../root", true],
] as const)("leaves usage unmeasured for %s", async (_name, thread, create) => {
  const codexHome = create
    ? (await home({ root: [meta("root"), tokens(10, 1)] })).codexHome
    : await temporaryFixture(join(tmpdir(), "sevro-usage-empty-"));
  expect(await codexTreeUsage(codexHome, thread)).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    complete: false,
    observation: { data: { incompleteReasons: ["sessions_unavailable"] } },
  });
});
