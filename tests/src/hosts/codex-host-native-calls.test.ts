import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexHost } from "../../../src/hosts/codex";
import { expectUnknown, objectContaining } from "../../fixtures/assertions";
import {
  fixture,
  isolatedNativeHost,
  ordinaryCodexRequest,
} from "../../fixtures/codex-host";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test.each([
  {
    name: "serialized read",
    input:
      'const r=await tools.exec_command({cmd:"private read"});text(JSON.stringify(r));',
    completeness: "complete",
  },
  {
    name: "truncated read",
    input:
      'const r=await tools.exec_command({cmd:"private read"});text(r.output);',
    completeness: "complete",
  },
  {
    name: "read",
    input: 'text(await tools.exec_command({cmd:"private read"}));',
    completeness: "complete",
  },
  {
    name: "rejected launch",
    input: 'text(await tools.spawn_agent({message:"private task"}));',
    completeness: "complete",
  },
  {
    name: "dynamic launch",
    input: 'tools[load("private tool")]({});',
    completeness: "partial",
  },
] as const)(
  "Codex host retains Code Mode $name evidence",
  async ({ name, input, completeness }) => {
    if (!isolatedNativeHost || !Bun.which("codex")) return;
    const selected = await ordinaryCodexRequest(roots);
    const entries = [
      {
        ordinal: 0,
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "submitted",
          input,
        },
      },
      {
        ordinal: 1,
        payload: {
          type: "custom_tool_call_output",
          call_id: "submitted",
          output: [
            {
              type: "input_text",
              text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
            },
            {
              type: "input_text",
              text:
                name === "truncated read"
                  ? "Warning: truncated output"
                  : "private rejected result",
            },
          ],
        },
      },
    ];
    await writeFile(
      join(selected.workspace, "compound-native.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await writeFile(
      join(selected.workspace, "compound-events.jsonl"),
      [
        { type: "thread.started", thread_id: "thread-1" },
        {
          type: "item.completed",
          item: { type: "agent_message", text: "ready" },
        },
        { type: "turn.completed" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const result = await selected.host.run(selected.request);
    expect(result.complete).toBe(true);
    expectUnknown(result.observations).toContainEqual(
      objectContaining({
        id: "sevro.host.native-controls",
        completeness,
        data: objectContaining({
          coverage: objectContaining({
            nativeCalls: "complete",
            execInspection: completeness,
          }),
          execCalls: [
            objectContaining({
              ordinal: 0,
              completeness,
              execution: "completed",
              output: name === "truncated read" ? "truncated" : "complete",
            }),
          ],
        }),
      }),
    );
    expect(JSON.stringify(result.observations)).not.toContain("private");
  },
);

test("Codex host binds bounded native calls to its completed thread", async () => {
  const installedCodex = Bun.which("codex");
  if (!isolatedNativeHost || !installedCodex) return;
  const paths = await fixture(roots);
  const workspace = await temporaryFixture(
    join(tmpdir(), "sevro-codex-native-"),
  );

  await writeFile(join(workspace, "native-calls.flag"), "\n");
  const host = createCodexHost({
    binary: paths.fakeBinary,
    sandboxBinary: installedCodex,
    authFile: paths.authFile,
    model: "synthetic-codex",
    effort: "low",
    projectRoot: paths.projectRoot,
    resultsRoot: paths.resultsRoot,
    additionalProtectedRoots: [],
  });
  const result = await host.run({
    prompt: "Return ready.",
    workspace,
    condition: "passive",
  });
  expect(host.hostCapabilities).toContain("sevro.host.native-controls");
  expectUnknown(result.observations).toContainEqual({
    id: "sevro.host.native-controls",
    completeness: "complete",
    data: {
      method: "native_control_calls",
      calls: [{ ordinal: 0, namespace: "functions", name: "create_goal" }],
      acceptedAgentCount: 0,
      directAcceptedAgentCount: 0,
      coverage: {
        nativeCalls: "complete",
        execInspection: "complete",
        acceptedAgents: "direct_native_calls",
      },
      submittedExecCalls: 0,
      truncated: false,
    },
  });
  expect(JSON.stringify(result.observations)).not.toContain(
    "private objective",
  );
});
