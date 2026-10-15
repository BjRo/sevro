import { afterEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  runCodexAppServer,
  appServerFinal,
} from "../../src/hosts/codex-app-server";
import { defined, record } from "../fixtures/assertions";
import { peerEvents } from "../fixtures/native-host-fixtures";
import { createWorkspace } from "../fixtures/native-host-fixtures";
import { createServerOptions } from "../fixtures/native-host-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const workspace = createWorkspace(roots);

const serverOptions = createServerOptions(workspace);

const refusedServerCases: Array<[string, RegExp]> = [
  ["malformed-json", /Malformed app-server JSON/],
  ["array-message", /Malformed app-server JSON/],
  ["empty-message", /Malformed app-server message/],
  ["unmatched-response", /Unmatched app-server response/],
  ["array-response", /Malformed app-server object/],
  ["rpc-error", /RPC failed \(-42\)/],
  ["server-request", /Unsupported app-server request/],
  ["exit", /before settlement/],
  ["missing-thread-id", /Missing app-server identifier/],
  ["route-mismatch", /effective root route mismatch/],
  ["failed-turn", /turn failed/],
  ["fatal-error", /fatal turn error/],
  ["cleared-goal", /cleared the observed native goal/],
  ["goal-disappeared", /Observed native goal disappeared/],
  ["invalid-goal-notification", /Invalid native goal readback/],
  ["invalid-goal-status", /Invalid native goal readback/],
  ["foreign-goal", /Invalid native goal readback/],
  ["invalid-goal-objective", /Invalid native goal readback/],
  ["long-goal", /Invalid native goal readback/],
  ["missing-history", /Missing app-server history/],
  ["foreign-history", /returned another thread/],
  ["duplicate-turn", /Missing completed app-server turn/],
  ["missing-items", /has no items/],
  ["missing-final", /has no final response/],
];

test.each(refusedServerCases)(
  "app-server refuses %s at the host boundary",
  async (mode, diagnostic) => {
    const options = await serverOptions(mode);
    const result = await runCodexAppServer(options);
    expect(result.code).toBe(1);
    expect(result.evidence.failure).toMatch(diagnostic);
    expect(result.out).toContain('"type":"turn.failed"');
    expect(result.evidence.finalTurnId).toBeUndefined();
    expect(JSON.stringify(result.evidence)).not.toContain("PRIVATE_FATAL");
    expect(
      readFile(join(options.request.repoDir, ".git/last-message.md")),
    ).rejects.toThrow();
  },
);

// ThreadGoalGetResponse defines ThreadGoalStatus as a string enum. A malformed
// readback cannot establish completion or produce the successful final artifact.
test("app-server array goal status cannot establish terminal completion", async () => {
  const options = await serverOptions("array-goal-status");
  const result = await runCodexAppServer(options);
  expect(result.code).toBe(1);
  expect(result.evidence.failure).toBe("Invalid native goal readback");
  expect(result.evidence.goalStatus).toBeUndefined();
  expect(result.evidence.finalTurnId).toBeUndefined();
  expect(result.out).toContain('"type":"turn.failed"');
  expect(JSON.stringify(result.evidence)).not.toContain("PRIVATE_OBJECTIVE");
  expect(
    readFile(join(options.request.repoDir, ".git/last-message.md")),
  ).rejects.toThrow();
});

test.each(["complete", "paused", "blocked", "usageLimited", "budgetLimited"])(
  "app-server preserves valid nonactive native goal status: %s",
  async (status) => {
    const result = await runCodexAppServer(
      await serverOptions(`${status}-goal`),
    );
    expect(result.code, result.evidence.failure).toBe(0);
    expect(result.evidence.goalStatus).toBe(status);
    expect(result.evidence.finalTurnId).toBe("first");
    expect(result.evidence.goals).toHaveLength(1);
    expect(defined(result.evidence.goals[0])).toMatchObject({
      status,
      source: "readback",
    });
    expect(JSON.stringify(result.evidence)).not.toContain("PRIVATE_OBJECTIVE");
  },
);

test.each(["success", "complete-goal", "retry-errors", "many-errors"])(
  "app-server retains successful bounded evidence: %s",
  async (mode) => {
    const options = await serverOptions(mode);
    const result = await runCodexAppServer(options);
    expect(result.code, result.evidence.failure).toBe(0);
    expect(
      await readFile(
        join(options.request.repoDir, ".git/last-message.md"),
        "utf8",
      ),
    ).toBe("ready\n\ndone");
    expect(result.evidence).toMatchObject({
      clientTurns: 1,
      finalTurnId: "first",
    });
    const events = result.out
      .split("\n")
      .map((line) => record(JSON.parse(line)));
    expect(
      events.filter((event) => record(event.item ?? {}).id === "command"),
    ).toHaveLength(1);
    expect(result.out).toContain('"tool":"spawn_agent"');
    expect(result.out).toContain('"input_tokens":0');
    expect(result.out).not.toMatch(
      /PRIVATE_REASONING|PRIVATE_ACCOUNT|PRIVATE_COMMENTARY/,
    );
    expect(JSON.stringify(result.evidence)).not.toMatch(
      /PRIVATE_TOKEN|PRIVATE_KEY|PRIVATE_OBJECTIVE|FOREIGN_SECRET/,
    );
    const requests = await readFile(
      join(options.request.repoDir, ".git/requests.jsonl"),
      "utf8",
    );
    expect(requests).not.toMatch(/thread\/goal\/(?:set|clear)|turn\/interrupt/);
  },
);

test("app-server retry evidence is bounded, classified, and redacted", async () => {
  const result = await runCodexAppServer(await serverOptions("many-errors"));
  expect(result.evidence.errors).toHaveLength(32);
  expect(result.evidence.errorsDropped).toBe(2);
  expect(defined(result.evidence.errors?.[0])).toMatchObject({
    source: "error",
    willRetry: true,
    code: "httpConnectionFailed",
    httpStatusCode: 503,
    messageTruncated: true,
  });
  expect(defined(result.evidence.errors?.[0]).message).toContain("[redacted]");
  expect(
    defined(result.evidence.errors?.[0]).message?.length,
  ).toBeLessThanOrEqual(2000);
});

test.each([
  "empty-error-errors",
  "invalid-message-errors",
  "invalid-http-errors",
])(
  "app-server wire retry diagnostics preserve unknown fields: %s",
  async (mode) => {
    const result = await runCodexAppServer(await serverOptions(mode));
    expect(result.code, result.evidence.failure).toBe(0);
    const error = defined(result.evidence.errors?.[0]);
    expect(error.willRetry).toBe(true);
    expect(error.httpStatusCode).toBeUndefined();
    expect(error.message).toBe(
      mode === "invalid-http-errors" ? "Temporary failure" : null,
    );
    expect(error.code).toBe(
      mode === "empty-error-errors" ? null : "httpConnectionFailed",
    );
  },
);

test.each([
  ["fail-after-initialize-response", /Malformed app-server object/, 0],
  [
    "exit-pending-thread-start",
    /closed before settlement|exited before settlement/,
    0,
  ],
  [
    "exit-after-turn-response",
    /closed before settlement|exited before settlement/,
    1,
  ],
  ["null-goal-notification", /Malformed app-server object/, 1],
] as const)(
  "app-server wire failure at a pending boundary is retained: %s",
  async (mode, diagnostic, turns) => {
    const result = await runCodexAppServer(await serverOptions(mode));
    expect(result.code).toBe(1);
    expect(result.evidence.failure).toMatch(diagnostic);
    expect(result.evidence.clientTurns).toBe(turns);
    expect(result.evidence.finalTurnId).toBeUndefined();
    expect(result.out).toContain('"type":"turn.failed"');
  },
);

test("app-server wire repeated goals retain one observation per unchanged state and source", async () => {
  const result = await runCodexAppServer(await serverOptions("duplicate-goal"));
  expect(result.code, result.evidence.failure).toBe(0);
  expect(
    result.evidence.goals.map((goal) => ({
      status: goal.status,
      source: goal.source,
    })),
  ).toEqual([
    { status: "complete", source: "notification" },
    { status: "complete", source: "readback" },
  ]);
  expect(JSON.stringify(result.evidence)).not.toContain("PRIVATE_OBJECTIVE");
});

test("app-server wire a failed command remains distinct from successful root completion", async () => {
  const result = await runCodexAppServer(
    await serverOptions("failed-command-item"),
  );
  expect(result.code, result.evidence.failure).toBe(0);
  expect(result.evidence.finalTurnId).toBe("first");
  const events = result.out.split("\n").map((line) => record(JSON.parse(line)));
  expect(events.map((event) => event.item).filter(Boolean)).toContainEqual(
    expect.objectContaining({
      type: "command_execution",
      status: "failed",
      exit_code: 1,
    }),
  );
});

test("app-server wire final response decoder requires retained root turns", () => {
  const turn = {
    id: "first",
    status: "completed",
    items: [
      {
        id: "answer",
        type: "agentMessage",
        phase: "final_answer",
        text: "ready",
      },
    ],
  };
  expect(appServerFinal({ id: "root", turns: [turn] }, "first")).toBe("ready");
  expect(() => appServerFinal({ id: "root", turns: null }, "first")).toThrow(
    "App-server thread has no retained turns",
  );
});

test("app-server wire foreign settlement events cannot invalidate a completed root", async () => {
  const result = await runCodexAppServer(
    await serverOptions("settlement-foreign"),
  );
  expect(result.code, result.evidence.failure).toBe(0);
  expect(result.evidence.finalTurnId).toBe("first");
  expect(result.evidence.goals).toEqual([]);
});

test("app-server delivers exactly one declared feedback turn", async () => {
  const options = await serverOptions("success");
  options.request.control = {
    followUpPrompt: "User correction",
    appServerTimeoutMs: 2000,
  };
  const result = await runCodexAppServer(options);
  expect(result.code, result.evidence.failure).toBe(0);
  expect(result.evidence).toMatchObject({
    clientTurns: 2,
    finalTurnId: "follow-up",
  });
  expect(result.out).toContain('"native_goal_observed":false');
  const requests = (
    await readFile(join(options.request.repoDir, ".git/requests.jsonl"), "utf8")
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => record(JSON.parse(line)));
  expect(
    requests.filter((request) => request.method === "turn/start"),
  ).toHaveLength(2);
  expect(JSON.stringify(requests)).toContain("User correction");
});

test.each([0, -1, Infinity, NaN])(
  "app-server refuses invalid time bounds: %s",
  async (bound) => {
    const options = await serverOptions("silent");
    options.request.control = { appServerTimeoutMs: bound };
    expect(runCodexAppServer(options)).rejects.toThrow(
      /Invalid app-server time bound/,
    );
  },
);

test("app-server cancellation and deadline stop a silent real peer", async () => {
  const options = await serverOptions("silent");
  options.request.control = { appServerTimeoutMs: 50 };
  expect((await runCodexAppServer(options)).evidence.failure).toMatch(
    /time bound reached/,
  );
  const abort = new AbortController();
  abort.abort();
  options.request.signal = abort.signal;
  expect(runCodexAppServer(options)).rejects.toThrow(/Codex run cancelled/);
  const active = new AbortController();
  options.request.signal = active.signal;
  options.request.control = { appServerTimeoutMs: 2000 };
  const timer = setTimeout(() => {
    active.abort();
  }, 50);
  try {
    expect((await runCodexAppServer(options)).evidence.failure).toBe(
      "Codex run cancelled",
    );
  } finally {
    clearTimeout(timer);
  }
});

// Issue #93: a fixed per-request deadline ended startup long before the
// configured evaluation bound. Startup now waits for that bound alone.
test("app-server startup waits for the configured bound and names the stalled request", async () => {
  const options = await serverOptions("stalled-thread-start");
  options.request.control = { appServerTimeoutMs: 1500 };
  const started = performance.now();
  const result = await runCodexAppServer(options);
  expect(performance.now() - started).toBeGreaterThanOrEqual(1500);
  expect(result.code).toBe(1);
  expect(result.evidence.failure).toBe(
    "App-server evaluation time bound reached awaiting thread/start",
  );
  expect(result.evidence).toMatchObject({ clientTurns: 0, turns: [] });
  expect(result.evidence.threadId).toBeUndefined();
  expect(result.out).toContain('"type":"turn.failed"');
});

test("app-server time bound during an unfinished turn names no pending request", async () => {
  const options = await serverOptions("stalled-turn");
  const result = await runCodexAppServer(options);
  expect(result.code).toBe(1);
  expect(result.evidence.failure).toBe(
    "App-server evaluation time bound reached",
  );
  expect(result.evidence).toMatchObject({ threadId: "root", clientTurns: 1 });
});

test("app-server transport failure from an absent executable cannot complete", async () => {
  const options = await serverOptions("success");
  options.argv = [join(options.request.repoDir, "missing-executable")];
  const result = await runCodexAppServer(options);
  expect(result.code).toBe(1);
  expect(result.evidence.failure).toMatch(/ENOENT/);
  expect(result.out).toContain('"type":"turn.failed"');
});

test("app-server closing transport still refuses an unterminated malformed trailing message", async () => {
  const result = await runCodexAppServer(
    await serverOptions("trailing-malformed-on-close"),
  );
  expect(result.code).toBe(1);
  expect(result.evidence.failure).toBe("Malformed app-server JSON message");
  expect(result.out).toContain('"type":"turn.failed"');
});

test("app-server oversized transport input is refused before becoming a result", async () => {
  const result = await runCodexAppServer(
    await serverOptions("oversized-stream"),
  );
  expect(result.code).toBe(1);
  expect(result.evidence.failure).toBe("App-server stream exceeds limit");
  expect(result.evidence.clientTurns).toBe(0);
});

test("app-server drains oversized diagnostic stderr while retaining a valid root response", async () => {
  const options = await serverOptions("large-stderr");
  const result = await runCodexAppServer(options);
  expect(result.code, result.evidence.failure).toBe(0);
  expect(result.evidence.finalTurnId).toBe("first");
  expect(result.err).toHaveLength(16000);
  expect(result.err).toEndWith("RETAINED_DIAGNOSTIC_TAIL\n");
  expect(result.err).not.toContain("DISCARDED_DIAGNOSTIC_PREFIX");
  expect(result.out).not.toContain("RETAINED_DIAGNOSTIC_TAIL");
  expect(
    await readFile(
      join(options.request.repoDir, ".git/last-message.md"),
      "utf8",
    ),
  ).toBe("ready\n\ndone");
});

test("app-server refuses a notification backlog within the transport byte bound", async () => {
  const options = await serverOptions("notification-backlog");
  const result = await runCodexAppServer(options);
  expect(result.code).toBe(1);
  expect(result.evidence.failure).toBe(
    "App-server notification queue exceeds limit",
  );
  expect(result.evidence.clientTurns).toBe(0);
  expect(result.evidence.finalTurnId).toBeUndefined();
  expect(result.out).toContain('"type":"turn.failed"');
  expect(
    readFile(join(options.request.repoDir, ".git/last-message.md")),
  ).rejects.toThrow();
});

test.each(["ignore-eof", "ignore-eof-and-term"])(
  "app-server closes only its resistant owned peer after a validated result: %s",
  async (mode) => {
    const options = await serverOptions(mode);
    const result = await runCodexAppServer(options);
    expect(result.code, result.evidence.failure).toBe(0);
    expect(result.evidence.finalTurnId).toBe("first");
    expect(
      await readFile(
        join(options.request.repoDir, ".git/last-message.md"),
        "utf8",
      ),
    ).toBe("ready\n\ndone");
    const events = await peerEvents(options.request.repoDir);
    expect(events.map((event) => event.event)).toEqual([
      "client-first",
      "stdin-eof",
      "sigterm",
    ]);
    const pid = Number(defined(events[0]).pid);
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH|No such process/);
  },
  15000,
);

test("app-server declared feedback can enter a thread while its native goal is active", async () => {
  const options = await serverOptions("feedback-active-goal");
  options.request.control = {
    followUpPrompt: "User feedback",
    appServerTimeoutMs: 2000,
  };
  const result = await runCodexAppServer(options);
  expect(result.code, result.evidence.failure).toBe(0);
  expect(result.evidence.clientTurns).toBe(2);
  expect(result.out).toContain('"native_goal_observed":true');
  expect(result.out).toContain('"native_goal_status":"active"');
  expect(result.evidence.goalStatus).toBe("complete");
});
