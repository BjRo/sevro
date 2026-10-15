import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { codexNativeSkillReadRecovery } from "../src/hosts/codex-native-calls";
import { codexSkillReadObservation } from "../src/hosts/codex-skill-reads";
import {
  mixedReadCommand,
  mixedReadOutput,
  mixedReadProgram,
  mixedReadSkill,
} from "./fixtures/codex-mixed-skill-read";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sevro-native-read-"));
  roots.push(root);
  const { workspace, sessions } = await fixtureWorkspace(root);
  const item = {
    type: "CommandExecution",
    id: "third",
    process_id: "101",
    source: "unified_exec_startup",
    command: ["/bin/zsh", "-c", mixedReadCommand],
    cwd: pathToFileURL(workspace).href,
    status: "completed",
    exit_code: 0,
    aggregated_output: mixedReadOutput,
  };
  const call = {
    type: "custom_tool_call",
    name: "exec",
    call_id: "batch",
    input: mixedReadProgram,
  };
  const entries = [
    { ordinal: 44, payload: call },
    { ordinal: 48, payload: { type: "item_completed", item } },
  ];
  const streamItem = {
    type: "command_execution",
    id: "third",
    command: mixedReadCommand,
    aggregated_output: "",
    status: "completed",
    exit_code: 0,
  };
  const extraItems: (typeof streamItem)[] = [];
  return {
    workspace,
    call,
    item,
    entries,
    streamItem,
    extraItems,
    async observe() {
      await writeFile(
        join(sessions, "rollout-thread-1.jsonl"),
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      const recovered = await codexNativeSkillReadRecovery(root, "thread-1");
      const stream = [
        { type: "thread.started", thread_id: "thread-1" },
        ...[streamItem, ...extraItems].map((item) => ({
          type: "item.completed",
          item,
        })),
        { type: "turn.completed" },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n");
      return codexSkillReadObservation(stream, workspace, [], recovered);
    },
  };
}

async function fixtureWorkspace(root: string) {
  const workspace = join(root, "workspace");
  const sessions = join(root, "sessions/2026/10/15");
  await mkdir(join(workspace, ".agents/skills/ship-proposal"), {
    recursive: true,
  });
  await mkdir(join(workspace, "nested"));
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(workspace, ".agents/skills/ship-proposal/SKILL.md"),
    mixedReadSkill,
  );
  await Promise.all(
    ["config.json", "check.sh", "NOTES.md"].map((name) =>
      writeFile(join(workspace, name), "Later ordinary contents\n"),
    ),
  );
  return { workspace, sessions };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Scenario = { label: string; mutate: (value: Fixture) => void };

test.each([
  { label: "the exact indexed batch", mutate: () => {} },
  {
    label: "a different result loop",
    mutate: (f) => {
      f.call.input = mixedReadProgram.replace(
        "for(let i=0;i<r.length;i++)text({i,...r[i]});",
        "r.forEach(text);",
      );
    },
  },
  {
    label: "dynamic submitted options",
    mutate: (f) => {
      f.call.input =
        'const result=await tools.exec_command(load("options")); text(result);';
    },
  },
  {
    label: "output also present in the stream",
    mutate: (f) => {
      f.streamItem.aggregated_output = mixedReadOutput;
    },
  },
  {
    label: "a filesystem working directory",
    mutate: (f) => {
      f.item.cwd = f.workspace;
    },
  },
] satisfies Scenario[])(
  "native Skill receipts survive $label",
  async ({ mutate }) => {
    const selected = await fixture();
    mutate(selected);
    const observed = await selected.observe();
    expect(observed).toMatchObject({
      completeness: "complete",
      data: { observedSkills: ["ship-proposal"] },
    });
    expect(JSON.stringify(observed)).not.toContain("Ship one proposal");
    expect(JSON.stringify(observed)).not.toContain(selected.workspace);
  },
);

test.each([
  {
    label: "a failed native read",
    mutate: (f) => {
      f.item.exit_code = 1;
    },
  },
  {
    label: "an unfinished native read",
    mutate: (f) => {
      f.item.status = "running";
    },
  },
  {
    label: "an incomplete Skill body",
    mutate: (f) => {
      f.item.aggregated_output = mixedReadSkill.slice(0, -10);
    },
  },
  {
    label: "a truncation marker",
    mutate: (f) => {
      f.item.aggregated_output += "Warning: truncated output";
    },
  },
  {
    label: "a nonstring output",
    mutate: (f) => {
      Object.assign(f.item, { aggregated_output: 42 });
    },
  },
  {
    label: "an ambiguous repeated body",
    mutate: (f) => {
      f.item.aggregated_output += mixedReadOutput;
    },
  },
  {
    label: "a duplicate native identity",
    mutate: (f) => {
      f.entries.push({
        ordinal: 50,
        payload: { type: "item_completed", item: { ...f.item } },
      });
    },
  },
  {
    label: "a missing native identity",
    mutate: (f) => {
      f.item.id = "";
    },
  },
  {
    label: "a different stream identity",
    mutate: (f) => {
      f.streamItem.id = "other";
    },
  },
  {
    label: "a different stream command",
    mutate: (f) => {
      f.streamItem.command = "cat README.md";
    },
  },
  {
    label: "conflicting stream output",
    mutate: (f) => {
      f.streamItem.aggregated_output = "different";
    },
  },
  {
    label: "a failed stream read",
    mutate: (f) => {
      f.streamItem.exit_code = 1;
    },
  },
  {
    label: "a different working directory",
    mutate: (f) => {
      f.item.cwd = join(f.workspace, "nested");
    },
  },
  {
    label: "a relative working directory",
    mutate: (f) => {
      f.item.cwd = "nested";
    },
  },
  {
    label: "a malformed file URL",
    mutate: (f) => {
      f.item.cwd = "file://foreign/invalid";
    },
  },
  {
    label: "a nonexistent working directory",
    mutate: (f) => {
      f.item.cwd = join(f.workspace, "missing");
    },
  },
  {
    label: "an invalid native argv",
    mutate: (f) => {
      f.item.command = ["cat", "SKILL.md"];
    },
  },
  {
    label: "a native shell flag mismatch",
    mutate: (f) => {
      f.item.command = ["/bin/zsh", "-x", mixedReadCommand];
    },
  },
  {
    label: "a copied Skill in ordinary output",
    mutate: (f) => {
      f.item.command = ["/bin/zsh", "-c", "cat README.md"];
      f.streamItem.command = "cat README.md";
    },
  },
] satisfies Scenario[])(
  "native Skill receipts refuse $label",
  async ({ mutate }) => {
    const selected = await fixture();
    mutate(selected);
    expect((await selected.observe()).data.observedSkills).toEqual([]);
  },
);

test("one complete native Skill receipt cannot complete another supporting read", async () => {
  const selected = await fixture();
  await mkdir(join(selected.workspace, ".agents/skills/pending"));
  const body = mixedReadSkill.replaceAll("ship-proposal", "pending");
  await writeFile(
    join(selected.workspace, ".agents/skills/pending/SKILL.md"),
    body,
  );
  selected.extraItems.push({
    ...selected.streamItem,
    id: "pending",
    command: "cat .agents/skills/pending/SKILL.md",
    aggregated_output: body.slice(0, -10),
  });
  expect(await selected.observe()).toMatchObject({
    completeness: "partial",
    data: { observedSkills: ["ship-proposal"] },
  });
});

test("Skill instructions about output truncation are ordinary file content", async () => {
  const selected = await fixture();
  const body =
    mixedReadSkill + "If output truncated is reported, read the file again.\n";
  await writeFile(
    join(selected.workspace, ".agents/skills/ship-proposal/SKILL.md"),
    body,
  );
  selected.item.aggregated_output =
    body + mixedReadOutput.slice(mixedReadSkill.length);
  expect((await selected.observe()).data.observedSkills).toEqual([
    "ship-proposal",
  ]);
});
