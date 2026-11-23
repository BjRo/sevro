import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  defined,
  parseRunEvidence,
  record,
  array,
} from "../../fixtures/assertions";
import {
  createFixture,
  installLinuxCodexHelper,
  invoke,
  isolatedNativeHost,
} from "../../fixtures/cli-fixtures";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

async function controlledCodex(
  binary: string,
  installed: string,
  input: string,
) {
  const entries = [
    {
      payload: {
        type: "custom_tool_call",
        namespace: "functions",
        name: "exec",
        call_id: "catalog",
        input,
      },
    },
    {
      payload: {
        type: "custom_tool_call_output",
        call_id: "catalog",
        output: [
          {
            type: "text",
            text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
          },
        ],
      },
    },
  ];
  const native = entries
    .map((entry, ordinal) => quote(JSON.stringify({ ordinal, ...entry })))
    .join(" ");
  await installLinuxCodexHelper(binary, installed);
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$1" = --version ]; then printf 'synthetic-codex\\n'; exit 0; fi
if [ "$1" = sandbox ]; then exec ${quote(installed)} "$@"; fi
if [ "$1" != exec ]; then exit 99; fi
mkdir -p "$CODEX_HOME/sessions/2026/09/27"
printf '%s\\n' ${native} > "$CODEX_HOME/sessions/2026/09/27/rollout-thread-cli.jsonl"
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-cli"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}'
printf '%s\\n' '{"type":"turn.completed"}'
`,
    { mode: 0o700 },
  );
}

const query = `const names=ALL_TOOLS.filter(x=>/private catalog/.test(x.name+" "+x.description)).map(x=>({name:x.name,description:x.description.slice(0,200)}));text(names);`;

test.each([
  {
    name: "literal control",
    input: 'text("ready");',
    completeness: "complete",
    calls: [],
  },
  {
    name: "catalog read",
    input: "text(ALL_TOOLS);",
    completeness: "complete",
    calls: [],
  },
  { name: "catalog query", input: query, completeness: "complete", calls: [] },
  {
    name: "submitted launch",
    input: query + "await tools.spawn_agent({});",
    completeness: "complete",
    calls: [{ index: 0, namespace: "collaboration", name: "spawn_agent" }],
  },
  {
    name: "unsafe callback",
    input: "ALL_TOOLS.filter(x=>tools.spawn_agent({}));",
    completeness: "partial",
    calls: [],
  },
])(
  "CLI captures $name for no-agent consumers without model calls",
  async ({ input, completeness, calls }) => {
    const installed = Bun.which("codex");
    if (!isolatedNativeHost || !installed) return;
    const { args, caseFile } = await createFixture(roots)();
    const root = dirname(caseFile);
    const binRoot = await temporaryFixture(
      join(tmpdir(), "sevro-catalog-bin-"),
    );
    const binary = join(binRoot, "controlled-codex");
    const auth = join(root, "auth.json");
    await controlledCodex(binary, installed, input);
    await writeFile(auth, "test-only-auth\n", { mode: 0o600 });
    const command = args.filter(
      (value, index) =>
        value !== "--adapter-module" && args[index - 1] !== "--adapter-module",
    );
    const run = await invoke([
      ...command,
      "--host",
      "codex",
      "--codex-bin",
      binary,
      "--codex-auth-file",
      auth,
      "--model",
      "synthetic-codex",
      "--effort",
      "low",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const evidence = parseRunEvidence(
      await readFile(defined(run.result.evidencePath), "utf8"),
    );
    const observation = defined(
      defined(evidence.trials[0]).observations.find(
        (row) => row.id === "sevro.host.native-controls",
      ),
    );
    expect(observation.source).toBe("sevro.host.codex");
    expect(observation.completeness).toBe(completeness);
    const data = record(observation.data);
    expect(data.acceptedAgentCount).toBe(
      completeness === "complete" ? 0 : null,
    );
    expect(data.submittedExecCalls).toBe(1);
    expect(data.calls).toEqual([
      { ordinal: 0, namespace: "functions", name: "exec" },
    ]);
    expect(array(data.execCalls)).toEqual([
      {
        ordinal: 0,
        completeness,
        calls,
        inspectionReason:
          completeness === "complete" ? null : "unsupported_source",
        execution: "completed",
        output: "complete",
      },
    ]);
    expect(JSON.stringify(observation)).not.toContain("private catalog");
  },
);
