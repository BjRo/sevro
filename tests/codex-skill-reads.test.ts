import { expectUnknown } from "./fixtures/assertions";
import { defined } from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexNativeReadDiagnostic,
  codexSkillReadObservation,
} from "../src/hosts/codex-skill-reads";
const roots: string[] = [];
const body =
  "---\nname: example\ndescription: Example skill\n---\n\nDo the task.\n";
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "sevro-skill-read-"));
  roots.push(workspace);
  const skillDir = join(workspace, ".agents", "skills", "example");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), body);
  return workspace;
}
function stream(items: object[]) {
  return [
    { type: "thread.started", thread_id: "thread-1" },
    ...items,
    { type: "turn.completed" },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
}
function read(command: string, output = body) {
  return {
    type: "item.completed",
    item: {
      id: "read-1",
      type: "command_execution",
      command,
      aggregated_output: output,
      exit_code: 0,
      status: "completed",
    },
  };
}
test("completed direct Codex reads produce bounded ordered skill evidence", async () => {
  const workspace = await fixture();
  const path = join(workspace, ".agents/skills/example/SKILL.md");
  const observed = await codexSkillReadObservation(
    stream([read(`cat ${path}`), read(`cat ${path}`)]),
    workspace,
  );
  expectUnknown(observed).toEqual({
    id: "sevro.codex.skill-reads",
    completeness: "complete",
    data: {
      method: "skill_file_read_probe",
      primarySkill: "example",
      observedSkills: ["example"],
    },
  });
  expect(JSON.stringify(observed)).not.toContain("Do the task.");
  const wrapped = await codexSkillReadObservation(
    stream([read(`/bin/zsh -lc 'cat .agents/skills/example/SKILL.md'`)]),
    workspace,
  );
  expect(wrapped.completeness).toBe("complete");
  expect(wrapped.data.primarySkill).toBe("example");
  const compressedShell = await codexSkillReadObservation(
    stream([read("lean-ctx -c 'cat .agents/skills/example/SKILL.md'")]),
    workspace,
  );
  expect(compressedShell.data.primarySkill).toBe("example");
  const missingBody = await codexSkillReadObservation(
    stream([
      read("lean-ctx -c 'cat .agents/skills/example/SKILL.md'", "summarized"),
    ]),
    workspace,
  );
  expect(missingBody.completeness).toBe("partial");
});
test.each([
  { command: "cat README.md .agents/skills/example/SKILL.md", complete: true },
  {
    command: 'cat -- ".agents/skills/example/SKILL.md" README.md',
    complete: true,
  },
  {
    command:
      "cat .agents/skills/example/SKILL.md .agents/skills/other/SKILL.md",
    complete: false,
  },
  {
    command:
      "cat .agents/skills/example/SKILL.md " +
      Array(64).fill("README.md").join(" "),
    complete: false,
  },
])(
  "batched literal read $command preserves conservative completeness",
  async ({ command, complete }) => {
    const workspace = await fixture();
    await writeFile(join(workspace, "README.md"), "Repository documentation\n");
    const observed = await codexSkillReadObservation(
      stream([read(command, "Repository documentation\n" + body)]),
      workspace,
    );
    expect(observed.completeness).toBe(complete ? "complete" : "partial");
    expect(observed.data.observedSkills).toEqual(complete ? ["example"] : []);
  },
);

test("exact sed pages establish a mounted body only after complete coverage", async () => {
  const workspace = await fixture();
  const lines = defined(body.match(/[^\n]*\n|[^\n]+$/g));
  const first = read(
    "sed -n '1,3p' .agents/skills/example/SKILL.md",
    lines.slice(0, 3).join(""),
  );
  const second = read(
    "sed -n '4,20p' .agents/skills/example/SKILL.md",
    lines.slice(3).join(""),
  );
  const partial = await codexSkillReadObservation(stream([first]), workspace);
  expect(partial).toMatchObject({
    completeness: "partial",
    data: { observedSkills: [] },
  });
  const complete = await codexSkillReadObservation(
    stream([first, second]),
    workspace,
  );
  expect(complete).toMatchObject({
    completeness: "complete",
    data: { primarySkill: "example", observedSkills: ["example"] },
  });
  const altered = await codexSkillReadObservation(
    stream([
      first,
      read(
        "sed -n '4,20p' .agents/skills/example/SKILL.md",
        "different output",
      ),
    ]),
    workspace,
  );
  expect(altered.completeness).toBe("partial");
});
test("incomplete, indirect, and escaping reads cannot establish selection", async () => {
  const workspace = await fixture();
  const path = join(workspace, ".agents/skills/example/SKILL.md");
  const partial = await codexSkillReadObservation(
    stream([read(`cat ${path}`, body.slice(0, 20))]),
    workspace,
  );
  expect(partial).toMatchObject({
    completeness: "partial",
    data: { observedSkills: [] },
  });
  const indirect = await codexSkillReadObservation(
    stream([read(`printf 'SKILL.md'`, body)]),
    workspace,
  );
  expect(indirect.completeness).toBe("partial");
  const outside = await mkdtemp(join(tmpdir(), "sevro-skill-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "SKILL.md"), body);
  await mkdir(join(workspace, ".agents/skills/escape"));
  await symlink(
    join(outside, "SKILL.md"),
    join(workspace, ".agents/skills/escape/SKILL.md"),
  );
  const escaped = await codexSkillReadObservation(
    stream([read("cat .agents/skills/escape/SKILL.md")]),
    workspace,
  );
  expect(escaped.completeness).toBe("partial");
  const missingCompletion = await codexSkillReadObservation(
    stream([
      {
        type: "item.started",
        item: {
          id: "read-1",
          type: "command_execution",
          command: `cat ${path}`,
        },
      },
    ]),
    workspace,
  );
  expect(missingCompletion.completeness).toBe("partial");
});
test("a completed turn with no mounted skill read records an empty observation", async () => {
  const workspace = await fixture();
  expect(await codexSkillReadObservation(stream([]), workspace)).toMatchObject({
    completeness: "complete",
    data: { primarySkill: null, observedSkills: [] },
  });
});
test("installed plugin reads count only from receipt-bound roots", async () => {
  const workspace = await fixture();
  const installed = await mkdtemp(join(tmpdir(), "sevro-installed-plugin-"));
  roots.push(installed);
  const skill = join(installed, "skills", "example");
  await mkdir(skill, { recursive: true });
  const path = join(skill, "SKILL.md");
  await writeFile(path, body);
  const events = stream([read(`cat ${path}`)]);
  expect(
    (await codexSkillReadObservation(events, workspace)).completeness,
  ).toBe("partial");
  expectUnknown(
    await codexSkillReadObservation(events, workspace, [installed]),
  ).toEqual({
    id: "sevro.codex.skill-reads",
    completeness: "complete",
    data: {
      method: "skill_file_read_probe",
      primarySkill: "example",
      observedSkills: ["example"],
    },
  });
});

test.each([
  ["missing command", { command: null }],
  [
    "array command in exec JSON",
    { command: ["cat", ".agents/skills/example/SKILL.md"] },
  ],
  ["failed command", { status: "failed" }],
  ["unmeasured exit", { exit_code: null }],
] as const)(
  "Codex stream read remains partial for %s",
  async (_name, changes) => {
    const workspace = await fixture();
    const event = read("cat .agents/skills/example/SKILL.md");
    const observed = await codexSkillReadObservation(
      stream([{ ...event, item: { ...event.item, ...changes } }]),
      workspace,
    );
    expect(observed).toMatchObject({
      completeness: "partial",
      data: { primarySkill: null, observedSkills: [] },
    });
    expect(JSON.stringify(observed)).not.toContain(body);
  },
);

test("Codex stream distinguishes unrelated commands and updates from completed mounted reads", async () => {
  const workspace = await fixture();
  const unrelated = read("printf ready", "ready");
  const update = {
    ...read("cat .agents/skills/example/SKILL.md"),
    type: "item.updated",
  };
  const started = {
    ...unrelated,
    type: "item.started",
    item: { ...unrelated.item, id: null },
  };
  expect(
    await codexSkillReadObservation(
      stream([unrelated, update, started]),
      workspace,
    ),
  ).toMatchObject({
    completeness: "complete",
    data: { primarySkill: null, observedSkills: [] },
  });
  const completed = read("cat .agents/skills/example/SKILL.md");
  const pending = { ...completed, type: "item.started" };
  expect(
    await codexSkillReadObservation(stream([pending, completed]), workspace),
  ).toMatchObject({
    completeness: "complete",
    data: { primarySkill: "example" },
  });
  const unboundStart = { ...pending, item: { ...pending.item, id: null } };
  expect(
    (await codexSkillReadObservation(stream([unboundStart]), workspace))
      .completeness,
  ).toBe("partial");
  const withoutId = { ...completed, item: { ...completed.item, id: null } };
  expect(
    (await codexSkillReadObservation(stream([withoutId]), workspace))
      .completeness,
  ).toBe("complete");
});

test.each([{ value: null }, { value: [] }])(
  "Codex stream refuses nonobject serialized events: %s",
  async ({ value }) => {
    const workspace = await fixture();
    expect(
      codexSkillReadObservation(JSON.stringify(value), workspace),
    ).rejects.toThrow("Invalid Codex skill-read event");
  },
);

test("native argv and receipt-bound plugin roots verify exact file bytes", async () => {
  const workspace = await fixture();
  const installed = await mkdtemp(join(tmpdir(), "sevro-native-plugin-"));
  roots.push(installed);
  const directory = join(installed, "skills", "example");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  await writeFile(path, body);
  const entries = [
    {
      ordinal: 0,
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          command: ["printf", "ready"],
          status: "completed",
          exit_code: 0,
          aggregated_output: "ready",
        },
      },
    },
    {
      ordinal: 1,
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          command: ["cat", path],
          status: "completed",
          exit_code: 0,
          aggregated_output: body,
        },
      },
    },
  ];
  expect(
    (await codexNativeReadDiagnostic(entries, workspace)).completeness,
  ).toBe("partial");
  const observed = await codexNativeReadDiagnostic(entries, workspace, [
    installed,
  ]);
  expect(observed).toMatchObject({
    completeness: "complete",
    commandExecutions: 2,
    readAttempts: 1,
    completedReads: [{ skill: "example", ordinal: 1 }],
  });
  expect(JSON.stringify(observed)).not.toContain(body);
  expect(JSON.stringify(observed)).not.toContain(path);
});

test("native sed receipts accumulate one whole mounted read across pages", async () => {
  const workspace = await fixture();
  const bodyLines = defined(body.match(/[^\n]*\n|[^\n]+$/g));
  const entries = [
    {
      ordinal: 0,
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          command: [
            "/bin/sh",
            "-c",
            "sed -n '1,3p' .agents/skills/example/SKILL.md",
          ],
          status: "completed",
          exit_code: 0,
          aggregated_output: bodyLines.slice(0, 3).join(""),
        },
      },
    },
    {
      ordinal: 1,
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          command: [
            "/bin/sh",
            "-c",
            "sed -n '4,20p' .agents/skills/example/SKILL.md",
          ],
          status: "completed",
          exit_code: 0,
          aggregated_output: bodyLines.slice(3).join(""),
        },
      },
    },
  ];
  expect(
    (await codexNativeReadDiagnostic(entries.slice(0, 1), workspace))
      .completeness,
  ).toBe("partial");
  expect(await codexNativeReadDiagnostic(entries, workspace)).toMatchObject({
    completeness: "complete",
    readAttempts: 2,
    completedReads: [{ skill: "example", ordinal: 1 }],
  });
});

test("a directory at a mounted skill path cannot establish a file read", async () => {
  const workspace = await fixture();
  const path = join(workspace, ".agents/skills/example/SKILL.md");
  await rm(path);
  await mkdir(path);
  expect(
    await codexSkillReadObservation(stream([read(`cat ${path}`)]), workspace),
  ).toMatchObject({ completeness: "partial", data: { observedSkills: [] } });
});
