import { afterEach, expect, test } from "bun:test";
import { codexNativeCallObservation } from "../../../src/hosts/codex-native-calls";
import { codexNativeControls } from "../../../src/hosts/native-controls";
import { defined, expectUnknown } from "../../fixtures/assertions";
import {
  home,
  lines,
  session,
  submittedProgram,
} from "../../fixtures/codex-native-calls";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

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
    const observed = await submittedProgram(roots, input, 0);
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
    const root = await home(roots);
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
    const root = await home(roots);
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
  const root = await home(roots);
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
    const root = await home(roots);
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
  const root = await home(roots);
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
  const root = await home(roots);
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
    const root = await home(roots);
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
    const root = await home(roots);
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
    const root = await home(roots);
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
  const root = await home(roots);
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
