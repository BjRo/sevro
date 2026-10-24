import { afterEach, expect, test } from "bun:test";
import { codexNativeCallObservation } from "../../../src/hosts/codex-native-calls";
import { defined, expectUnknown } from "../../fixtures/assertions";
import {
  home,
  lines,
  result,
  session,
  spawn,
  started,
} from "../../fixtures/codex-native-calls";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("native spawn acceptance binds one request, start, and result", async () => {
  const root = await home(roots);
  await session(root, lines([spawn, started, result]));
  const observed = await codexNativeCallObservation(root, "thread-1");
  expect(observed.completeness).toBe("complete");
  expectUnknown(observed.data.acceptedSpawns).toEqual([
    {
      callId: "call_1",
      agentRef: "/root/reviewer",
      threadId: "thread-child",
      requestedOrdinal: 0,
      startedOrdinal: 1,
      acceptedOrdinal: 2,
      taskName: "reviewer",
      model: "gpt-6-sol",
      reasoningEffort: "high",
      forkTurns: "none",
    },
  ]);
  expect(JSON.stringify(observed)).not.toContain("private review task");
  expectUnknown(observed.data.childSessions).toEqual([
    { threadId: "thread-child", status: "unavailable" },
  ]);
});

test("accepted child sessions distinguish available, malformed, and ambiguous rollouts", async () => {
  const root = await home(roots);
  await session(root, lines([spawn, started, result]));
  await session(
    root,
    lines([
      {
        type: "item_completed",
        item: { type: "AgentMessage", text: "private result" },
      },
    ]),
    "thread-child",
  );
  expectUnknown(
    (await codexNativeCallObservation(root, "thread-1")).data.childSessions,
  ).toEqual([
    {
      threadId: "thread-child",
      status: "available",
      resultStatus: "unavailable",
      nestedSpawns: [],
      requestsTruncated: false,
    },
  ]);
  await session(root, "{broken\n", "thread-child");
  expectUnknown(
    (await codexNativeCallObservation(root, "thread-1")).data.childSessions,
  ).toEqual([{ threadId: "thread-child", status: "partial" }]);
  await session(
    root,
    lines([{ type: "item_completed" }]),
    "other-thread-child",
  );
  expectUnknown(
    (await codexNativeCallObservation(root, "thread-1")).data.childSessions,
  ).toEqual([{ threadId: "thread-child", status: "ambiguous" }]);
});

test("accepted child completion binds one nonempty final message to its turn", async () => {
  const root = await home(roots);
  await session(root, lines([spawn, started, result]));
  const final = {
    type: "item_completed",
    turn_id: "turn-child",
    item: {
      type: "AgentMessage",
      phase: "final_answer",
      content: [{ type: "Text", text: "private child answer" }],
    },
  };
  const completion = {
    type: "task_complete",
    turn_id: "turn-child",
    last_agent_message: "private child answer",
  };
  await session(root, lines([final, completion]), "thread-child");
  const completed = await codexNativeCallObservation(root, "thread-1");
  expectUnknown(completed.data.childSessions).toEqual([
    {
      threadId: "thread-child",
      status: "available",
      resultStatus: "completed",
      nestedSpawns: [],
      requestsTruncated: false,
    },
  ]);
  expect(JSON.stringify(completed)).not.toContain("private child answer");
  for (const payloads of [
    [completion, final],
    [final, final, completion],
    [
      {
        ...final,
        item: { ...final.item, content: [{ type: "Text", text: "  " }] },
      },
      { ...completion, last_agent_message: "  " },
    ],
    [final, { ...completion, turn_id: "other-turn" }],
    [final, { ...completion, last_agent_message: "different" }],
    [final, completion, { type: "turn_aborted" }],
  ]) {
    await session(root, lines(payloads), "thread-child");
    expect(
      defined(
        (await codexNativeCallObservation(root, "thread-1")).data
          .childSessions[0],
      ).resultStatus,
    ).toBe("unavailable");
  }
});

// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("nested spawn receipts bind the accepted reader and completed session", async () => {
  const root = await home(roots);
  await session(root, lines([spawn, started, result]));
  const nestedSpawn = {
    ...spawn,
    call_id: "nested_call",
    arguments: JSON.stringify({
      task_name: "spec_reader",
      model: "gpt-6-luna",
      reasoning_effort: "high",
      fork_turns: "none",
      message: "private reader instructions",
    }),
  };
  const nestedStart = {
    ...started,
    item: {
      ...started.item,
      id: "nested_call",
      agent_path: "/root/spec_reader",
      agent_thread_id: "thread-reader",
    },
  };
  const nestedResult = {
    ...result,
    call_id: "nested_call",
    output: JSON.stringify({ task_name: "/root/spec_reader" }),
  };
  await session(
    root,
    lines([nestedSpawn, nestedStart, nestedResult]),
    "thread-child",
  );
  const final = {
    type: "item_completed",
    turn_id: "turn-reader",
    item: {
      type: "AgentMessage",
      phase: "final_answer",
      content: [{ type: "Text", text: "private reader conclusion" }],
    },
  };
  const complete = {
    type: "task_complete",
    turn_id: "turn-reader",
    last_agent_message: "private reader conclusion",
  };
  await session(root, lines([final, complete]), "thread-reader");
  const observed = await codexNativeCallObservation(root, "thread-1");
  expect(defined(observed.data.childSessions[0])).toMatchObject({
    threadId: "thread-child",
    status: "available",
    nestedSpawns: [
      {
        requestedOrdinal: 0,
        status: "accepted",
        taskName: "spec_reader",
        model: "gpt-6-luna",
        reasoningEffort: "high",
        forkTurns: "none",
        agentRef: "/root/spec_reader",
        threadId: "thread-reader",
        sessionStatus: "available",
        readerResultStatus: "completed",
      },
    ],
    requestsTruncated: false,
  });
  expect(JSON.stringify(observed)).not.toContain("private reader instructions");
  expect(JSON.stringify(observed)).not.toContain("private reader conclusion");
  await session(root, lines([final]), "thread-reader");
  expect(
    defined(
      (await codexNativeCallObservation(root, "thread-1")).data
        .childSessions[0],
    ).nestedSpawns?.[0]?.readerResultStatus,
  ).toBe("unavailable");
  await session(
    root,
    lines([
      {
        ...nestedSpawn,
        arguments: JSON.stringify({
          task_name: "spec_reader",
          model: "gpt-6-luna",
          reasoning_effort: "high",
          fork_turns: "all",
          message: "private inherited request",
        }),
      },
    ]),
    "thread-child",
  );
  expectUnknown(
    defined(
      (await codexNativeCallObservation(root, "thread-1")).data
        .childSessions[0],
    ).nestedSpawns,
  ).toEqual([
    {
      requestedOrdinal: 0,
      status: "unaccepted",
      taskName: "spec_reader",
      model: "gpt-6-luna",
      reasoningEffort: "high",
      forkTurns: "all",
      sessionStatus: "unavailable",
      readerResultStatus: "unavailable",
    },
  ]);
});

test("nested request truncation is explicit", async () => {
  const root = await home(roots);
  await session(root, lines([spawn, started, result]));
  await session(
    root,
    lines(
      Array.from({ length: 9 }, (_, index) => ({
        ...spawn,
        call_id: `nested_${index}`,
      })),
    ),
    "thread-child",
  );
  const observed = await codexNativeCallObservation(root, "thread-1");
  expect(defined(observed.data.childSessions[0])).toMatchObject({
    status: "available",
    requestsTruncated: true,
  });
  expect(defined(observed.data.childSessions[0]).nestedSpawns).toHaveLength(8);
});

test("child session lookup is capped with an explicit truncation flag", async () => {
  const root = await home(roots);
  const payloads = Array.from({ length: 9 }, (_, index) => {
    const callId = `call_${index}`;
    const agentRef = `/root/owner_${index}`;
    return [
      {
        ...spawn,
        call_id: callId,
        arguments: JSON.stringify({ task_name: `owner_${index}` }),
      },
      {
        ...started,
        item: {
          ...started.item,
          id: callId,
          agent_path: agentRef,
          agent_thread_id: `child-${index}`,
        },
      },
      {
        ...result,
        call_id: callId,
        output: JSON.stringify({ task_name: agentRef }),
      },
    ];
  }).flat();
  await session(root, lines(payloads));
  const observed = await codexNativeCallObservation(root, "thread-1");
  expect(observed.data.acceptedSpawns).toHaveLength(9);
  expect(observed.data.childSessions).toHaveLength(8);
  expect(observed.data.childrenTruncated).toBe(true);
});

test("native spawn route fields stay bounded even when host acceptance succeeds", async () => {
  const root = await home(roots);
  const oversized = "9".repeat(500);
  await session(
    root,
    lines([
      {
        ...spawn,
        arguments: JSON.stringify({
          task_name: "reviewer",
          model: "gpt-6-sol",
          fork_turns: oversized,
          message: "private task",
        }),
      },
      started,
      result,
    ]),
  );
  const observed = await codexNativeCallObservation(root, "thread-1");
  expect(observed.data.acceptedSpawns).toHaveLength(1);
  expect(defined(observed.data.acceptedSpawns[0]).forkTurns).toBeUndefined();
  expect(JSON.stringify(observed)).not.toContain(oversized);
});
