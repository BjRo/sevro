import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeNestedSkillsObservation } from "../../src/hosts/claude-nested-skills";
import { defined, record } from "../fixtures/assertions";
import { createWorkspace } from "../fixtures/native-host-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const workspace = createWorkspace(roots);

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
