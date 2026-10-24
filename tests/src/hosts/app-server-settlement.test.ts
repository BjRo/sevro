import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCodexAppServer,
  type AppServerRunOptions,
} from "../../../src/hosts/codex-app-server";
import { defined, record } from "../../fixtures/assertions";
import { createTemporaryFixtures } from "../../fixtures/filesystem";
import {
  createServerOptions,
  createWorkspace,
  peerEvents,
} from "../../fixtures/native-host-fixtures";

const roots: string[] = [];
const { temporaryFixtureSync, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const workspace = createWorkspace(roots);

const serverOptions = createServerOptions(workspace);

test.each([
  ["settlement-fatal", /fatal error during settlement/],
  ["settlement-cleared", /goal cleared during settlement/],
  ["settlement-active", /goal became active during settlement/],
  ["settlement-turn", /Another root turn appeared/],
  ["later-failed-history", /Later app-server turn did not complete/],
] as const)(
  "app-server refuses terminal readback races: %s",
  async (mode, diagnostic) => {
    const result = await runCodexAppServer(await serverOptions(mode));
    expect(result.code).toBe(1);
    expect(result.finalMessage).toBeNull();
    expect(result.evidence.failure).toMatch(diagnostic);
    expect(result.out).toContain('"type":"turn.failed"');
    expect(JSON.stringify(result.evidence)).not.toContain("PRIVATE_SETTLEMENT");
  },
);

test.each([false, true])(
  "app-server waits for a native turn racing readback; feedback=%s",
  async (feedback) => {
    const options = await serverOptions("native-read-race");
    if (feedback)
      options.request.control = {
        followUpPrompt: "User feedback",
        appServerTimeoutMs: 2000,
      };
    const result = await runCodexAppServer(options);
    expect(result.code, result.evidence.failure).toBe(0);
    expect(result.evidence.finalTurnId).toBe(
      feedback ? "follow-up" : "native-2",
    );
    expect(result.evidence.clientTurns).toBe(feedback ? 2 : 1);
    expect(
      result.evidence.turns.find(
        (turn) => turn.id === "native-2" && turn.status === "completed",
      ),
    ).toMatchObject({ id: "native-2", status: "completed" });
  },
);

function receiptFileState(directory: string, name: string) {
  try {
    return { name, contents: readFileSync(join(directory, name), "utf8") };
  } catch (error) {
    return { name, unavailable: String(error) };
  }
}

function receiptTimeoutEvidence(
  directory: string,
  command: string,
  receipt: string,
  events: Array<{ at: number; event: string; name: string | null }>,
): Error {
  const message = `Peer receipt unavailable: ${receipt}`;
  try {
    const retained = temporaryFixtureSync(
      join(tmpdir(), "sevro-peer-receipt-failure-"),
    );
    const names = [
      command,
      receipt,
      receipt + ".pending",
      "requests.jsonl",
      "peer-events.jsonl",
      "boundary-trace.jsonl",
      "last-message.md",
    ];
    writeFileSync(
      join(retained, "state.json"),
      JSON.stringify(
        {
          at: Date.now(),
          directory,
          command,
          receipt,
          events,
          directoryEntries: readdirSync(directory),
          files: names.map((name) => receiptFileState(directory, name)),
        },
        null,
        2,
      ),
    );
    return new Error(`${message}; evidence: ${retained}`);
  } catch (cause) {
    return new Error(`${message}; evidence retention failed`, { cause });
  }
}

async function exchangePeerReceipt(
  root: string,
  command: string,
  receipt: string,
): Promise<void> {
  const directory = join(root, ".git");
  expect(existsSync(join(directory, command))).toBe(false);
  expect(existsSync(join(directory, receipt))).toBe(false);
  const acknowledged = Promise.withResolvers<undefined>();
  const events: Array<{ at: number; event: string; name: string | null }> = [];
  const inspectReceipt = (): boolean => {
    if (receiptFileState(directory, receipt).contents !== "emitted")
      return false;
    acknowledged.resolve(undefined);
    return true;
  };
  const observer = setInterval(inspectReceipt, 25);
  const timer = setTimeout(() => {
    if (!inspectReceipt())
      acknowledged.reject(
        receiptTimeoutEvidence(directory, command, receipt, events),
      );
  }, 2000);
  try {
    await writeFile(join(directory, command + ".pending"), "emit");
    await rename(
      join(directory, command + ".pending"),
      join(directory, command),
    );
    inspectReceipt();
    await acknowledged.promise;
    expect(await readFile(join(directory, receipt), "utf8")).toBe("emitted");
  } finally {
    clearInterval(observer);
    clearTimeout(timer);
  }
}

async function turnRequests(root: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(root, ".git/requests.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => record(JSON.parse(line)))
    .filter((message) => message.method === "turn/start");
}

function feedbackCapture(
  options: AppServerRunOptions,
  nativeTurn: boolean,
): () => Promise<string> {
  let captured = false;
  return async () => {
    if (!captured) {
      captured = true;
      await exchangePeerReceipt(
        options.request.repoDir,
        "capture-boundary",
        "boundary-emitted",
      );
      expect(await turnRequests(options.request.repoDir)).toHaveLength(1);
      if (nativeTurn)
        await exchangePeerReceipt(
          options.request.repoDir,
          "release-native-turn",
          "native-completed",
        );
    }
    return JSON.stringify({
      type: "sevro.follow_up_boundary",
      thread_id: "root",
    });
  };
}

test.each([
  ["boundary-fatal", /fatal error during settlement/],
  ["boundary-cleared", /goal cleared during settlement/],
] as const)(
  "app-server withholds correction after root event during feedback capture: %s",
  async (mode, diagnostic) => {
    const options = await serverOptions(mode);
    options.request.control = {
      followUpPrompt: "User correction",
      appServerTimeoutMs: 5000,
    };
    options.followUpBoundary = feedbackCapture(options, false);
    const result = await runCodexAppServer(options);
    expect(result.code).toBe(1);
    expect(result.evidence.failure).toMatch(diagnostic);
    expect(result.evidence.clientTurns).toBe(1);
    expect(result.out).toContain('"type":"turn.failed"');
    expect(result.out).not.toContain('"type":"sevro.follow_up_boundary"');
    const requests = await turnRequests(options.request.repoDir);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain("User correction");
    expect(JSON.stringify(result.evidence)).not.toContain(
      "boundary-credential",
    );
    expect(
      (await peerEvents(options.request.repoDir)).map((event) => event.event),
    ).toEqual(["client-first", "boundary-emitted"]);
  },
);

test("app-server defers correction for a native turn started during feedback capture", async () => {
  const options = await serverOptions("boundary-native-turn");
  options.request.control = {
    followUpPrompt: "User correction",
    appServerTimeoutMs: 5000,
  };
  options.followUpBoundary = feedbackCapture(options, true);
  const result = await runCodexAppServer(options);
  expect(result.code, result.evidence.failure).toBe(0);
  expect(result.evidence.clientTurns).toBe(2);
  expect(result.evidence.finalTurnId).toBe("follow-up");
  expect(
    result.evidence.turns.find(
      (turn) => turn.id === "native-2" && turn.status === "completed",
    ),
  ).toMatchObject({ status: "completed" });
  const requests = await turnRequests(options.request.repoDir);
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(defined(requests[1]))).toContain("User correction");
  expect(
    (await peerEvents(options.request.repoDir)).map((event) => event.event),
  ).toEqual([
    "client-first",
    "boundary-emitted",
    "native-completed",
    "client-follow-up",
  ]);
  expect(result.out.split('"type":"sevro.follow_up_boundary"')).toHaveLength(2);
});

test.each(["boundary-goal-valid", "boundary-goal-invalid"])(
  "app-server wire validates queued goal readback during feedback capture: %s",
  async (mode) => {
    const options = await serverOptions(mode);
    options.request.control = {
      followUpPrompt: "User correction",
      appServerTimeoutMs: 5000,
    };
    options.followUpBoundary = feedbackCapture(options, false);
    const result = await runCodexAppServer(options);
    const requests = await turnRequests(options.request.repoDir);
    if (mode === "boundary-goal-valid") {
      expect(result.code, result.evidence.failure).toBe(0);
      expect(requests).toHaveLength(2);
      expect(result.evidence.finalTurnId).toBe("follow-up");
      expect(JSON.stringify(defined(requests[1]))).toContain("User correction");
    } else {
      expect(result.code).toBe(1);
      expect(result.evidence.failure).toBe("Invalid native goal readback");
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests)).not.toContain("User correction");
    }
  },
);
