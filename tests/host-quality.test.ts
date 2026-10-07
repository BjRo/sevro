import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCodexAppServer,
  type AppServerRunOptions,
} from "../src/hosts/codex-app-server";
import { codexNativeReadDiagnostic } from "../src/hosts/codex-skill-reads";
import { claudeNestedSkillsObservation } from "../src/hosts/claude-nested-skills";
import { createClaudeHost, type ClaudeHostOptions } from "../src/hosts/claude";
import { codexNativeCallObservation } from "../src/hosts/codex-native-calls";
import {
  withAuthenticationEnvironment,
  withSyntheticKeychain,
} from "./fixtures/quality-host-auth";
import { defined, record } from "./fixtures/assertions";

const roots: string[] = [];
const skillBody =
  "---\nname: probe\ndescription: A fixture skill\n---\nPRIVATE_SKILL_BODY\n";
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function workspace() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-host-quality-")),
  );
  roots.push(root);
  await mkdir(join(root, ".git"));
  return root;
}
async function serverOptions(mode: string): Promise<AppServerRunOptions> {
  const root = await workspace();
  return {
    request: {
      repoDir: root,
      prompt: "Return ready",
      model: "synthetic",
      effort: "low",
      control: { appServerTimeoutMs: 2000 },
    },
    argv: [
      process.execPath,
      join(import.meta.dir, "fixtures/quality-host-app-server.ts"),
      mode,
    ],
    env: {},
    permissionProfile: "test_profile",
    followUpBoundary: () =>
      Promise.resolve(
        JSON.stringify({ type: "sevro.follow_up_boundary", thread_id: "root" }),
      ),
  };
}
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

type NativeEntry = { ordinal: number; payload: Record<string, unknown> };
async function skillWorkspace() {
  const root = await workspace();
  const skill = join(root, ".agents/skills/probe/SKILL.md");
  await mkdir(join(skill, ".."), { recursive: true });
  await writeFile(skill, skillBody);
  return { root, command: "cat .agents/skills/probe/SKILL.md" };
}
function nativeCompletion(command: string, root: string): NativeEntry {
  return {
    ordinal: 2,
    payload: {
      type: "item_completed",
      item: {
        id: "read",
        type: "CommandExecution",
        source: "unified_exec_startup",
        process_id: "101",
        command: ["/bin/sh", "-c", command],
        cwd: root,
        status: "completed",
        exit_code: 0,
      },
    },
  };
}
function completedEnvelope(output = skillBody): unknown {
  return [
    {
      type: "text",
      text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
    },
    { type: "text", text: output },
  ];
}
function literalRecovery(
  source: string,
  command: string,
  root: string,
): NativeEntry[] {
  return [
    {
      ordinal: 0,
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "call",
        input: source,
      },
    },
    {
      ordinal: 1,
      payload: {
        type: "custom_tool_call_output",
        call_id: "call",
        output: completedEnvelope(),
      },
    },
    nativeCompletion(command, root),
  ];
}
const literalRefusals = [
  "let r = await tools.exec_command({cmd: COMMAND}); text(r.output);",
  "const r = tools.exec_command({cmd: COMMAND}); text(r.output);",
  "const {output} = await tools.exec_command({cmd: COMMAND}); text(output);",
  "const tools = await tools.exec_command({cmd: COMMAND}); text(tools.output);",
  "const r = await tools.exec_command({cmd: COMMAND, unknown: true}); text(r.output);",
  "const r = await tools.exec_command({cmd: COMMAND, workdir: 3}); text(r.output);",
  "const r = await tools.exec_command({cmd: COMMAND, shell: false}); text(r.output);",
  "const r = await tools.exec_command({cmd: COMMAND, cmd: COMMAND}); text(r.output);",
  "const r = await tools.exec_command({['cmd']: COMMAND}); text(r.output);",
  "const r = await tools.exec_command({...options, cmd: COMMAND}); text(r.output);",
  "const r = await tools.exec_command({cmd: COMMAND}); text('unrelated');",
  "const r = await tools.exec_command({cmd: COMMAND}); text(r.stderr);",
  "const r = await tools.exec_command({cmd: COMMAND}); text(r.output, r.output);",
  "const r = await tools.exec_command({cmd: COMMAND}); store(3, r.session_id); text(r.output);",
  "const r = await tools.exec_command({cmd: COMMAND}); store('key', r.output); text(r.output);",
  "const r = await tools.exec_command({cmd: COMMAND}); text(r.output); text(r.output);",
  "const r = await other.exec_command({cmd: COMMAND}); text(r.output);",
  "const r = await tools.exec_command({cmd: COMMAND}, {}); text(r.output);",
  "const r = await tools.exec_command({cmd: COMMAND}); if (r) text(r.output);",
  "const r = await tools.exec_command({cmd: COMMAND}); text(r.output); extra();",
  "const r = await tools.exec_command({cmd: COMMAND}); text(r.output); {broken",
];
test.each(literalRefusals)(
  "native recovery refuses indirect executor evidence: %s",
  async (template) => {
    const { root, command } = await skillWorkspace();
    const source = template.replaceAll("COMMAND", JSON.stringify(command));
    const observed = await codexNativeReadDiagnostic(
      literalRecovery(source, command, root),
      root,
    );
    expect(observed.completeness).toBe("partial");
    expect(observed.observedSkills).toEqual([]);
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_SKILL_BODY");
  },
);
test.each([
  "",
  ", yield_time_ms: 0, max_output_tokens: 100, login: true, tty: false",
  ", workdir: ROOT, shell: '/bin/sh'",
])("native literal recovery binds one direct command: %s", async (options) => {
  const { root, command } = await skillWorkspace();
  const source = `const r = await tools.exec_command({cmd: ${JSON.stringify(command)}${options.replace("ROOT", JSON.stringify(root))}}); text(r.output); store('session', r.session_id);`;
  const observed = await codexNativeReadDiagnostic(
    literalRecovery(source, command, root),
    root,
  );
  expect(observed.completeness).toBe("complete");
  expect(observed.observedSkills).toEqual(["probe"]);
  expect(observed.recoverySources).toEqual([
    {
      ordinal: 2,
      nativeOutput: false,
      yieldedChunks: 0,
      completedCall: false,
      literalCommandCall: true,
    },
  ]);
});

const invalidChunks: Array<[string, unknown]> = [
  [
    "invalid process",
    {
      session_id: 0,
      chunk_id: "part",
      wall_time_seconds: 0,
      output: skillBody,
    },
  ],
  [
    "missing chunk",
    { session_id: 101, wall_time_seconds: 0, output: skillBody },
  ],
  [
    "negative wall time",
    {
      session_id: 101,
      chunk_id: "part",
      wall_time_seconds: -1,
      output: skillBody,
    },
  ],
  [
    "already exited",
    {
      session_id: 101,
      chunk_id: "part",
      wall_time_seconds: 0,
      exit_code: 0,
      output: skillBody,
    },
  ],
  [
    "indirect JSON",
    {
      printed: {
        session_id: 101,
        chunk_id: "part",
        wall_time_seconds: 0,
        output: skillBody,
      },
    },
  ],
  [
    "prose",
    "before " +
      JSON.stringify({
        session_id: 101,
        chunk_id: "part",
        wall_time_seconds: 0,
        output: skillBody,
      }),
  ],
];
function yieldedRecovery(
  output: unknown,
  command: string,
  root: string,
): NativeEntry[] {
  return [
    {
      ordinal: 0,
      payload: {
        type: "function_call",
        name: "exec_command",
        namespace: "functions",
        call_id: "call",
      },
    },
    {
      ordinal: 1,
      payload: { type: "function_call_output", call_id: "call", output },
    },
    nativeCompletion(command, root),
  ];
}
test.each(invalidChunks)(
  "native yielded recovery refuses %s",
  async (_name, output) => {
    const { root, command } = await skillWorkspace();
    const observed = await codexNativeReadDiagnostic(
      yieldedRecovery(output, command, root),
      root,
    );
    expect(observed.completeness).toBe("partial");
    expect(observed.observedSkills).toEqual([]);
  },
);

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
test("native yielded recovery joins unique ordered chunks and refuses duplicate receipts", async () => {
  const { root, command } = await skillWorkspace();
  const chunks = [
    {
      session_id: 101,
      chunk_id: "first",
      wall_time_seconds: 0,
      output: skillBody.slice(0, 20),
    },
    {
      session_id: "101",
      chunk_id: "second",
      wall_time_seconds: 0.1,
      output: skillBody.slice(20),
    },
  ];
  const entries = yieldedRecovery(chunks, command, root);
  const complete = await codexNativeReadDiagnostic(entries, root);
  expect(complete.completeness).toBe("complete");
  expect(complete.completedReads).toEqual([{ skill: "probe", ordinal: 2 }]);
  expect(complete.recoverySources).toEqual([
    {
      ordinal: 2,
      nativeOutput: false,
      yieldedChunks: 2,
      completedCall: false,
      literalCommandCall: false,
    },
  ]);
  defined(chunks[1]).chunk_id = "first";
  expect((await codexNativeReadDiagnostic(entries, root)).completeness).toBe(
    "partial",
  );
});

async function claudeGraph() {
  const root = await workspace(),
    config = join(root, "config"),
    session = "session";
  const project = join(config, "projects", root.replace(/[^A-Za-z0-9]/g, "-"));
  const childDir = join(project, session, "subagents");
  await mkdir(childDir, { recursive: true });
  return {
    root,
    config,
    session,
    project,
    childDir,
    stream: JSON.stringify({ type: "result", session_id: session }),
  };
}
type ClaudeGraph = Awaited<ReturnType<typeof claudeGraph>>;
function agentEntry(
  graph: ClaudeGraph,
  blocks: unknown[],
  type = "assistant",
  extra: Record<string, unknown> = {},
) {
  return {
    type,
    sessionId: graph.session,
    message: { content: blocks },
    ...extra,
  };
}
async function writeClaudeGraph(graph: ClaudeGraph, mode: string) {
  const call = agentEntry(graph, [
    { type: "tool_use", name: "Agent", id: "spawn" },
  ]);
  const result = agentEntry(
    graph,
    [
      {
        type: "tool_result",
        tool_use_id: "spawn",
        is_error: mode === "failed-child",
      },
    ],
    "user",
    {
      toolUseResult: {
        status: mode === "incomplete-child" ? "running" : "completed",
        agentId: "child",
      },
    },
  );
  const child = agentEntry(
    graph,
    [
      {
        type: "tool_use",
        name: "Skill",
        input: {
          skill: mode === "invalid-skill" ? "bad skill" : "plugin:probe",
        },
      },
    ],
    "assistant",
    { agentId: mode === "foreign-child" ? "foreign" : "child" },
  );
  await writeFile(
    join(graph.project, `${graph.session}.jsonl`),
    [call, result].map((entry) => JSON.stringify(entry)).join("\n"),
  );
  await writeFile(
    join(graph.childDir, "agent-child.jsonl"),
    JSON.stringify(child),
  );
}
test("Claude nested evidence binds completed children and redacts skill input", async () => {
  const graph = await claudeGraph();
  await writeClaudeGraph(graph, "success");
  const observed = await claudeNestedSkillsObservation(
    graph.stream,
    graph.config,
    graph.root,
  );
  expect(observed).toEqual({
    id: "sevro.claude.nested-skills",
    completeness: "complete",
    data: {
      method: "native_session_graph",
      calls: [
        {
          ancestorToolUseId: "spawn",
          skill: "probe",
          invocation: "plugin:probe",
        },
      ],
    },
  });
  expect(JSON.stringify(observed)).not.toContain("message");
});
test.each([
  "failed-child",
  "incomplete-child",
  "foreign-child",
  "invalid-skill",
])("Claude nested evidence fails closed for %s", async (mode) => {
  const graph = await claudeGraph();
  await writeClaudeGraph(graph, mode);
  expect(
    await claudeNestedSkillsObservation(graph.stream, graph.config, graph.root),
  ).toMatchObject({ completeness: "partial", data: { calls: [] } });
});
test("Claude nested evidence refuses redirected child files", async () => {
  const graph = await claudeGraph();
  await writeClaudeGraph(graph, "success");
  const path = join(graph.childDir, "agent-child.jsonl"),
    outside = join(graph.root, "outside.jsonl");
  await writeFile(outside, await readFile(path));
  await rm(path);
  await symlink(outside, path);
  expect(
    (
      await claudeNestedSkillsObservation(
        graph.stream,
        graph.config,
        graph.root,
      )
    ).completeness,
  ).toBe("partial");
});

test.each(["success", "ambiguous", "foreign-parent"])(
  "Claude child sidecars establish only unique bound identity: %s",
  async (mode) => {
    const graph = await claudeGraph();
    await writeClaudeGraph(graph, "success");
    const rootEntries = (
      await readFile(join(graph.project, `${graph.session}.jsonl`), "utf8")
    )
      .split("\n")
      .map((line) => record(JSON.parse(line)));
    delete defined(rootEntries[1]).toolUseResult;
    await writeFile(
      join(graph.project, `${graph.session}.jsonl`),
      rootEntries.map((entry) => JSON.stringify(entry)).join("\n"),
    );
    await writeFile(
      join(graph.childDir, "agent-child.meta.json"),
      JSON.stringify({
        toolUseId: "spawn",
        parentAgentId: mode === "foreign-parent" ? "foreign" : null,
      }),
    );
    if (mode === "ambiguous")
      await writeFile(
        join(graph.childDir, "agent-other.meta.json"),
        JSON.stringify({ toolUseId: "spawn" }),
      );
    const observed = await claudeNestedSkillsObservation(
      graph.stream,
      graph.config,
      graph.root,
    );
    expect(observed.completeness).toBe(
      mode === "success" ? "complete" : "partial",
    );
    expect(observed.data.calls).toHaveLength(mode === "success" ? 1 : 0);
  },
);

const invalidClaudeRoots: Array<[string, unknown[]]> = [
  [
    "unresolved child",
    [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Agent", id: "pending" }],
        },
      },
    ],
  ],
  [
    "duplicate child calls",
    [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Task", id: "duplicate" },
            { type: "tool_use", name: "Agent", id: "duplicate" },
          ],
        },
      },
    ],
  ],
  [
    "malformed call ID",
    [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Agent", id: "bad id" }],
        },
      },
    ],
  ],
  [
    "foreign session",
    [{ type: "assistant", sessionId: "foreign", message: { content: [] } }],
  ],
  [
    "foreign actor",
    [{ type: "user", agentId: "foreign", message: { content: [] } }],
  ],
  ["nonobject entry", [[]]],
];
test.each(invalidClaudeRoots)(
  "Claude nested graph refuses %s",
  async (_name, entries) => {
    const graph = await claudeGraph();
    const bound = entries.map((value) =>
      Array.isArray(value)
        ? value
        : { sessionId: graph.session, ...record(value) },
    );
    await writeFile(
      join(graph.project, `${graph.session}.jsonl`),
      bound.map((entry) => JSON.stringify(entry)).join("\n"),
    );
    expect(
      await claudeNestedSkillsObservation(
        graph.stream,
        graph.config,
        graph.root,
      ),
    ).toMatchObject({ completeness: "partial", data: { calls: [] } });
  },
);

test("Claude nested graph bounds and stream ambiguity stay partial", async () => {
  const graph = await claudeGraph();
  await writeClaudeGraph(graph, "success");
  const observation = (stream: string) =>
    claudeNestedSkillsObservation(stream, graph.config, graph.root);
  expect((await observation("{broken")).completeness).toBe("partial");
  expect((await observation("{}")).completeness).toBe("partial");
  expect(
    (
      await observation(
        graph.stream +
          "\n" +
          JSON.stringify({ type: "result", session_id: "other" }),
      )
    ).completeness,
  ).toBe("partial");
  const child = agentEntry(
    graph,
    Array.from({ length: 129 }, () => ({
      type: "tool_use",
      name: "Skill",
      input: { skill: "plugin:probe" },
    })),
    "assistant",
    { agentId: "child" },
  );
  await writeFile(
    join(graph.childDir, "agent-child.jsonl"),
    JSON.stringify(child),
  );
  expect((await observation(graph.stream)).completeness).toBe("partial");
});

test("Claude graph refuses a reused child identity rather than duplicating skill receipts", async () => {
  const graph = await claudeGraph();
  await writeClaudeGraph(graph, "success");
  const path = join(graph.project, `${graph.session}.jsonl`);
  const secondCall = agentEntry(graph, [
    { type: "tool_use", name: "Agent", id: "spawn-two" },
  ]);
  const secondResult = agentEntry(
    graph,
    [{ type: "tool_result", tool_use_id: "spawn-two" }],
    "user",
    { toolUseResult: { status: "completed", agentId: "child" } },
  );
  await writeFile(
    path,
    (await readFile(path, "utf8")) +
      "\n" +
      [secondCall, secondResult]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
  );
  expect(
    await claudeNestedSkillsObservation(graph.stream, graph.config, graph.root),
  ).toMatchObject({ completeness: "partial", data: { calls: [] } });
});

test.each([
  { label: "relative cwd", change: { cwd: "relative" } },
  { label: "nonstrings in command", change: { command: ["cat", 3] } },
  {
    label: "unreadable cwd",
    change: { cwd: "/nonexistent-sevro-quality-cwd" },
  },
  { label: "missing exit code", change: { exit_code: undefined } },
  { label: "unfinished command", change: { status: "running" } },
  { label: "indirect read", change: { command: "printf SKILL.md" } },
  {
    label: "invalid sed range",
    change: { command: "sed -n '4,1p' .agents/skills/probe/SKILL.md" },
  },
  {
    label: "empty sed range",
    change: { command: "sed -n '99,100p' .agents/skills/probe/SKILL.md" },
  },
  {
    label: "gapped sed coverage",
    change: { command: "sed -n '3,5p' .agents/skills/probe/SKILL.md" },
  },
])("native skill diagnostics refuse %s", async ({ change }) => {
  const { root, command } = await skillWorkspace();
  const entry = nativeCompletion(command, root);
  entry.payload.item = {
    ...record(entry.payload.item),
    aggregated_output: skillBody,
    ...change,
  };
  const observed = await codexNativeReadDiagnostic([entry], root);
  expect(observed.completeness).toBe("partial");
  expect(observed.observedSkills).toEqual([]);
  expect(JSON.stringify(observed)).not.toContain("PRIVATE_SKILL_BODY");
});

test("native read diagnostics cap repeated attempts and keep exact completed ordinals", async () => {
  const { root, command } = await skillWorkspace();
  const entries = Array.from({ length: 65 }, (_, ordinal) => ({
    ordinal,
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        command,
        status: "completed",
        exit_code: 0,
        aggregated_output: skillBody,
      },
    },
  }));
  const observed = await codexNativeReadDiagnostic(entries, root);
  expect(observed).toMatchObject({
    completeness: "partial",
    readAttempts: 64,
    commandExecutions: 65,
    truncated: true,
    observedSkills: ["probe"],
  });
  expect(observed.completedReads).toHaveLength(64);
  expect(defined(observed.completedReads.at(-1))).toEqual({
    skill: "probe",
    ordinal: 63,
  });
});

test.each(["wrong-frontmatter", "oversized", "missing"])(
  "native skill verification refuses %s mounted bytes",
  async (mode) => {
    const { root, command } = await skillWorkspace();
    const path = join(root, ".agents/skills/probe/SKILL.md");
    const bodies: Record<string, string> = {
      "wrong-frontmatter": "name: probe\n",
      oversized: "---\nname: probe\n" + "x".repeat(1024 * 1024),
    };
    if (mode === "missing") await rm(path);
    else await writeFile(path, defined(bodies[mode]));
    const entry = nativeCompletion(command, root);
    entry.payload.item = {
      ...record(entry.payload.item),
      aggregated_output: skillBody,
    };
    expect((await codexNativeReadDiagnostic([entry], root)).completeness).toBe(
      "partial",
    );
  },
);

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

async function claudeHostFixture() {
  const root = await workspace(),
    candidate = join(root, "candidate"),
    source = join(root, "source"),
    results = join(root, "results"),
    binary = join(root, "synthetic-claude"),
    credential = join(root, "credential.json");
  await rm(join(root, ".git"), { recursive: true });
  await Promise.all([
    mkdir(join(candidate, ".git"), { recursive: true }),
    mkdir(source),
    mkdir(results),
  ]);
  await cp(join(import.meta.dir, "fixtures/quality-host-claude.ts"), binary);
  await chmod(binary, 0o700);
  await writeFile(credential, '{"login":"PRIVATE_TEST_LOGIN"}');
  const options: ClaudeHostOptions = {
    binary,
    model: "synthetic",
    effort: "low",
    projectRoot: source,
    resultsRoot: results,
    additionalProtectedRoots: [],
    credentialFile: credential,
  };
  return {
    root,
    candidate,
    source,
    results,
    binary,
    credential,
    options,
    request: {
      prompt: "ready",
      workspace: candidate,
      condition: "passive" as const,
    },
  };
}
type ClaudeFixture = Awaited<ReturnType<typeof claudeHostFixture>>;
type ClaudeRequest = Parameters<ReturnType<typeof createClaudeHost>["run"]>[0];
async function claudeCapture(fixture: Pick<ClaudeFixture, "candidate">) {
  return record(
    JSON.parse(
      await readFile(join(fixture.candidate, "authentication.json"), "utf8"),
    ),
  );
}
function captureConfig(capture: Record<string, unknown>): string {
  if (typeof capture.config !== "string")
    throw new Error("Expected captured configuration path");
  return capture.config;
}
function credentialEnvironment(
  root: string,
): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CONFIG_DIR: join(root, "ambient"),
    USER: "quality-account",
    LOGNAME: undefined,
  };
}
function requirePrivateResult(
  result: Awaited<ReturnType<ReturnType<typeof createClaudeHost>["run"]>>,
) {
  expect(result.complete).toBe(true);
  expect(result.finalMessage).toBe("ready");
  expect(JSON.stringify(result.observations)).not.toMatch(
    /PRIVATE_TEST_LOGIN|PRIVATE_API_KEY|PRIVATE_OAUTH_TOKEN|PRIVATE_GOAL_OBJECTIVE/,
  );
}
test("Claude explicit credential takes precedence over inherited authentication", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await claudeHostFixture();
  await withAuthenticationEnvironment(
    {
      ...credentialEnvironment(fixture.root),
      ANTHROPIC_API_KEY: "PRIVATE_API_KEY",
      CLAUDE_CODE_OAUTH_TOKEN: "PRIVATE_OAUTH_TOKEN",
    },
    async () => {
      const result = await createClaudeHost(fixture.options).run(
        fixture.request,
      );
      requirePrivateResult(result);
      const capture = await claudeCapture(fixture);
      expect(capture).toMatchObject({
        saved: true,
        expectedLogin: true,
        permission: 0o600,
        userRules: false,
        userSettings: false,
        api: false,
        oauth: false,
        scrub: "1",
      });
      expect(
        readFile(join(captureConfig(capture), ".credentials.json")),
      ).rejects.toThrow();
    },
  );
});
test.each(["api", "oauth", "both"])(
  "Claude inherited %s credentials stay in the host environment",
  async (mode) => {
    if (process.platform !== "darwin") return;
    const fixture = await claudeHostFixture();
    delete fixture.options.credentialFile;
    const environment = {
      ...credentialEnvironment(fixture.root),
      ANTHROPIC_API_KEY: mode === "oauth" ? undefined : "PRIVATE_API_KEY",
      CLAUDE_CODE_OAUTH_TOKEN:
        mode === "api" ? undefined : "PRIVATE_OAUTH_TOKEN",
    };
    await withAuthenticationEnvironment(environment, async () => {
      requirePrivateResult(
        await createClaudeHost(fixture.options).run(fixture.request),
      );
      expect(await claudeCapture(fixture)).toMatchObject({
        saved: false,
        api: mode !== "oauth",
        oauth: mode !== "api",
        scrub: "1",
      });
    });
  },
);
test("Claude saved configuration contributes only credentials to private state", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await claudeHostFixture();
  delete fixture.options.credentialFile;
  const saved = join(fixture.root, "saved");
  await mkdir(saved);
  await writeFile(
    join(saved, ".credentials.json"),
    '{"login":"PRIVATE_TEST_LOGIN"}',
  );
  await writeFile(join(saved, "CLAUDE.md"), "PRIVATE_USER_RULE");
  await writeFile(
    join(saved, "settings.json"),
    '{"userSetting":"PRIVATE_SETTING"}',
  );
  await withAuthenticationEnvironment(
    { ...credentialEnvironment(fixture.root), CLAUDE_CONFIG_DIR: saved },
    async () => {
      requirePrivateResult(
        await createClaudeHost(fixture.options).run(fixture.request),
      );
      const capture = await claudeCapture(fixture);
      expect(capture).toMatchObject({
        saved: true,
        expectedLogin: true,
        permission: 0o600,
        userRules: false,
        userSettings: false,
      });
      expect(
        readFile(join(captureConfig(capture), "CLAUDE.md")),
      ).rejects.toThrow();
    },
  );
});
test.each(["empty", "whitespace", "oversized", "missing"])(
  "Claude selected credential %s refuses execution without fallback",
  async (mode) => {
    if (process.platform !== "darwin") return;
    const fixture = await claudeHostFixture();
    const bytes: Record<string, string> = {
      empty: "",
      whitespace: " \n\t",
      oversized: "x".repeat(1024 * 1024 + 1),
    };
    if (mode === "missing") await rm(fixture.credential);
    else await writeFile(fixture.credential, defined(bytes[mode]));
    expect(
      createClaudeHost(fixture.options).run(fixture.request),
    ).rejects.toThrow(
      /credential is (?:empty or oversized|unreadable or unavailable)/,
    );
    expect(
      readFile(join(fixture.candidate, "authentication.json")),
    ).rejects.toThrow();
  },
);
test("Claude unreadable saved configuration refuses authentication rather than querying another login", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await claudeHostFixture();
  delete fixture.options.credentialFile;
  await withAuthenticationEnvironment(
    credentialEnvironment(fixture.credential),
    () => {
      expect(
        createClaudeHost(fixture.options).run(fixture.request),
      ).rejects.toThrow(/saved credential is unreadable or unavailable/);
    },
  );
});
test("Claude refuses an oversized environment credential before model execution", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await claudeHostFixture();
  delete fixture.options.credentialFile;
  await withAuthenticationEnvironment(
    {
      ...credentialEnvironment(fixture.root),
      ANTHROPIC_API_KEY: "x".repeat(1024 * 1024 + 1),
    },
    () => {
      expect(
        createClaudeHost(fixture.options).run(fixture.request),
      ).rejects.toThrow(/environment credential exceeds the size limit/);
    },
  );
});
test.each([true, false])(
  "Claude missing saved credentials use the synthetic keychain account=%s",
  async (account) => {
    if (process.platform !== "darwin") return;
    const fixture = await claudeHostFixture();
    delete fixture.options.credentialFile;
    await withAuthenticationEnvironment(
      {
        ...credentialEnvironment(fixture.root),
        USER: account ? "quality-account" : undefined,
      },
      async () => {
        await withSyntheticKeychain("success", account, async () => {
          requirePrivateResult(
            await createClaudeHost(fixture.options).run(fixture.request),
          );
          expect(await claudeCapture(fixture)).toMatchObject({
            saved: true,
            permission: 0o600,
            expectedLogin: true,
          });
        });
      },
    );
  },
);
test.each(["failure", "empty", "whitespace", "oversized", "slow"])(
  "Claude keychain %s cannot become authenticated success",
  async (mode) => {
    if (process.platform !== "darwin") return;
    const fixture = await claudeHostFixture();
    delete fixture.options.credentialFile;
    const marker = join(fixture.root, "security.pid");
    await withAuthenticationEnvironment(
      {
        ...credentialEnvironment(fixture.root),
        SEVRO_QUALITY_SECURITY_PID: marker,
      },
      async () => {
        await withSyntheticKeychain(mode, true, () => {
          expect(
            createClaudeHost(fixture.options).run(fixture.request),
          ).rejects.toThrow(
            /credential is (?:empty or oversized|unreadable or unavailable)/,
          );
        });
        const pid = Number(await readFile(marker, "utf8"));
        expect(Number.isSafeInteger(pid)).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(
          readFile(join(fixture.candidate, "authentication.json")),
        ).rejects.toThrow();
      },
    );
  },
);

test.each([
  ["ready", "complete"],
  ["goal-active", "active"],
  ["goal-blocked", "blocked"],
  ["goal-cleared", "cleared"],
] as const)(
  "Claude retained native goal reports %s as %s without its objective",
  async (mode, status) => {
    if (process.platform !== "darwin") return;
    const fixture = await claudeHostFixture();
    fixture.request.prompt = mode;
    const result = await createClaudeHost(fixture.options).run(fixture.request);
    requirePrivateResult(result);
    expect(
      result.observations?.find((item) => item.id === "sevro.host.native-goal"),
    ).toMatchObject({
      completeness: "complete",
      data: { goalStatus: status, goals: [{ status, characters: 23 }] },
    });
  },
);
test.each([
  "goal-malformed",
  "goal-too-long",
  "goal-no-objective",
  "goal-foreign",
  "goal-ambiguous",
])(
  "Claude malformed persisted native goal remains unavailable: %s",
  async (mode) => {
    if (process.platform !== "darwin") return;
    const fixture = await claudeHostFixture();
    fixture.request.prompt = mode;
    const result = await createClaudeHost(fixture.options).run(fixture.request);
    expect(result.complete).toBe(true);
    expect(
      result.observations?.find((item) => item.id === "sevro.host.native-goal"),
    ).toMatchObject({ completeness: "unavailable" });
    expect(JSON.stringify(result.observations)).not.toContain(
      "PRIVATE_GOAL_OBJECTIVE",
    );
  },
);

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

const invalidClaudeOptions: Array<{
  label: string;
  change: Partial<ClaudeHostOptions>;
}> = [
  { label: "relative binary", change: { binary: "relative" } },
  { label: "relative credential", change: { credentialFile: "relative" } },
  { label: "relative toolchain", change: { toolchainBinDir: "relative" } },
  { label: "relative cache", change: { uvCacheDir: "relative" } },
  {
    label: "relative private root",
    change: { additionalProtectedRoots: ["relative"] },
  },
  { label: "missing model", change: { model: "" } },
  { label: "missing effort", change: { effort: "" } },
  { label: "zero timeout", change: { timeoutMs: 0 } },
  { label: "fractional timeout", change: { timeoutMs: 1.5 } },
  { label: "excessive timeout", change: { timeoutMs: 30 * 60_000 + 1 } },
];
test.each(invalidClaudeOptions)(
  "Claude route refuses invalid configuration: %s",
  async ({ change }) => {
    if (process.platform !== "darwin") return;
    const fixture = await claudeHostFixture();
    expect(() => createClaudeHost({ ...fixture.options, ...change })).toThrow(
      /invalid Claude host configuration/,
    );
  },
);
test.each([
  "follow-up",
  "condition",
  "instrumentation",
  "fixture-bin",
  "repository-source",
])("Claude route refuses undeclared execution change: %s", async (mode) => {
  if (process.platform !== "darwin") return;
  const fixture = await claudeHostFixture();
  const request: ClaudeRequest = { ...fixture.request };
  const changes: Record<string, () => void> = {
    "follow-up": () => {
      request.followUpPrompt = " \n";
    },
    condition: () => {
      request.condition = "enforced";
    },
    instrumentation: () => {
      request.instrumentation = [
        { id: "example.enforcement", configuration: {} },
      ];
    },
    "fixture-bin": () => {
      request.fixtureBinDir = fixture.root;
    },
    "repository-source": () => {
      request.explicitSkillInvocation = {
        scope: "repository",
        skillName: "probe",
        token: "/probe",
      };
    },
  };
  defined(changes[mode])();
  expect(createClaudeHost(fixture.options).run(request)).rejects.toThrow(
    /follow-up prompt|enforcement instrumentation|binary path is outside|requires project setting sources/,
  );
  expect(
    readFile(join(fixture.candidate, "authentication.json")),
  ).rejects.toThrow();
});

async function claudePluginFixture() {
  const fixture = await claudeHostFixture(),
    relativeRoot = "package/probe",
    plugin = join(fixture.candidate, relativeRoot);
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
  await mkdir(join(plugin, "skills/probe"), { recursive: true });
  await writeFile(
    join(plugin, ".claude-plugin/plugin.json"),
    '{"name":"probe"}',
  );
  await writeFile(
    join(plugin, "skills/probe/SKILL.md"),
    "Use the declared probe skill.\n",
  );
  const request: ClaudeRequest = {
    ...fixture.request,
    prompt: "Use /probe:probe",
    explicitSkillInvocation: {
      pluginName: "probe",
      skillName: "probe",
      token: "/probe:probe",
    },
    claudePluginDirs: {
      artifactRoots: [relativeRoot],
      artifactPaths: [
        `${relativeRoot}/.claude-plugin/plugin.json`,
        `${relativeRoot}/skills/probe/SKILL.md`,
      ],
    },
  };
  return { ...fixture, plugin, relativeRoot, request };
}
type ClaudePluginFixture = Awaited<ReturnType<typeof claudePluginFixture>>;
async function invalidatePlugin(fixture: ClaudePluginFixture, mode: string) {
  const declaration = defined(fixture.request.claudePluginDirs);
  const actions: Record<string, () => Promise<void>> = {
    "duplicate roots": () => {
      declaration.artifactRoots.push(fixture.relativeRoot);
      return Promise.resolve();
    },
    "duplicate artifacts": () => {
      declaration.artifactPaths.push(defined(declaration.artifactPaths[0]));
      return Promise.resolve();
    },
    "undeclared manifest": () => {
      declaration.artifactPaths.shift();
      return Promise.resolve();
    },
    "malformed manifest": () =>
      writeFile(join(fixture.plugin, ".claude-plugin/plugin.json"), "{broken"),
    "wrong manifest identity": () =>
      writeFile(
        join(fixture.plugin, ".claude-plugin/plugin.json"),
        '{"name":"foreign"}',
      ),
    "nonfile skill": async () => {
      const path = join(fixture.plugin, "skills/probe/SKILL.md");
      await rm(path);
      await mkdir(path);
    },
    "outside artifact": async () => {
      await writeFile(join(fixture.candidate, "outside.txt"), "outside");
      declaration.artifactPaths.push("outside.txt");
    },
    "redirected artifact": async () => {
      const path = join(fixture.plugin, "skills/probe/SKILL.md");
      await rm(path);
      await symlink(fixture.credential, path);
    },
    "overlapping aliases": async () => {
      await symlink(fixture.plugin, join(fixture.candidate, "package/alias"));
      declaration.artifactRoots.push("package/alias");
      declaration.artifactPaths.push(
        "package/alias/.claude-plugin/plugin.json",
      );
    },
    "nested roots": async () => {
      await mkdir(join(fixture.plugin, "nested/.claude-plugin"), {
        recursive: true,
      });
      await writeFile(
        join(fixture.plugin, "nested/.claude-plugin/plugin.json"),
        "{}",
      );
      declaration.artifactRoots.push(`${fixture.relativeRoot}/nested`);
      declaration.artifactPaths.push(
        `${fixture.relativeRoot}/nested/.claude-plugin/plugin.json`,
      );
    },
  };
  await defined(actions[mode])();
}
test.each([
  "duplicate roots",
  "duplicate artifacts",
  "undeclared manifest",
  "malformed manifest",
  "wrong manifest identity",
  "nonfile skill",
  "outside artifact",
  "redirected artifact",
  "overlapping aliases",
  "nested roots",
])("Claude refuses an unsafe declared plugin: %s", async (mode) => {
  if (process.platform !== "darwin") return;
  const fixture = await claudePluginFixture();
  await invalidatePlugin(fixture, mode);
  expect(
    createClaudeHost(fixture.options).run(fixture.request),
  ).rejects.toThrow(
    /duplicates|undeclared|manifest|absent|outside|escapes|overlap/,
  );
  expect(
    readFile(join(fixture.candidate, "authentication.json")),
  ).rejects.toThrow();
});
test("Claude verifies a declared plugin invocation before the real host process", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await claudePluginFixture();
  requirePrivateResult(
    await createClaudeHost(fixture.options).run(fixture.request),
  );
  expect(await claudeCapture(fixture)).toMatchObject({
    saved: true,
    expectedLogin: true,
  });
});
test.each([
  "missing",
  "repeated",
  "invalid-token",
  "invalid-plugin",
  "invalid-skill",
])("Claude explicit dispatch refuses %s invocation", async (mode) => {
  if (process.platform !== "darwin") return;
  const fixture = await claudePluginFixture();
  const changes: Record<string, () => void> = {
    missing: () => {
      fixture.request.prompt = "No dispatch token";
    },
    repeated: () => {
      fixture.request.prompt = "/probe:probe /probe:probe";
    },
    "invalid-token": () => {
      fixture.request.explicitSkillInvocation = {
        pluginName: "probe",
        skillName: "probe",
        token: "/wrong",
      };
      fixture.request.prompt = "/wrong";
    },
    "invalid-plugin": () => {
      fixture.request.explicitSkillInvocation = {
        pluginName: "UPPER",
        skillName: "probe",
        token: "/UPPER:probe",
      };
      fixture.request.prompt = "/UPPER:probe";
    },
    "invalid-skill": () => {
      fixture.request.explicitSkillInvocation = {
        pluginName: "probe",
        skillName: "bad/name",
        token: "/probe:bad/name",
      };
      fixture.request.prompt = "/probe:bad/name";
    },
  };
  defined(changes[mode])();
  expect(
    createClaudeHost(fixture.options).run(fixture.request),
  ).rejects.toThrow(/invalid Claude explicit skill invocation/);
});
test.each(["executable", "toolchain", "cache"])(
  "Claude refuses protected %s execution assets",
  async (mode) => {
    if (process.platform !== "darwin") return;
    const fixture = await claudeHostFixture();
    const options: ClaudeHostOptions = { ...fixture.options };
    if (mode === "executable")
      options.additionalProtectedRoots = [fixture.binary];
    if (mode === "toolchain") options.toolchainBinDir = fixture.source;
    if (mode === "cache") options.uvCacheDir = fixture.source;
    expect(createClaudeHost(options).run(fixture.request)).rejects.toThrow(
      /executable resides inside|toolchain directory|UV cache/,
    );
    expect(
      readFile(join(fixture.candidate, "authentication.json")),
    ).rejects.toThrow();
  },
);

function completedRecovery(command: string, root: string): NativeEntry[] {
  const source = `const r = await tools.exec_command({cmd:${JSON.stringify(command)},workdir:${JSON.stringify(root)},shell:'/bin/sh'}); text(r.output);`;
  const entries = literalRecovery(source, command, root);
  defined(entries[2]).ordinal = 1;
  defined(entries[1]).ordinal = 2;
  return [defined(entries[0]), defined(entries[2]), defined(entries[1])];
}
test("native early completed output proves one exact actor-local mounted read", async () => {
  const { root, command } = await skillWorkspace();
  const observed = await codexNativeReadDiagnostic(
    completedRecovery(command, root),
    root,
  );
  expect(observed.completeness).toBe("complete");
  expect(observed.completedReads).toEqual([{ skill: "probe", ordinal: 1 }]);
  expect(observed.recoverySources).toEqual([
    {
      ordinal: 1,
      nativeOutput: false,
      yieldedChunks: 0,
      completedCall: true,
      literalCommandCall: false,
    },
  ]);
  expect(JSON.stringify(observed)).not.toContain("PRIVATE_SKILL_BODY");
});
const malformedCompletedOutputs: Array<{ label: string; output: unknown }> = [
  { label: "unstructured JSON", output: "{broken" },
  {
    label: "missing body",
    output: [
      {
        type: "text",
        text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
      },
    ],
  },
  {
    label: "image content",
    output: [
      {
        type: "text",
        text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
      },
      { type: "image", text: skillBody },
    ],
  },
  {
    label: "wrong completion header",
    output: [
      { type: "text", text: "Script is still running\n" },
      { type: "text", text: skillBody },
    ],
  },
  {
    label: "yielded content cannot become plain completed output",
    output: completedEnvelope(
      JSON.stringify({ session_id: 101, output: skillBody }),
    ),
  },
];
test.each(malformedCompletedOutputs)(
  "native completed output refuses malformed proof: %s",
  async ({ output }) => {
    const { root, command } = await skillWorkspace();
    const entries = completedRecovery(command, root);
    defined(entries[2]).payload.output = output;
    const observed = await codexNativeReadDiagnostic(entries, root);
    expect(observed.completeness).toBe("partial");
    expect(observed.observedSkills).toEqual([]);
  },
);
test.each([
  "duplicate call",
  "duplicate response",
  "interleaved call",
  "duplicate process",
  "wrong shell",
  "wrong cwd",
])("native completed recovery refuses ambiguous binding: %s", async (mode) => {
  const { root, command } = await skillWorkspace();
  const entries = completedRecovery(command, root);
  const call = defined(entries[0]),
    completion = defined(entries[1]),
    result = defined(entries[2]);
  const item = record(completion.payload.item);
  const changes: Record<string, () => void> = {
    "duplicate call": () => {
      completion.ordinal = 2;
      result.ordinal = 3;
      entries.push({ ordinal: 1, payload: { ...call.payload } });
    },
    "duplicate response": () => {
      entries.push({ ordinal: 3, payload: { ...result.payload } });
    },
    "interleaved call": () => {
      completion.ordinal = 2;
      result.ordinal = 3;
      entries.push({
        ordinal: 1,
        payload: { type: "function_call", name: "other" },
      });
    },
    "duplicate process": () => {
      entries.push({
        ordinal: 3,
        payload: { type: "item_completed", item: { ...item, id: "other" } },
      });
    },
    "wrong shell": () => {
      item.command = ["/bin/zsh", "-c", command];
    },
    "wrong cwd": () => {
      item.cwd = "file://untrusted-host/path";
    },
  };
  defined(changes[mode])();
  entries.sort((left, right) => left.ordinal - right.ordinal);
  const observed = await codexNativeReadDiagnostic(entries, root);
  expect(observed.completeness).toBe("partial");
  expect(observed.observedSkills).toEqual([]);
});
