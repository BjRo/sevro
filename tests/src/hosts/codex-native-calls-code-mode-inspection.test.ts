import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { codexNativeCallObservation } from "../../../src/hosts/codex-native-calls";
import { codexNativeControls } from "../../../src/hosts/native-controls";
import { expectUnknown } from "../../fixtures/assertions";
import {
  home,
  lines,
  result,
  session,
  spawn,
  started,
  submittedProgram,
} from "../../fixtures/codex-native-calls";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

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
    const root = await home(roots);
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
  const root = await home(roots);
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
  const portable = await submittedProgram(roots, input, 0);
  expect(portable.completeness).toBe("partial");
  expect(portable.data.acceptedAgentCount).toBeNull();
});

test.each([
  'const r=await Promise.all([tools.exec_command({cmd:"pwd"})]);for(const x of r)text(x.output);',
  'const r=await Promise.allSettled([tools.exec_command({cmd:"pwd"})]);for(const x of r){if(x.status === "fulfilled")text(x.value.output);else text(String(x.reason));}',
])(
  "Code Mode inspects faithful retained batch-output shapes: %s",
  async (input) => {
    const portable = await submittedProgram(roots, input, 0);
    expect(portable.completeness).toBe("complete");
    expectUnknown(portable.data).toMatchObject({
      acceptedAgentCount: 0,
      execCalls: [{ calls: [{ name: "exec_command" }] }],
    });
  },
);

test("Code Mode keeps direct acceptance facts scoped during dynamic inspection gaps", async () => {
  const root = await home(roots);
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
  const root = await home(roots);
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
    roots,
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
    roots,
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
    roots,
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
    join(import.meta.dir, "../../fixtures/code-mode-85/direct-45.txt"),
    "utf8",
  );
  const portable = await submittedProgram(roots, input, 45);
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
      join(
        import.meta.dir,
        "../..",
        `fixtures/code-mode-85/coupled-${ordinal}.txt`,
      ),
      "utf8",
    );
    const portable = await submittedProgram(roots, input, ordinal);
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
      join(
        import.meta.dir,
        "../..",
        `fixtures/code-mode-85/direct-${ordinal}.txt`,
      ),
      "utf8",
    );
    const portable = await submittedProgram(roots, input, ordinal);
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
    roots,
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
  const portable = await submittedProgram(roots, input, 3);
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
    const portable = await submittedProgram(roots, input, 0);
    expect(portable.completeness).toBe("partial");
    expect(portable.data.acceptedAgentCount).toBeNull();
  },
);
