import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codexNativeCallObservation } from "../../src/hosts/codex-native-calls";
import { createWorkspace } from "../fixtures/native-host-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const workspace = createWorkspace(roots);

async function nativeSession(entries: readonly unknown[], raw?: string) {
  const root = await workspace(),
    home = join(root, "home"),
    directory = join(home, "sessions");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "rollout-root.jsonl"),
    raw ?? entries.map((entry) => JSON.stringify(entry)).join("\n"),
  );
  return home;
}

test.each(["", "root with spaces", "x".repeat(129)])(
  "native wire an invalid thread identifier cannot establish a session: %s",
  async (threadId) => {
    const home = await nativeSession([{ ordinal: 0, payload: {} }]);
    const observed = await codexNativeCallObservation(home, threadId);
    expect(observed.completeness).toBe("partial");
    expect(observed.data.calls).toEqual([]);
  },
);

test.each(["home", "sessions"])(
  "native wire unreadable owned %s leaves session evidence partial",
  async (directory) => {
    const home = await nativeSession([{ ordinal: 0, payload: {} }]);
    const path = directory === "home" ? home : join(home, "sessions");
    await chmod(path, 0);
    try {
      const observed = await codexNativeCallObservation(home, "root");
      expect(observed.completeness).toBe("partial");
      expect(observed.data.calls).toEqual([]);
    } finally {
      await chmod(path, 0o700);
    }
  },
);

test("native wire session traversal accepts its declared file bound and refuses excess metadata", async () => {
  const home = await nativeSession([{ ordinal: 0, payload: {} }]);
  const directory = join(home, "sessions");
  for (let index = 0; index < 1023; index++)
    await writeFile(join(directory, `entry-${index}.jsonl`), "{}");
  expect((await codexNativeCallObservation(home, "root")).completeness).toBe(
    "complete",
  );
  await writeFile(join(directory, "entry-overflow.jsonl"), "{}");
  const observed = await codexNativeCallObservation(home, "root");
  expect(observed.completeness).toBe("partial");
  expect(observed.data.calls).toEqual([]);
});

test.each([
  { label: "malformed JSON", raw: "{broken" },
  { label: "nonobject entry", entries: [[]] },
  {
    label: "unordered ordinals",
    entries: [
      { ordinal: 1, payload: {} },
      { ordinal: 0, payload: {} },
    ],
  },
  { label: "fractional ordinal", entries: [{ ordinal: 1.5, payload: {} }] },
  { label: "missing payload", entries: [{ ordinal: 0 }] },
  { label: "array payload", entries: [{ ordinal: 0, payload: [] }] },
  { label: "empty session", entries: [] },
])(
  "native session malformed boundary remains partial: %s",
  async (scenario) => {
    const home = await nativeSession(scenario.entries ?? [], scenario.raw);
    const observed = await codexNativeCallObservation(home, "root");
    expect(observed.completeness).toBe("partial");
    expect(observed.data.acceptedSpawns).toEqual([]);
    expect(observed.data.feedbackCalls).toEqual([]);
  },
);

test("native retained call and entry limits stay explicit and cannot prove absence", async () => {
  const calls = Array.from({ length: 129 }, (_, ordinal) => ({
    ordinal,
    payload: {
      type: "function_call",
      namespace: "functions",
      name: "get_goal",
      arguments: "PRIVATE_ARGUMENT",
    },
  }));
  const home = await nativeSession(calls);
  const observed = await codexNativeCallObservation(home, "root");
  expect(observed.completeness).toBe("partial");
  expect(observed.data.calls).toHaveLength(128);
  expect(observed.data.toolCalls).toHaveLength(128);
  expect(JSON.stringify(observed)).not.toContain("PRIVATE_ARGUMENT");
  const overflow = Array.from({ length: 10001 }, (_, ordinal) => ({
    ordinal,
    payload: { type: "unrelated" },
  }));
  expect(
    (await codexNativeCallObservation(await nativeSession(overflow), "root"))
      .completeness,
  ).toBe("partial");
});
