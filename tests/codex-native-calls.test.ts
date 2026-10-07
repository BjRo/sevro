import { expectUnknown } from "./fixtures/assertions";
import { defined } from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexNativeCallObservation,
  codexNativeSessionLastOrdinal,
  codexNativeSkillReadRecovery,
} from "../src/hosts/codex-native-calls";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function home() {
  const root = await mkdtemp(join(tmpdir(), "sevro-native-calls-"));
  roots.push(root);
  return root;
}
async function session(root: string, content: string, suffix = "thread-1") {
  const directory = join(root, "sessions", "2026", "09", "27");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `rollout-${suffix}.jsonl`), content);
}
test("native boundary uses only a complete, unique session", async () => {
  const root = await home();
  expect(await codexNativeSessionLastOrdinal(root, "thread-1")).toBeNull();
  await session(
    root,
    [0, 3]
      .map((ordinal) => JSON.stringify({ ordinal, payload: {} }))
      .join("\n") + "\n",
  );
  expect(await codexNativeSessionLastOrdinal(root, "thread-1")).toBe(3);
  await session(root, '{"ordinal":0,"payload":{}}\n{broken\n');
  expect(await codexNativeSessionLastOrdinal(root, "thread-1")).toBeNull();
  await session(root, '{"ordinal":0,"payload":{}}\n', "other-thread-1");
  expect(await codexNativeSessionLastOrdinal(root, "thread-1")).toBeNull();
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("native goal and agent calls retain names and order without private arguments", async () => {
  const root = await home();
  await session(
    root,
    [
      {
        ordinal: 0,
        payload: {
          type: "function_call",
          namespace: "functions",
          name: "create_goal",
          arguments: '{"objective":"private objective"}',
        },
      },
      {
        ordinal: 1,
        payload: {
          type: "custom_tool_call",
          name: "exec",
          input: "private code",
        },
      },
      {
        ordinal: 2,
        payload: {
          type: "function_call",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: '{"message":"private task"}',
        },
      },
      {
        ordinal: 3,
        payload: { type: "function_call_output", output: "private result" },
      },
      {
        ordinal: 4,
        payload: { type: "function_call", name: "get_goal" },
      },
      {
        ordinal: 5,
        payload: {
          type: "function_call",
          namespace: "other",
          name: "update_goal",
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const observed = await codexNativeCallObservation(root, "thread-1");
  expectUnknown(observed).toEqual({
    id: "sevro.codex.native-calls",
    completeness: "complete",
    data: {
      method: "native_session",
      calls: [
        {
          ordinal: 0,
          namespace: "functions",
          name: "create_goal",
          evidence: "invocation_attempt",
        },
        {
          ordinal: 2,
          namespace: "collaboration",
          name: "spawn_agent",
          evidence: "invocation_attempt",
        },
        {
          ordinal: 4,
          namespace: "functions",
          name: "get_goal",
          evidence: "invocation_attempt",
        },
      ],
      toolCalls: [
        { ordinal: 0, namespace: "functions", name: "create_goal" },
        { ordinal: 1, namespace: "other", name: "exec" },
        { ordinal: 2, namespace: "collaboration", name: "spawn_agent" },
        { ordinal: 4, namespace: "other", name: "get_goal" },
        { ordinal: 5, namespace: "other", name: "update_goal" },
      ],
      submittedExecCalls: 1,
      acceptedSpawns: [],
      feedbackCalls: [],
      childSessions: [],
      childrenTruncated: false,
    },
  });
  expect(JSON.stringify(observed)).not.toContain("private");
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("parent diagnostics cover sessions without a spawn", async () => {
  const root = await home();
  const workspace = await mkdtemp(
    join(tmpdir(), "sevro-native-parent-workspace-"),
  );
  roots.push(workspace);
  const skillDir = join(workspace, ".agents", "skills", "example");
  await mkdir(skillDir, { recursive: true });
  const body =
    "---\nname: example\ndescription: Example\n---\n\nPrivate parent body.\n";
  await writeFile(join(skillDir, "SKILL.md"), body);
  const context = { workspace, installedPluginRoots: [] };
  await session(
    root,
    lines([{ type: "item_completed", item: { type: "AgentMessage" } }]),
  );
  expectUnknown(
    (await codexNativeCallObservation(root, "thread-1", context)).data
      .parentReadDiagnostics,
  ).toEqual({
    completeness: "complete",
    observedSkills: [],
    completedReads: [],
    recoverySources: [],
    commandExecutions: 0,
    readAttempts: 0,
    truncated: false,
  });
  await session(
    root,
    lines([
      {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          command: ["/bin/zsh", "-lc", "cat .agents/skills/example/SKILL.md"],
          aggregated_output: body,
          exit_code: 0,
          status: "completed",
        },
      },
    ]),
  );
  const observed = await codexNativeCallObservation(root, "thread-1", context);
  expect(observed.data.parentReadDiagnostics).toMatchObject({
    completeness: "complete",
    observedSkills: ["example"],
    completedReads: [{ skill: "example", ordinal: 0 }],
  });
  await session(
    root,
    lines([
      {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          command: ["/bin/zsh", "-lc", "cat .agents/skills/example/SKILL.md"],
          aggregated_output: body,
          exit_code: 0,
          status: "completed",
        },
      },
      {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          command: ["/bin/zsh", "-lc", "cat .agents/skills/example/SKILL.md"],
          aggregated_output: body,
          exit_code: 0,
          status: "completed",
        },
      },
    ]),
  );
  expectUnknown(
    (await codexNativeCallObservation(root, "thread-1", context)).data
      .parentReadDiagnostics?.completedReads,
  ).toEqual([
    { skill: "example", ordinal: 0 },
    { skill: "example", ordinal: 1 },
  ]);
  expect(JSON.stringify(observed)).not.toContain("Private parent body.");
});
function lines(payloads: Array<Record<string, unknown>>) {
  return (
    payloads
      .map((payload, ordinal) => JSON.stringify({ ordinal, payload }))
      .join("\n") + "\n"
  );
}
const spawn = {
  type: "function_call",
  namespace: "collaboration",
  name: "spawn_agent",
  call_id: "call_1",
  arguments: JSON.stringify({
    task_name: "reviewer",
    model: "gpt-6-sol",
    reasoning_effort: "high",
    fork_turns: "none",
    message: "private review task",
  }),
};
const started = {
  type: "item_completed",
  item: {
    type: "SubAgentActivity",
    id: "call_1",
    kind: "started",
    agent_path: "/root/reviewer",
    agent_thread_id: "thread-child",
  },
};
const result = {
  type: "function_call_output",
  call_id: "call_1",
  output: JSON.stringify({ task_name: "/root/reviewer" }),
};
test("native spawn acceptance binds one request, start, and result", async () => {
  const root = await home();
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
  const root = await home();
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
test("accepted child skill reads require the exact mounted body", async () => {
  const root = await home();
  const workspace = await mkdtemp(
    join(tmpdir(), "sevro-native-child-workspace-"),
  );
  roots.push(workspace);
  const skillDir = join(workspace, ".agents", "skills", "example");
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  const body =
    "---\nname: example\ndescription: Example\n---\n\nPrivate skill body.\n";
  await writeFile(skillPath, body);
  await session(root, lines([spawn, started, result]));
  const command = {
    type: "item_completed",
    item: {
      type: "CommandExecution",
      command: ["/bin/zsh", "-lc", `cat ${skillPath}`],
      aggregated_output: body,
      exit_code: 0,
      status: "completed",
    },
  };
  await session(root, lines([command]), "thread-child");
  const context = { workspace, installedPluginRoots: [] };
  const observed = await codexNativeCallObservation(root, "thread-1", context);
  expectUnknown(observed.data.childSessions).toEqual([
    {
      threadId: "thread-child",
      status: "available",
      resultStatus: "unavailable",
      nestedSpawns: [],
      requestsTruncated: false,
      readDiagnostics: {
        completeness: "complete",
        observedSkills: ["example"],
        completedReads: [{ skill: "example", ordinal: 0 }],
        recoverySources: [
          {
            ordinal: 0,
            nativeOutput: true,
            yieldedChunks: 0,
            completedCall: false,
            literalCommandCall: false,
          },
        ],
        commandExecutions: 1,
        readAttempts: 1,
        truncated: false,
      },
    },
  ]);
  expect(JSON.stringify(observed)).not.toContain("Private skill body.");
  expect(JSON.stringify(observed)).not.toContain(skillPath);
  await session(
    root,
    lines([
      { ...command, item: { ...command.item, aggregated_output: "summary" } },
    ]),
    "thread-child",
  );
  expect(
    defined(
      (await codexNativeCallObservation(root, "thread-1", context)).data
        .childSessions[0],
    ),
  ).toMatchObject({
    status: "available",
    readDiagnostics: { completeness: "partial", observedSkills: [] },
  });
});
test("accepted child completion binds one nonempty final message to its turn", async () => {
  const root = await home();
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
  const root = await home();
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
  const root = await home();
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
test("child read diagnostics distinguish no read from an indirect attempt", async () => {
  const root = await home();
  const workspace = await mkdtemp(
    join(tmpdir(), "sevro-native-child-workspace-"),
  );
  roots.push(workspace);
  await session(root, lines([spawn, started, result]));
  await session(
    root,
    lines([{ type: "item_completed", item: { type: "AgentMessage" } }]),
    "thread-child",
  );
  const context = { workspace, installedPluginRoots: [] };
  expectUnknown(
    defined(
      (await codexNativeCallObservation(root, "thread-1", context)).data
        .childSessions[0],
    ).readDiagnostics,
  ).toEqual({
    completeness: "complete",
    observedSkills: [],
    completedReads: [],
    recoverySources: [],
    commandExecutions: 0,
    readAttempts: 0,
    truncated: false,
  });
  await session(
    root,
    lines([
      {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          command: ["/bin/zsh", "-lc", "printf SKILL.md"],
          aggregated_output: "SKILL.md",
          exit_code: 0,
          status: "completed",
        },
      },
    ]),
    "thread-child",
  );
  expect(
    defined(
      (await codexNativeCallObservation(root, "thread-1", context)).data
        .childSessions[0],
    ).readDiagnostics,
  ).toMatchObject({
    completeness: "partial",
    observedSkills: [],
    readAttempts: 1,
  });
});
test("child session lookup is capped with an explicit truncation flag", async () => {
  const root = await home();
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
  const root = await home();
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
test("native tool calls retain order and feedback target without private input", async () => {
  const root = await home();
  await session(
    root,
    lines([
      spawn,
      started,
      result,
      {
        type: "function_call",
        namespace: "collaboration",
        name: "send_message",
        arguments: JSON.stringify({
          target: "/root/reviewer",
          message: "private feedback",
        }),
      },
      { type: "custom_tool_call", name: "exec", input: "private code" },
      { type: "function_call", namespace: "collaboration", name: "wait_agent" },
    ]),
  );
  const observed = await codexNativeCallObservation(root, "thread-1");
  expectUnknown(observed.data.toolCalls).toEqual([
    { ordinal: 0, namespace: "collaboration", name: "spawn_agent" },
    {
      ordinal: 3,
      namespace: "collaboration",
      name: "send_message",
      target: "/root/reviewer",
    },
    { ordinal: 4, namespace: "other", name: "exec" },
    { ordinal: 5, namespace: "collaboration", name: "wait_agent" },
  ]);
  expect(JSON.stringify(observed)).not.toContain("private feedback");
  expect(JSON.stringify(observed)).not.toContain("private code");
});
// eslint-disable-next-line max-lines-per-function -- Keep this single integration scenario's fixture, process invocation, and exact assertions together; sevro/test-callback-lines independently caps this callback at 200.
test("native feedback retains target and unique response without message text", async () => {
  const root = await home();
  const feedback = {
    type: "function_call",
    namespace: "collaboration",
    name: "followup_task",
    call_id: "feedback-1",
    arguments: JSON.stringify({ target: "owner", message: "private feedback" }),
  };
  const response = {
    type: "function_call_output",
    call_id: "feedback-1",
    output: "private tool result",
  };
  await session(root, lines([feedback, response]));
  const observed = await codexNativeCallObservation(root, "thread-1");
  expectUnknown(observed.data.feedbackCalls).toEqual([
    {
      ordinal: 0,
      tool: "followup_task",
      target: "owner",
      responseObserved: true,
      messageRepresentation: "plaintext",
      messageMatchesFollowUpPrompt: null,
    },
  ]);
  const context = {
    workspace: root,
    installedPluginRoots: [],
    followUpPrompt: "private feedback",
  };
  expect(
    (await codexNativeCallObservation(root, "thread-1", context)).data
      .feedbackCalls,
  ).toMatchObject([{ messageMatchesFollowUpPrompt: true }]);
  expect(
    (
      await codexNativeCallObservation(root, "thread-1", {
        ...context,
        followUpPrompt: "different feedback",
      })
    ).data.feedbackCalls,
  ).toMatchObject([{ messageMatchesFollowUpPrompt: false }]);
  expect(JSON.stringify(observed)).not.toContain("private feedback");
  expect(JSON.stringify(observed)).not.toContain("private tool result");
  await session(root, lines([feedback]));
  expect(
    (await codexNativeCallObservation(root, "thread-1")).data.feedbackCalls,
  ).toMatchObject([{ responseObserved: false }]);
  await session(root, lines([feedback, response, response]));
  expect(
    (await codexNativeCallObservation(root, "thread-1")).data.feedbackCalls,
  ).toMatchObject([{ responseObserved: false }]);
  await session(root, lines([{ ...feedback, arguments: "{broken" }, response]));
  expect(
    (await codexNativeCallObservation(root, "thread-1")).data.feedbackCalls,
  ).toMatchObject([
    {
      target: null,
      messageRepresentation: "unavailable",
      messageMatchesFollowUpPrompt: null,
    },
  ]);
  await session(
    root,
    lines([
      {
        ...feedback,
        arguments: JSON.stringify({
          target: "owner",
          message: "gAAAAABencrypted-feedback-token",
        }),
      },
      response,
    ]),
  );
  expect(
    (await codexNativeCallObservation(root, "thread-1", context)).data
      .feedbackCalls,
  ).toMatchObject([
    {
      messageRepresentation: "encrypted",
      messageMatchesFollowUpPrompt: null,
    },
  ]);
});
test("native feedback requires string labels in retained evidence", async () => {
  const root = await home();
  const feedback = {
    type: "function_call",
    namespace: "collaboration",
    name: "followup_task",
    arguments: JSON.stringify({ target: "owner", message: "private feedback" }),
  };
  await session(
    root,
    lines([
      { ...feedback, name: ["followup_task"], call_id: "array-label" },
      { ...feedback, call_id: "string-label" },
    ]),
  );
  const observed = await codexNativeCallObservation(root, "thread-1");
  expect(observed.completeness).toBe("complete");
  expect(observed.data.toolCalls.map((call) => call.name)).toEqual([
    "other",
    "followup_task",
  ]);
  expect(observed.data.feedbackCalls.map((call) => call.tool)).toEqual([
    "followup_task",
  ]);
  expect(JSON.stringify(observed)).not.toContain("private feedback");
});

test("ambiguous, mismatched, and malformed spawn evidence cannot establish acceptance", async () => {
  const root = await home();
  for (const payloads of [
    [spawn, started, started, result],
    [spawn, started, result, result],
    [spawn, spawn, started, result],
    [spawn, result, started],
    [spawn, started, { ...result, output: '{"task_name":"/root/other"}' }],
  ]) {
    await session(root, lines(payloads));
    expectUnknown(
      (await codexNativeCallObservation(root, "thread-1")).data.acceptedSpawns,
    ).toEqual([]);
  }
  await session(root, lines([spawn, started, result]) + "{bad\n");
  const partial = await codexNativeCallObservation(root, "thread-1");
  expect(partial.completeness).toBe("partial");
  expectUnknown(partial.data.acceptedSpawns).toEqual([]);
});
test("missing, ambiguous, and malformed native sessions cannot prove absence", async () => {
  const root = await home();
  expect(await codexNativeCallObservation(root, "thread-1")).toMatchObject({
    completeness: "unavailable",
    data: { calls: [] },
  });
  await session(root, "{broken\n");
  expect(await codexNativeCallObservation(root, "thread-1")).toMatchObject({
    completeness: "partial",
    data: { calls: [] },
  });
  await session(
    root,
    '{"ordinal":0,"payload":{"type":"function_call","name":"get_goal"}}\n',
    "other-thread-1",
  );
  expect(await codexNativeCallObservation(root, "thread-1")).toMatchObject({
    completeness: "partial",
  });
});
test("native session traversal refuses links and oversized content", async () => {
  const root = await home();
  await session(root, `${" ".repeat(8 * 1024 * 1024)}\n`);
  expect(await codexNativeCallObservation(root, "thread-1")).toMatchObject({
    completeness: "partial",
  });
  await rm(join(root, "sessions"), { recursive: true });
  const outside = await home();
  await symlink(outside, join(root, "sessions"));
  expect(await codexNativeCallObservation(root, "thread-1")).toMatchObject({
    completeness: "partial",
  });
});

test.each([null, 42, "[]", "null"])(
  "native malformed serialized spawn arguments cannot establish acceptance: %s",
  async (argumentsValue) => {
    const root = await home();
    await session(
      root,
      lines([{ ...spawn, arguments: argumentsValue }, started, result]),
    );
    const observed = await codexNativeCallObservation(root, "thread-1");
    expect(observed.completeness).toBe("complete");
    expect(observed.data.acceptedSpawns).toEqual([]);
    expect(observed.data.toolCalls).toMatchObject([{ name: "spawn_agent" }]);
  },
);

test("accepted spawn identity survives absent optional requested route fields", async () => {
  const root = await home();
  await session(root, lines([{ ...spawn, arguments: "{}" }, started, result]));
  const observed = await codexNativeCallObservation(root, "thread-1");
  expect(observed.data.acceptedSpawns).toHaveLength(1);
  expect(defined(observed.data.acceptedSpawns[0])).toMatchObject({
    agentRef: "/root/reviewer",
    threadId: "thread-child",
  });
  expect(defined(observed.data.acceptedSpawns[0]).taskName).toBeUndefined();
});

test.each([
  { name: "nonarray", content: null },
  { name: "empty blocks", content: [] },
  { name: "nonstring text", content: [{ type: "Text", text: 42 }] },
  {
    name: "nontext block",
    content: [{ type: "Image", text: "private answer" }],
  },
])(
  "child completion cannot bind malformed final content: %j",
  async ({ content }) => {
    const root = await home();
    await session(root, lines([spawn, started, result]));
    await session(
      root,
      lines([
        {
          type: "item_completed",
          turn_id: "turn-child",
          item: { type: "AgentMessage", phase: "final_answer", content },
        },
        {
          type: "task_complete",
          turn_id: "turn-child",
          last_agent_message: "private answer",
        },
      ]),
      "thread-child",
    );
    const observed = await codexNativeCallObservation(root, "thread-1");
    expect(defined(observed.data.childSessions[0])).toMatchObject({
      status: "available",
      resultStatus: "unavailable",
    });
    expect(JSON.stringify(observed)).not.toContain("private answer");
  },
);

test.each(["thread-1", "thread-child"])(
  "nested spawn cannot use its root or parent session as reader evidence: %s",
  async (threadId) => {
    const root = await home();
    await session(root, lines([spawn, started, result]));
    await session(
      root,
      lines([
        { ...spawn, call_id: "nested", arguments: "{}" },
        {
          ...started,
          item: {
            ...started.item,
            id: "nested",
            agent_path: "/root/reviewer/reader",
            agent_thread_id: threadId,
          },
        },
        {
          ...result,
          call_id: "nested",
          output: JSON.stringify({ task_name: "/root/reviewer/reader" }),
        },
      ]),
      "thread-child",
    );
    const observed = await codexNativeCallObservation(root, "thread-1");
    expect(defined(observed.data.childSessions[0]).nestedSpawns).toMatchObject([
      {
        status: "accepted",
        sessionStatus: "partial",
        readerResultStatus: "unavailable",
      },
    ]);
  },
);

test("a spawn pointing back to the root cannot establish an independent child session", async () => {
  const root = await home();
  await session(
    root,
    lines([
      spawn,
      { ...started, item: { ...started.item, agent_thread_id: "thread-1" } },
      result,
    ]),
  );
  expect(
    (await codexNativeCallObservation(root, "thread-1")).data.childSessions,
  ).toEqual([{ threadId: "thread-1", status: "partial" }]);
});

test("a nested invocation with malformed arguments records an unaccepted reader attempt", async () => {
  const root = await home();
  await session(root, lines([spawn, started, result]));
  await session(
    root,
    lines([{ ...spawn, call_id: "nested", arguments: "[]" }]),
    "thread-child",
  );
  const observed = await codexNativeCallObservation(root, "thread-1");
  expect(defined(observed.data.childSessions[0]).nestedSpawns).toEqual([
    {
      requestedOrdinal: 0,
      status: "unaccepted",
      sessionStatus: "unavailable",
      readerResultStatus: "unavailable",
    },
  ]);
});

test("invalid UTF-8 and oversized child bytes preserve partial evidence without a completion", async () => {
  const root = await home();
  await session(root, lines([spawn, started, result]));
  const path = join(root, "sessions/2026/09/27/rollout-thread-child.jsonl");
  for (const bytes of [
    new Uint8Array([255, 254]),
    Buffer.alloc(8 * 1024 * 1024 + 1, 32),
  ]) {
    await writeFile(path, bytes);
    expect(
      (await codexNativeCallObservation(root, "thread-1")).data.childSessions,
    ).toEqual([{ threadId: "thread-child", status: "partial" }]);
  }
  await session(root, " ".repeat(8 * 1024 * 1024 + 1));
  expect(await codexNativeSessionLastOrdinal(root, "thread-1")).toBeNull();
  await writeFile(
    join(root, "sessions/2026/09/27/rollout-thread-1.jsonl"),
    new Uint8Array([255, 254]),
  );
  expect(
    (await codexNativeCallObservation(root, "thread-1")).completeness,
  ).toBe("partial");
  expect(await codexNativeSessionLastOrdinal(root, "thread-1")).toBeNull();
});

function recoveryPayloads(command: unknown): Record<string, unknown>[] {
  return [
    {
      type: "custom_tool_call",
      name: "exec",
      call_id: "read-call",
      input:
        'const result = await tools.exec_command({cmd:"cat .agents/skills/example/SKILL.md"}); text(result.output);',
    },
    {
      type: "custom_tool_call_output",
      call_id: "read-call",
      output: {
        session_id: 101,
        chunk_id: "part",
        wall_time_seconds: 0,
        output: "private recovered bytes",
      },
    },
    {
      type: "item_completed",
      item: {
        id: "read",
        type: "CommandExecution",
        source: "unified_exec_startup",
        process_id: "101",
        command,
        status: "completed",
        exit_code: 0,
      },
    },
    { type: "item_completed", item: { type: "AgentMessage" } },
  ];
}

test("native recovery requires one validated shell command even with process-bound yielded output", async () => {
  const root = await home();
  await session(
    root,
    lines(
      recoveryPayloads([
        "/bin/sh",
        "-c",
        "cat .agents/skills/example/SKILL.md",
      ]),
    ),
  );
  const recovered = await codexNativeSkillReadRecovery(root, "thread-1");
  expect(recovered.get("read")).toEqual({
    command: "cat .agents/skills/example/SKILL.md",
    output: "private recovered bytes",
  });
  for (const command of [
    "cat .agents/skills/example/SKILL.md",
    ["cat", "SKILL.md"],
    ["/bin/sh", "-x", "cat SKILL.md"],
    ["/bin/sh", "-c", 42],
  ]) {
    await session(root, lines(recoveryPayloads(command)));
    expect((await codexNativeSkillReadRecovery(root, "thread-1")).size).toBe(0);
  }
  await session(root, "{broken\n");
  expect((await codexNativeSkillReadRecovery(root, "thread-1")).size).toBe(0);
  await session(root, " ".repeat(8 * 1024 * 1024 + 1));
  expect((await codexNativeSkillReadRecovery(root, "thread-1")).size).toBe(0);
});

test("an unavailable skill context cannot make valid native calls complete", async () => {
  const root = await home();
  await session(root, lines([spawn, started, result]));
  expect(
    (
      await codexNativeCallObservation(root, "thread-1", {
        workspace: join(root, "missing-workspace"),
        installedPluginRoots: [],
      })
    ).completeness,
  ).toBe("partial");
});

test("an unreadable owned native session cannot supply recovered command output", async () => {
  const root = await home();
  await session(
    root,
    lines(
      recoveryPayloads([
        "/bin/sh",
        "-c",
        "cat .agents/skills/example/SKILL.md",
      ]),
    ),
  );
  const path = join(root, "sessions/2026/09/27/rollout-thread-1.jsonl");
  await chmod(path, 0);
  try {
    expect(readFile(path)).rejects.toMatchObject({ code: "EACCES" });
    expect((await codexNativeSkillReadRecovery(root, "thread-1")).size).toBe(0);
  } finally {
    await chmod(path, 0o600);
  }
});
