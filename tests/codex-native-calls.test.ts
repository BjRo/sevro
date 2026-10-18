import { expectUnknown } from "./fixtures/assertions";
import { defined } from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import {
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
} from "../src/hosts/codex-native-calls";
import { codexNativeControls } from "../src/hosts/native-controls";
const roots: string[] = [];

test.each([
  {
    input: 'text(await tools.exec_command({cmd:"pwd"}));',
    execution: "failed",
    reason: null,
  },
  {
    input: 'const r=await tools.exec_command({cmd:"pwd"});text(r.output',
    execution: "failed",
    reason: "malformed_source",
  },
])(
  "Code Mode reports $execution separately from $reason inspection",
  async ({ input, execution, reason }) => {
    const root = await home();
    await session(
      root,
      lines([
        { type: "custom_tool_call", name: "exec", call_id: "failed", input },
        {
          type: "custom_tool_call_output",
          call_id: "failed",
          output: [
            {
              type: "input_text",
              text: "Script failed\nWall time 0.1 seconds\nOutput:\n",
            },
            { type: "input_text", text: "private failure" },
          ],
        },
      ]),
    );
    const portable = codexNativeControls(
      await codexNativeCallObservation(root, "thread-1"),
    );
    expect(portable.completeness).toBe(reason ? "partial" : "complete");
    expectUnknown(portable.data).toMatchObject({
      coverage: { nativeCalls: "complete" },
      execCalls: [{ inspectionReason: reason, execution, output: "complete" }],
    });
    expect(JSON.stringify(portable)).not.toContain("private");
  },
);

test("Code Mode never repairs an incomplete native capture through source inspection", async () => {
  const root = await home();
  await session(
    root,
    lines([
      {
        type: "function_call",
        namespace: "collaboration",
        name: "spawn_agent",
        call_id: "rejected",
        arguments: "{}",
      },
      {
        type: "custom_tool_call",
        name: "exec",
        call_id: "safe",
        input: 'text(await tools.exec_command({cmd:"pwd"}));',
      },
    ]) + "{broken\n",
  );
  const portable = codexNativeControls(
    await codexNativeCallObservation(root, "thread-1"),
  );
  expect(portable.completeness).toBe("partial");
  expectUnknown(portable.data).toMatchObject({
    acceptedAgentCount: null,
    submittedExecCalls: null,
    coverage: { nativeCalls: "partial", execInspection: "complete" },
    calls: [{ name: "spawn_agent" }, { name: "exec" }],
  });
});

test.each([
  "const JSON={};text(JSON.stringify({}));",
  'const String={};text(String("result"));',
  "const r=await Promise.all([]);for(const x of r){text(await tools.spawn_agent({}));}",
  'const r=await Promise.all([]);for(const x of r){if(x.status === "fulfilled")text(await tools.spawn_agent({}));}',
  "const r=await Promise.all([]);for(let i=0;i<r.length;i++){text(await tools.spawn_agent({}));}",
  "const r=await Promise.all([]);for(let i=1;i<r.length;i++){text(r[i]);}",
  "const r=await Promise.all([]);for(let i=0;i<=r.length;i++){text(r[i]);}",
  "const r=await Promise.all([]);for(let i=0;i<r.length;i--){text(r[i]);}",
  'const r=await Promise.all([]);for(let i=0;i<r.length;i++){text(r[load("index")]);}',
  'text(true ? await tools.spawn_agent({}) : "no launch");',
])("Code Mode retains uncertainty for unsafe formatting: %s", async (input) => {
  const portable = await submittedProgram(input, 0);
  expect(portable.completeness).toBe("partial");
  expect(portable.data.acceptedAgentCount).toBeNull();
});

test.each([
  'const r=await Promise.all([tools.exec_command({cmd:"pwd"})]);for(const x of r)text(x.output);',
  'const r=await Promise.allSettled([tools.exec_command({cmd:"pwd"})]);for(const x of r){if(x.status === "fulfilled")text(x.value.output);else text(String(x.reason));}',
])(
  "Code Mode inspects faithful retained batch-output shapes: %s",
  async (input) => {
    const portable = await submittedProgram(input, 0);
    expect(portable.completeness).toBe("complete");
    expectUnknown(portable.data).toMatchObject({
      acceptedAgentCount: 0,
      execCalls: [{ calls: [{ name: "exec_command" }] }],
    });
  },
);

test("Code Mode keeps direct acceptance facts scoped during dynamic inspection gaps", async () => {
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
        name: "spawn_agent",
        call_id: "rejected",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "rejected",
        output: "Unknown model",
      },
      {
        type: "custom_tool_call",
        name: "exec",
        call_id: "dynamic",
        input: 'tools[load("tool")]({});',
      },
    ]),
  );
  const portable = codexNativeControls(
    await codexNativeCallObservation(root, "thread-1"),
  );
  expect(portable.completeness).toBe("partial");
  expectUnknown(portable.data).toMatchObject({
    acceptedAgentCount: null,
    directAcceptedAgentCount: 1,
    submittedExecCalls: 1,
    truncated: false,
    coverage: {
      nativeCalls: "complete",
      execInspection: "partial",
      acceptedAgents: "direct_native_calls",
    },
    calls: [
      { ordinal: 0, namespace: "collaboration", name: "spawn_agent" },
      { ordinal: 3, namespace: "collaboration", name: "spawn_agent" },
      { ordinal: 5, name: "exec" },
    ],
    execCalls: [
      {
        completeness: "partial",
        inspectionReason: "unsupported_source",
        execution: "incomplete",
        output: "unavailable",
      },
    ],
  });
});

test("Code Mode separates truncated output from no-launch source coverage", async () => {
  const root = await home();
  await session(
    root,
    lines([
      {
        type: "custom_tool_call",
        name: "exec",
        call_id: "truncated",
        input: 'const r=await tools.exec_command({cmd:"pwd"});text(r.output);',
      },
      {
        type: "custom_tool_call_output",
        call_id: "truncated",
        output: JSON.stringify([
          {
            type: "input_text",
            text: "Script completed\nWall time 1.0 seconds\nOutput:\n",
          },
          { type: "input_text", text: "Warning: truncated output" },
        ]),
      },
    ]),
  );
  const source = await codexNativeCallObservation(root, "thread-1");
  expect(source.completeness).toBe("complete");
  const portable = codexNativeControls(source);
  expect(portable.completeness).toBe("complete");
  expectUnknown(portable.data).toMatchObject({
    acceptedAgentCount: 0,
    execCalls: [
      {
        completeness: "complete",
        inspectionReason: null,
        execution: "completed",
        output: "truncated",
      },
    ],
  });
});

test("Code Mode inspects bounded numeric batch-output loops", async () => {
  const portable = await submittedProgram(
    'const results=await Promise.allSettled([tools.exec_command({cmd:"pwd"})]);for(let i=0;i<results.length;i++){text(JSON.stringify({i,...results[i]}));}',
    1,
  );
  expect(portable.completeness).toBe("complete");
  expectUnknown(portable.data).toMatchObject({
    execCalls: [
      { calls: [{ index: 0, namespace: "functions", name: "exec_command" }] },
    ],
  });
});

test("Code Mode inspects ordinary conditional batch-result formatting", async () => {
  const portable = await submittedProgram(
    'const results=await Promise.allSettled([tools.exec_command({cmd:"pwd"}),tools.exec_command({cmd:"ls"})]);for(const r of results){text(r.status === "fulfilled" ? JSON.stringify({...r.value}) : String(r.reason));}',
    1,
  );
  expect(portable.completeness).toBe("complete");
  expectUnknown(portable.data).toMatchObject({
    execCalls: [
      {
        calls: [
          { index: 0, namespace: "functions", name: "exec_command" },
          { index: 1, namespace: "functions", name: "exec_command" },
        ],
      },
    ],
  });
});

test("Code Mode inspects JSON serialization without inventing launches", async () => {
  const portable = await submittedProgram(
    'const r=await tools.exec_command({cmd:"pwd"});text(JSON.stringify(r));',
    1,
  );
  expect(portable.completeness).toBe("complete");
  expectUnknown(portable.data).toMatchObject({
    acceptedAgentCount: 0,
    execCalls: [
      {
        completeness: "complete",
        calls: [{ index: 0, namespace: "functions", name: "exec_command" }],
      },
    ],
  });
});
test("Code Mode recovers retained direct ordinal 45 template commands", async () => {
  const input = await readFile(
    join(import.meta.dir, "fixtures/code-mode-85/direct-45.txt"),
    "utf8",
  );
  const portable = await submittedProgram(input, 45);
  expect(portable.completeness).toBe("complete");
  expectUnknown(portable.data).toMatchObject({
    acceptedAgentCount: 0,
    submittedExecCalls: 1,
    execCalls: [
      {
        ordinal: 45,
        completeness: "complete",
        calls: [
          { index: 0, namespace: "functions", name: "exec_command" },
          { index: 1, namespace: "functions", name: "exec_command" },
          { index: 2, namespace: "functions", name: "exec_command" },
        ],
      },
    ],
  });
  expect(JSON.stringify(portable)).not.toContain("/private/");
});

test.each([
  { ordinal: 30, count: 3 },
  { ordinal: 68, count: 2 },
])(
  "Code Mode recovers retained coupled ordinal $ordinal batch results",
  async ({ ordinal, count }) => {
    const input = await readFile(
      join(import.meta.dir, `fixtures/code-mode-85/coupled-${ordinal}.txt`),
      "utf8",
    );
    const portable = await submittedProgram(input, ordinal);
    expect(portable.completeness).toBe("complete");
    expectUnknown(portable.data).toMatchObject({
      acceptedAgentCount: 0,
      execCalls: [
        {
          ordinal,
          completeness: "complete",
          calls: Array.from({ length: count }, (_, index) => ({
            index,
            namespace: "functions",
            name: "exec_command",
          })),
        },
      ],
    });
  },
);

test.each([69, 77])(
  "Code Mode recovers retained direct ordinal %s patch and template output",
  async (ordinal) => {
    const input = await readFile(
      join(import.meta.dir, `fixtures/code-mode-85/direct-${ordinal}.txt`),
      "utf8",
    );
    const portable = await submittedProgram(input, ordinal);
    expect(portable.completeness).toBe("complete");
    expectUnknown(portable.data).toMatchObject({
      acceptedAgentCount: 0,
      execCalls: [
        {
          ordinal,
          completeness: "complete",
          calls: [
            { index: 0, namespace: "other", name: "apply_patch" },
            { index: 1, namespace: "functions", name: "exec_command" },
          ],
        },
      ],
    });
  },
);

test("Code Mode retains submitted spawns with template arguments and batch composition", async () => {
  const portable = await submittedProgram(
    'const [a,b]=await Promise.allSettled([tools.spawn_agent({message:`private task`}),tools.exec_command({cmd:"private command"})]); text(`${a.status}`+b.status);',
    7,
  );
  expect(portable.completeness).toBe("complete");
  expectUnknown(portable.data).toMatchObject({
    acceptedAgentCount: 0,
    execCalls: [
      {
        ordinal: 7,
        completeness: "complete",
        calls: [
          { index: 0, namespace: "collaboration", name: "spawn_agent" },
          { index: 1, namespace: "functions", name: "exec_command" },
        ],
      },
    ],
  });
});

test.each([
  'text(`result=${await tools.spawn_agent({message:"private task"})}`); text(await tools.exec_command({cmd:"private command"}));',
  'text("result="+await tools.spawn_agent({message:"private task"})); text(await tools.exec_command({cmd:"private command"}));',
])("Code Mode traverses tool calls in composed output: %s", async (input) => {
  const portable = await submittedProgram(input, 3);
  expect(portable.completeness).toBe("complete");
  expectUnknown(portable.data).toMatchObject({
    acceptedAgentCount: 0,
    execCalls: [
      {
        ordinal: 3,
        completeness: "complete",
        calls: [
          { index: 0, namespace: "collaboration", name: "spawn_agent" },
          { index: 1, namespace: "functions", name: "exec_command" },
        ],
      },
    ],
  });
});

test.each([
  "const [tools]=await Promise.all([]);",
  "const [text]=await Promise.all([]);",
  "const [Promise]=await Promise.all([]);",
  "const [a,a]=await Promise.all([]);",
  "const a=1; const [a]=await Promise.all([]);",
  "const [a=tools.spawn_agent({})]=await Promise.all([]);",
  "const [...a]=await Promise.all([]);",
  "const [,a]=await Promise.all([]);",
  "const [[a]]=await Promise.all([]);",
  "const {a}=await Promise.all([]);",
  "const [a]=[tools.exec_command({})];",
  "const [a]=Promise.all([tools.exec_command({})]);",
  "text(`${tools.spawn_agent}`);",
  'text(`${load("tool")}`);',
  "text(String.raw`tools.spawn_agent({})`);",
  "const a=1; text(a || tools.spawn_agent({}));",
  "const a=1; text(a-tools.spawn_agent({}));",
  "const a=1; text(a+=tools.spawn_agent({}));",
  "const a=1; text(a+missing);",
])(
  "Code Mode keeps ambiguous binding or composition partial: %s",
  async (input) => {
    const portable = await submittedProgram(input, 0);
    expect(portable.completeness).toBe("partial");
    expect(portable.data.acceptedAgentCount).toBeNull();
  },
);

async function submittedProgram(input: string, ordinal: number) {
  const root = await home();
  const padding = Array.from({ length: ordinal }, () => ({
    type: "event_msg",
  }));
  await session(
    root,
    lines([
      ...padding,
      { type: "custom_tool_call", name: "exec", call_id: "retained", input },
      {
        type: "custom_tool_call_output",
        call_id: "retained",
        output: [
          {
            type: "text",
            text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
          },
        ],
      },
    ]),
  );
  return codexNativeControls(
    await codexNativeCallObservation(root, "thread-1"),
  );
}

test.each([
  "await service.exec_command({});",
  "await tools.reader.exec_command({});",
  "let result = await tools.get_goal({});",
  "const result;",
  "for (const item of []) text(item);",
  "const results = await Promise.all([]); for (item of results) text(item);",
  "const results = await Promise.all([]); for (let item of results) text(item);",
  "const results = await Promise.all([]); for (const item = 1 of results) text(item);",
])(
  "Code Mode cannot establish complete control evidence from unsupported bindings: %s",
  async (input) => {
    const observed = await submittedProgram(input, 0);
    expect(observed.completeness).toBe("partial");
    expect(observed.data.acceptedAgentCount).toBeNull();
  },
);

test.each([
  { callId: 42, output: [] },
  { callId: "retained", output: { private: "unstructured result" } },
  { callId: "retained", output: "{}" },
])(
  "Code Mode keeps missing structured completion separate from source coverage: %j",
  async ({ callId, output }) => {
    const root = await home();
    await session(
      root,
      lines([
        {
          type: "custom_tool_call",
          name: "exec",
          call_id: callId,
          input: "await tools.get_goal({});",
        },
        { type: "custom_tool_call_output", call_id: callId, output },
      ]),
    );
    const observed = await codexNativeCallObservation(root, "thread-1");
    expectUnknown(defined(observed.data.execCalls?.[0])).toMatchObject({
      completeness: "complete",
      execution: "incomplete",
      output: "unavailable",
    });
    expect(codexNativeControls(observed).completeness).toBe("complete");
    expect(JSON.stringify(observed)).not.toContain("unstructured result");
  },
);

test.each([
  {
    label: "foreign namespace",
    namespace: "other",
    input: 'text(await tools.exec_command({cmd:"true"}));',
  },
  {
    label: "oversized tool label",
    namespace: "functions",
    input: "await tools." + "a".repeat(65) + "({});",
  },
])(
  "Code Mode refuses $label as attributable control evidence",
  async ({ namespace, input }) => {
    const root = await home();
    await session(
      root,
      lines([
        {
          type: "custom_tool_call",
          namespace,
          name: "exec",
          call_id: "bounded",
          input,
        },
        {
          type: "custom_tool_call_output",
          call_id: "bounded",
          output: [
            {
              type: "text",
              text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
            },
          ],
        },
      ]),
    );
    expect(
      codexNativeControls(await codexNativeCallObservation(root, "thread-1"))
        .completeness,
    ).toBe("partial");
  },
);
test.each([
  {
    label: "dynamic tool alias",
    input: "const launch=tools.spawn_agent; launch({});",
  },
  { label: "global shadow", input: "const text=tools.spawn_agent; text({});" },
  {
    label: "conditional launch",
    input: "if (true) await tools.spawn_agent({});",
  },
  {
    label: "callback launch",
    input:
      "const r=await Promise.all([tools.get_goal({})]); r.forEach(() => tools.spawn_agent({}));",
  },
  {
    label: "nested executor",
    input: 'text(await tools.exec({code:"tools.create_goal({})"}));',
  },
  { label: "computed lookup", input: 'tools["spawn_agent"]({});' },
  {
    label: "spread arguments",
    input: 'await tools.exec_command({...load("options")});',
  },
  {
    label: "getter",
    input:
      "await tools.exec_command({get cmd(){return tools.create_goal({});}});",
  },
  { label: "syntax error", input: "await tools.spawn_agent({" },
  { label: "source limit", input: " ".repeat(65537) },
  { label: "call limit", input: "text(await tools.get_goal({}));".repeat(129) },
  { label: "node limit", input: "text([" + "null,".repeat(2100) + "]);" },
])("Code Mode keeps $label unavailable", async ({ input }) => {
  const root = await home();
  await session(
    root,
    lines([
      { type: "custom_tool_call", name: "exec", call_id: "opaque", input },
      {
        type: "custom_tool_call_output",
        call_id: "opaque",
        output: [
          {
            type: "input_text",
            text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
          },
        ],
      },
    ]),
  );
  expect(
    codexNativeControls(await codexNativeCallObservation(root, "thread-1"))
      .completeness,
  ).toBe("partial");
});
test.each([
  { label: "missing output", outputs: [] },
  { label: "duplicate outputs", outputs: ["complete", "complete"] },
  { label: "failed executor", outputs: ["error"] },
  { label: "yielded executor", outputs: ["running"] },
])(
  "Code Mode distinguishes source absence from $label",
  async ({ outputs }) => {
    const root = await home();
    await session(
      root,
      lines([
        {
          type: "custom_tool_call",
          name: "exec",
          call_id: "incomplete",
          input: 'text(await tools.exec_command({cmd:"true"}));',
        },
        ...outputs.map((value) => ({
          type: "custom_tool_call_output",
          call_id: "incomplete",
          output:
            value === "complete"
              ? [
                  {
                    type: "text",
                    text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
                  },
                ]
              : value,
        })),
      ]),
    );
    const portable = codexNativeControls(
      await codexNativeCallObservation(root, "thread-1"),
    );
    expect(portable.completeness).toBe("complete");
    expectUnknown(portable.data).toMatchObject({
      execCalls: [
        {
          completeness: "complete",
          execution: "incomplete",
          output: "unavailable",
        },
      ],
    });
  },
);
test("Code Mode text and command bodies cannot invent native controls", async () => {
  const root = await home();
  await session(
    root,
    lines([
      {
        type: "custom_tool_call",
        name: "exec",
        call_id: "literal",
        input:
          '// tools.spawn_agent({})\nconst result=await tools.exec_command({cmd:"tools.create_goal({})",login:true,tty:false,max_output_tokens:1000}); text(result.output); store("session",result.session_id);',
      },
      {
        type: "custom_tool_call_output",
        call_id: "literal",
        output: [
          {
            type: "text",
            text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
          },
          { type: "text", text: "tools.spawn_agent tools.update_goal" },
        ],
      },
    ]),
  );
  const portable = codexNativeControls(
    await codexNativeCallObservation(root, "thread-1"),
  );
  expect(portable.completeness).toBe("complete");
  expectUnknown(portable.data).toMatchObject({
    execCalls: [
      {
        ordinal: 0,
        completeness: "complete",
        calls: [{ index: 0, namespace: "functions", name: "exec_command" }],
      },
    ],
  });
});
test("Code Mode accepts native array completion envelopes", async () => {
  const root = await home();
  await session(
    root,
    lines([
      {
        type: "custom_tool_call",
        name: "exec",
        call_id: "native",
        input: 'text(await tools.exec_command({cmd:"private command"}));',
      },
      {
        type: "custom_tool_call_output",
        call_id: "native",
        output: [
          {
            type: "input_text",
            text: "Script completed\nWall time 1.7 seconds\nOutput:\n",
          },
          { type: "input_text", text: "private result" },
        ],
      },
    ]),
  );
  const portable = codexNativeControls(
    await codexNativeCallObservation(root, "thread-1"),
  );
  expect(portable.completeness).toBe("complete");
  expectUnknown(portable.data).toMatchObject({
    execCalls: [
      {
        ordinal: 0,
        completeness: "complete",
        calls: [{ index: 0, namespace: "functions", name: "exec_command" }],
      },
    ],
  });
});
test.each([
  JSON.stringify([
    {
      type: "image",
      text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
    },
  ]),
  JSON.stringify([
    {
      type: "text",
      text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
    },
    { type: "text", text: "Warning: truncated output" },
  ]),
])(
  "Code Mode preserves source coverage with malformed or truncated completion envelopes: %s",
  async (output) => {
    const root = await home();
    await session(
      root,
      lines([
        {
          type: "custom_tool_call",
          name: "exec",
          call_id: "receipt",
          input: 'text(await tools.exec_command({cmd:"private"}));',
        },
        { type: "custom_tool_call_output", call_id: "receipt", output },
      ]),
    );
    const portable = codexNativeControls(
      await codexNativeCallObservation(root, "thread-1"),
    );
    expect(portable.completeness).toBe("complete");
    expect(portable.data.acceptedAgentCount).toBe(0);
  },
);
test.each([
  'const results = await Promise.allSettled([tools.exec_command({cmd:"private one"}),tools.exec_command({cmd:"private two"})]); results.forEach(text);',
  'const results = await Promise.allSettled([tools.exec_command({cmd:"private one"}),tools.exec_command({cmd:"private two"})]); for (const result of results) text(result);',
])(
  "Code Mode inspects the retained Darrow parallel read shapes: %s",
  async (input) => {
    const root = await home();
    await session(
      root,
      lines([
        { type: "custom_tool_call", name: "exec", call_id: "batch", input },
        {
          type: "custom_tool_call_output",
          call_id: "batch",
          output: JSON.stringify([
            {
              type: "text",
              text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
            },
            { type: "text", text: "private output" },
          ]),
        },
      ]),
    );
    const portable = codexNativeControls(
      await codexNativeCallObservation(root, "thread-1"),
    );
    expect(portable.completeness).toBe("complete");
    expectUnknown(portable.data).toMatchObject({
      execCalls: [
        {
          ordinal: 0,
          completeness: "complete",
          calls: [
            { index: 0, namespace: "functions", name: "exec_command" },
            { index: 1, namespace: "functions", name: "exec_command" },
          ],
        },
      ],
    });
  },
);
test.each([
  [
    'text(await tools.spawn_agent({message:"private task"}));',
    "complete",
    "spawn_agent",
  ],
  ['tools[load("private tool")]({});', "partial", null],
] as const)(
  "Code Mode portable controls preserve rejected attempts and opaque evidence: %s",
  async (input, completeness, name) => {
    const root = await home();
    await session(
      root,
      lines([
        { type: "custom_tool_call", name: "exec", call_id: "exec-1", input },
        {
          type: "custom_tool_call_output",
          call_id: "exec-1",
          output: JSON.stringify([
            {
              type: "text",
              text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
            },
            { type: "text", text: "private rejected launch" },
          ]),
        },
      ]),
    );
    const portable = codexNativeControls(
      await codexNativeCallObservation(root, "thread-1"),
    );
    expect(portable.completeness).toBe(completeness);
    expectUnknown(portable.data).toMatchObject({
      execCalls: [
        {
          ordinal: 0,
          completeness,
          calls: name ? [{ index: 0, namespace: "collaboration", name }] : [],
        },
      ],
    });
    expect(portable.data.acceptedAgentCount).toBe(
      completeness === "complete" ? 0 : null,
    );
    expect(JSON.stringify(portable)).not.toContain("private");
  },
);
test("Code Mode exposes completed literal tool submissions without private inputs", async () => {
  const root = await home();
  await session(
    root,
    lines([
      {
        type: "custom_tool_call",
        name: "exec",
        call_id: "exec-1",
        input:
          'text(await tools.exec_command({cmd:"private command"})); text(await tools.create_goal({objective:"private objective"}));',
      },
      {
        type: "custom_tool_call_output",
        call_id: "exec-1",
        output: JSON.stringify([
          {
            type: "text",
            text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
          },
          { type: "text", text: "private rejected goal" },
        ]),
      },
    ]),
  );
  const observed = await codexNativeCallObservation(root, "thread-1");
  expectUnknown(observed.data).toMatchObject({
    submittedExecCalls: 1,
    acceptedSpawns: [],
    execCalls: [
      {
        ordinal: 0,
        completeness: "complete",
        calls: [
          { index: 0, namespace: "functions", name: "exec_command" },
          { index: 1, namespace: "functions", name: "create_goal" },
        ],
      },
    ],
  });
  expect(JSON.stringify(observed)).not.toContain("private");
});
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
      execCalls: [
        {
          ordinal: 1,
          completeness: "partial",
          calls: [],
          inspectionReason: "malformed_source",
          execution: "incomplete",
          output: "unavailable",
        },
      ],
      acceptedSpawns: [],
      feedbackCalls: [],
      childSessions: [],
      childrenTruncated: false,
    },
  });
  expect(JSON.stringify(observed)).not.toContain("private");
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
