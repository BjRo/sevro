import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codexNativeReadDiagnostic } from "../../src/hosts/codex-skill-reads";
import { codexNativeCallObservation } from "../../src/hosts/codex-native-calls";
import { defined, record } from "../fixtures/assertions";
import { createWorkspace } from "../fixtures/native-host-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const workspace = createWorkspace(roots);

const skillBody =
  "---\nname: probe\ndescription: A fixture skill\n---\nPRIVATE_SKILL_BODY\n";

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
  "const r = await tools.exec_command(null); text(r.output);",
  "const r = await tools.exec_command([]); text(r.output);",
  "const r = await tools.exec_command({cmd: null}); text(r.output);",
  "const r = await tools.exec_command({cmd: COMMAND}); text(r.output); store();",
  "const r = await tools.exec_command({cmd: COMMAND}); text(r.output); store('session');",
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

test.each([null, 42, { command: "cat .agents/skills/probe/SKILL.md" }])(
  "native recovery refuses nonstring serialized executor input: %j",
  async (input) => {
    const { root, command } = await skillWorkspace();
    const entries = literalRecovery("unused", command, root);
    defined(entries[0]).payload.input = input;
    const observed = await codexNativeReadDiagnostic(entries, root);
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

test("native wire already aggregated command bytes need no duplicate output recovery", async () => {
  const { root, command } = await skillWorkspace();
  const entries = completedRecovery(command, root);
  const completion = defined(entries[1]);
  completion.payload.item = {
    ...record(completion.payload.item),
    aggregated_output: skillBody,
  };
  const observed = await codexNativeReadDiagnostic(entries, root);
  expect(observed.completeness).toBe("complete");
  expect(observed.completedReads).toEqual([{ skill: "probe", ordinal: 1 }]);
  expect(observed.recoverySources).toMatchObject([
    { nativeOutput: true, completedCall: false, literalCommandCall: false },
  ]);
});

test.each([
  {
    label: "string argv",
    fields: { command: "cat .agents/skills/probe/SKILL.md" },
  },
  {
    label: "short argv",
    fields: { command: ["cat", ".agents/skills/probe/SKILL.md"] },
  },
  { label: "missing cwd", fields: { cwd: null } },
  { label: "relative cwd", fields: { cwd: "relative-directory" } },
])(
  "native wire recovery refuses incomplete command binding: %s",
  async ({ fields }) => {
    const { root, command } = await skillWorkspace();
    const entries = completedRecovery(command, root);
    const completion = defined(entries[1]);
    completion.payload.item = { ...record(completion.payload.item), ...fields };
    const observed = await codexNativeReadDiagnostic(entries, root);
    expect(observed.completeness).toBe("partial");
    expect(observed.observedSkills).toEqual([]);
  },
);

test("native wire structured process identity is not plain completed command output", async () => {
  const { root, command } = await skillWorkspace();
  const entries = completedRecovery(command, root);
  defined(entries[2]).payload.output = completedEnvelope(
    JSON.stringify({ session_id: 101 }),
  );
  const observed = await codexNativeReadDiagnostic(entries, root);
  expect(observed.completeness).toBe("partial");
  expect(observed.observedSkills).toEqual([]);
  expect(observed.recoverySources).toMatchObject([{ completedCall: false }]);
});

test.each([
  { label: "null", output: null },
  { label: "number", output: 42 },
])(
  "native wire yielded primitive result cannot establish a read: %s",
  async ({ output }) => {
    const { root, command } = await skillWorkspace();
    const observed = await codexNativeReadDiagnostic(
      yieldedRecovery(output, command, root),
      root,
    );
    expect(observed.completeness).toBe("partial");
    expect(observed.observedSkills).toEqual([]);
  },
);

test("native wire yielded output requires correlation and bounded envelope nesting", async () => {
  const { root, command } = await skillWorkspace();
  const chunk = {
    session_id: 101,
    chunk_id: "part",
    wall_time_seconds: 0,
    output: skillBody,
  };
  const envelope = [{ type: "text", text: JSON.stringify(chunk) }];
  expect(
    (
      await codexNativeReadDiagnostic(
        yieldedRecovery(envelope, command, root),
        root,
      )
    ).completeness,
  ).toBe("complete");
  const unbound = yieldedRecovery(chunk, command, root);
  defined(unbound[1]).payload.call_id = null;
  expect((await codexNativeReadDiagnostic(unbound, root)).completeness).toBe(
    "partial",
  );
  let deep: unknown = envelope;
  for (let layer = 0; layer < 4; layer++) deep = [deep];
  expect(
    (
      await codexNativeReadDiagnostic(
        yieldedRecovery(deep, command, root),
        root,
      )
    ).completeness,
  ).toBe("partial");
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
