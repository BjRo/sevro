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
test("harmless SKILL.md mentions do not downgrade completed observations", async () => {
  const workspace = await fixture();
  const missing = read(
    "cat .agents/skills/missing/SKILL.md",
    "cat: no such file\n",
  );
  const listing = read(
    "rg --files -g SKILL.md",
    ".agents/skills/example/SKILL.md\n",
  );
  for (const items of [
    [missing],
    [listing],
    [read("cat .agents/skills/example/SKILL.md"), missing],
    [read("cat .agents/skills/example/SKILL.md"), listing],
  ]) {
    const observed = await codexSkillReadObservation(stream(items), workspace);
    expect(observed).toMatchObject({
      completeness: "complete",
      data: { observedSkills: items.length > 1 ? ["example"] : [] },
    });
  }
});

test("leaked skill frontmatter keeps unrecognized and failed reads partial", async () => {
  const workspace = await fixture();
  const leak = "---\nname: example\ndescription: Example skill\n---\n";
  for (const item of [
    read("printf 'SKILL.md'", leak),
    read("printf 'name: example'", "name: example\n"),
    {
      ...read("cat .agents/skills/example/SKILL.md /missing/SKILL.md", body),
      item: {
        ...read("cat .agents/skills/example/SKILL.md /missing/SKILL.md").item,
        exit_code: 1,
        status: "failed",
      },
    },
  ]) {
    const observed = await codexSkillReadObservation(stream([item]), workspace);
    expect(observed.completeness).toBe("partial");
    expect(observed.data.observedSkills).toEqual([]);
  }
});

test("unrelated frontmatter without a mounted skill identity stays complete", async () => {
  const workspace = await fixture();
  const observed = await codexSkillReadObservation(
    stream([
      read(
        "cat docs/SKILL.md",
        "---\nname: unrelated-doc\ndescription: Notes\n---\n",
      ),
    ]),
    workspace,
  );
  expect(observed).toMatchObject({
    completeness: "complete",
    data: { primarySkill: null, observedSkills: [] },
  });
});

test("ambiguous commands that actually read mounted skills remain partial", async () => {
  const workspace = await fixture();
  const command =
    "cat .agents/skills/example/SKILL.md .agents/skills/example/SKILL.md";
  const observed = await codexSkillReadObservation(
    stream([read(command, "cat: invalid invocation\n")]),
    workspace,
  );
  expect(observed.completeness).toBe("partial");
  expect(observed.data.observedSkills).toEqual([]);
});
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
  const mismatchedCompletion = {
    ...completed,
    item: {
      ...completed.item,
      command: "printf ready",
      aggregated_output: "ready",
    },
  };
  expect(
    await codexSkillReadObservation(
      stream([pending, mismatchedCompletion]),
      workspace,
    ),
  ).toMatchObject({
    completeness: "partial",
    data: { primarySkill: null, observedSkills: [] },
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

test("native diagnostics ignore harmless mentions but retain leaked frontmatter", async () => {
  const workspace = await fixture();
  const entry = (
    ordinal: number,
    command: string,
    output: string,
    status = "completed",
    exit_code: number | null = 0,
  ) => ({
    ordinal,
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        command: ["/bin/sh", "-c", command],
        cwd: workspace,
        status,
        exit_code,
        aggregated_output: output,
      },
    },
  });
  const harmless = [
    entry(0, "cat .agents/skills/missing/SKILL.md", "No such file\n"),
    entry(1, "rg --files -g SKILL.md", ".agents/skills/example/SKILL.md\n"),
  ];
  expect(
    (await codexNativeReadDiagnostic(harmless, workspace)).completeness,
  ).toBe("complete");
  for (const ignored of harmless) {
    const afterRead = [
      entry(0, "cat .agents/skills/example/SKILL.md", body),
      { ...ignored, ordinal: 1 },
    ];
    expect(await codexNativeReadDiagnostic(afterRead, workspace)).toMatchObject(
      {
        completeness: "complete",
        observedSkills: ["example"],
        readAttempts: 1,
      },
    );
  }
  for (const suspect of [
    entry(0, "printf SKILL.md", body),
    entry(
      0,
      "cat .agents/skills/example/SKILL.md /missing/SKILL.md",
      body,
      "failed",
      1,
    ),
  ]) {
    expect(await codexNativeReadDiagnostic([suspect], workspace)).toMatchObject(
      { completeness: "partial", observedSkills: [] },
    );
  }
});

test("native diagnostics ignore absent receipt-bound skill targets", async () => {
  const workspace = await fixture();
  const installed = await mkdtemp(join(tmpdir(), "sevro-installed-read-"));
  roots.push(installed);
  const skillDirectory = join(installed, "skills", "example");
  await mkdir(skillDirectory, { recursive: true });
  const command = `cat ${join(skillDirectory, "SKILL.md")}`;
  const failed = {
    ordinal: 0,
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        command: ["/bin/sh", "-c", command],
        cwd: workspace,
        status: "failed",
        exit_code: 1,
        aggregated_output: "cat: no such file\n",
      },
    },
  };
  expect(
    await codexNativeReadDiagnostic([failed], workspace, [installed]),
  ).toMatchObject({
    completeness: "complete",
    observedSkills: [],
    completedReads: [],
    readAttempts: 0,
  });
  expect(await codexNativeReadDiagnostic([failed], workspace)).toMatchObject({
    completeness: "complete",
    observedSkills: [],
    readAttempts: 0,
  });

  await mkdir(join(workspace, "docs"), { recursive: true });
  for (const item of [
    {
      ...failed,
      payload: {
        ...failed.payload,
        item: {
          ...failed.payload.item,
          command: ["/bin/sh", "-c", "sed -n '1,2p' docs/README.md"],
          status: "completed",
          exit_code: 0,
          aggregated_output: "ordinary documentation text\n",
        },
      },
    },
    {
      ...failed,
      payload: {
        ...failed.payload,
        item: {
          ...failed.payload.item,
          command: ["/bin/sh", "-c", "cat docs/SKILL.md"],
          status: "failed",
          exit_code: 1,
        },
      },
    },
  ]) {
    expect(await codexNativeReadDiagnostic([item], workspace)).toMatchObject({
      completeness: "complete",
      observedSkills: [],
      readAttempts: 0,
      truncated: false,
    });
  }
});

async function assertMissingSkillReadComplete(
  path: string,
  workspace: string,
  pluginRoots: string[],
): Promise<void> {
  const command = `cat ${path}`;
  const native = {
    ordinal: 0,
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        command: ["/bin/sh", "-c", command],
        cwd: workspace,
        status: "failed",
        exit_code: 1,
        aggregated_output: "cat: no such file\n",
      },
    },
  };
  expect(
    await codexNativeReadDiagnostic([native], workspace, pluginRoots),
  ).toMatchObject({
    completeness: "complete",
    observedSkills: [],
    completedReads: [],
    readAttempts: 0,
    truncated: false,
  });
  const item = read(command, "cat: no such file\n");
  const failed = {
    ...item,
    item: { ...item.item, status: "failed", exit_code: 1 },
  };
  expect(
    await codexSkillReadObservation(stream([failed]), workspace, pluginRoots),
  ).toMatchObject({
    completeness: "complete",
    data: { primarySkill: null, observedSkills: [] },
  });
}

test("missing mounted and installed skill targets are empty", async () => {
  const workspace = await fixture();
  const installed = await mkdtemp(join(tmpdir(), "sevro-installed-missing-"));
  roots.push(installed);
  const repositoryTarget = join(
    workspace,
    ".agents",
    "skills",
    "example",
    "SKILL.md",
  );
  await rm(repositoryTarget);
  const installedDirectory = join(installed, "skills", "example");
  await mkdir(installedDirectory, { recursive: true });
  await assertMissingSkillReadComplete(repositoryTarget, workspace, []);
  await assertMissingSkillReadComplete(
    join(installedDirectory, "SKILL.md"),
    workspace,
    [installed],
  );
});

test("existing mounted reads that fail remain partial", async () => {
  const readableWorkspace = await fixture();
  const existingTarget = join(
    readableWorkspace,
    ".agents",
    "skills",
    "example",
    "SKILL.md",
  );
  const command = `cat ${existingTarget}`;
  const failed = read(command, "cat: permission denied\n");
  failed.item.status = "failed";
  failed.item.exit_code = 1;
  expect(
    await codexSkillReadObservation(stream([failed]), readableWorkspace),
  ).toMatchObject({
    completeness: "partial",
    data: { observedSkills: [] },
  });
  expect(
    await codexNativeReadDiagnostic(
      [
        {
          ordinal: 0,
          payload: {
            type: "item_completed",
            item: {
              type: "CommandExecution",
              command: ["/bin/sh", "-c", command],
              cwd: readableWorkspace,
              status: "failed",
              exit_code: 1,
              aggregated_output: "cat: permission denied\n",
            },
          },
        },
      ],
      readableWorkspace,
    ),
  ).toMatchObject({ completeness: "partial", readAttempts: 1 });
});

test("mounted frontmatter leaks remain partial when the body is unavailable", async () => {
  const workspace = await fixture();
  await rm(join(workspace, ".agents", "skills", "example", "SKILL.md"));
  const command = "printf 'name: example'";
  const output = "name: example\n";
  const native = {
    ordinal: 0,
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        command: ["/bin/sh", "-c", command],
        cwd: workspace,
        status: "completed",
        exit_code: 0,
        aggregated_output: output,
      },
    },
  };
  expect(await codexNativeReadDiagnostic([native], workspace)).toMatchObject({
    completeness: "partial",
    observedSkills: [],
    completedReads: [],
    readAttempts: 1,
  });
  expect(
    await codexSkillReadObservation(stream([read(command, output)]), workspace),
  ).toMatchObject({
    completeness: "partial",
    data: { primarySkill: null, observedSkills: [] },
  });
});

test("mounted frontmatter leaks remain partial when skill bodies exceed the verification bound", async () => {
  const workspace = await fixture();
  const installed = await mkdtemp(join(tmpdir(), "sevro-installed-oversized-"));
  roots.push(installed);
  const mountedPath = join(
    workspace,
    ".agents",
    "skills",
    "example",
    "SKILL.md",
  );
  const installedPath = join(installed, "skills", "example", "SKILL.md");
  await mkdir(join(installed, "skills", "example"), { recursive: true });
  const oversizedBody = `${body}${"x".repeat(1024 * 1024)}`;
  await writeFile(mountedPath, oversizedBody);
  await writeFile(installedPath, oversizedBody);
  const command = "printf 'name: example'";
  const output = "name: example\n";
  for (const { pluginRoots } of [
    { pluginRoots: [] },
    { pluginRoots: [installed] },
  ]) {
    const native = {
      ordinal: 0,
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          command: ["/bin/sh", "-c", command],
          cwd: workspace,
          status: "completed",
          exit_code: 0,
          aggregated_output: output,
        },
      },
    };
    expect(
      await codexNativeReadDiagnostic([native], workspace, pluginRoots),
    ).toMatchObject({
      completeness: "partial",
      observedSkills: [],
      completedReads: [],
      readAttempts: 1,
    });
    expect(
      await codexSkillReadObservation(
        stream([read(command, output)]),
        workspace,
        pluginRoots,
      ),
    ).toMatchObject({
      completeness: "partial",
      data: { primarySkill: null, observedSkills: [] },
    });
  }
});

async function expectPluginFrontmatterObservation(
  workspace: string,
  pluginRoots: string[],
  completeness: "complete" | "partial",
): Promise<void> {
  const command = "printf 'name: example'";
  const output = "name: example\n";
  const native = {
    ordinal: 0,
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        command: ["/bin/sh", "-c", command],
        cwd: workspace,
        status: "completed",
        exit_code: 0,
        aggregated_output: output,
      },
    },
  };
  expect(
    await codexNativeReadDiagnostic([native], workspace, pluginRoots),
  ).toMatchObject({
    completeness,
    observedSkills: [],
    completedReads: [],
    readAttempts: completeness === "partial" ? 1 : 0,
    truncated: false,
  });
  expect(
    await codexSkillReadObservation(
      stream([read(command, output)]),
      workspace,
      pluginRoots,
    ),
  ).toMatchObject({
    completeness,
    data: { primarySkill: null, observedSkills: [] },
  });
}

test("installed skill frontmatter evidence requires its bound plugin root", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "sevro-unmounted-workspace-"));
  roots.push(workspace);
  const installed = await mkdtemp(
    join(tmpdir(), "sevro-receipt-bound-plugin-"),
  );
  roots.push(installed);
  const skillDirectory = join(installed, "skills", "example");
  await mkdir(skillDirectory, { recursive: true });

  await expectPluginFrontmatterObservation(workspace, [installed], "partial");
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    `${body}${"x".repeat(1024 * 1024)}`,
  );
  await expectPluginFrontmatterObservation(workspace, [installed], "partial");
  await expectPluginFrontmatterObservation(workspace, [], "complete");
});

test("native malformed commands retain mounted frontmatter evidence within caps", async () => {
  const workspace = await fixture();
  const entry = (ordinal: number, output = "name: example\n") => ({
    ordinal,
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        command: null,
        cwd: workspace,
        status: "completed",
        exit_code: 0,
        aggregated_output: output,
      },
    },
  });
  const observed = await codexNativeReadDiagnostic([entry(0)], workspace);
  expect(observed).toMatchObject({
    completeness: "partial",
    observedSkills: [],
    completedReads: [],
    recoverySources: [{ ordinal: 0, nativeOutput: true }],
    commandExecutions: 1,
    readAttempts: 1,
    truncated: false,
  });
  expect(
    await codexNativeReadDiagnostic([entry(0, "SKILL.md\n")], workspace),
  ).toMatchObject({
    completeness: "complete",
    observedSkills: [],
    readAttempts: 0,
    truncated: false,
  });

  const capped = await codexNativeReadDiagnostic(
    Array.from({ length: 65 }, (_, ordinal) => entry(ordinal)),
    workspace,
  );
  expect(capped).toMatchObject({
    completeness: "partial",
    commandExecutions: 65,
    readAttempts: 64,
    truncated: true,
  });
  expect(capped.recoverySources).toHaveLength(64);
  expect(JSON.stringify(capped)).not.toContain(body);
  expect(JSON.stringify(capped)).not.toContain(workspace);
});

test("sed pages beyond a mounted skill body remain partial without a receipt", async () => {
  const workspace = await fixture();
  const command = "sed -n '99,100p' .agents/skills/example/SKILL.md";
  const streamResult = await codexSkillReadObservation(
    stream([read(command, "")]),
    workspace,
  );
  expect(streamResult).toMatchObject({
    completeness: "partial",
    data: { primarySkill: null, observedSkills: [] },
  });
  const nativeResult = await codexNativeReadDiagnostic(
    [
      {
        ordinal: 0,
        payload: {
          type: "item_completed",
          item: {
            type: "CommandExecution",
            command: ["/bin/sh", "-c", command],
            cwd: workspace,
            status: "completed",
            exit_code: 0,
            aggregated_output: "",
          },
        },
      },
    ],
    workspace,
  );
  expect(nativeResult).toMatchObject({
    completeness: "partial",
    observedSkills: [],
    completedReads: [],
    readAttempts: 1,
  });
});

test("mounted identity after unrelated frontmatter remains partial", async () => {
  const workspace = await fixture();
  const unrelated = Array.from(
    { length: 64 },
    (_, index) => `name: unrelated-${index}\n`,
  ).join("");
  const output = `${unrelated}name: example\n`;
  const observed = await codexSkillReadObservation(
    stream([read("printf ready", output)]),
    workspace,
  );
  expect(observed).toMatchObject({
    completeness: "partial",
    data: { primarySkill: null, observedSkills: [] },
  });

  const entry = {
    ordinal: 0,
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        command: ["printf", "ready"],
        cwd: workspace,
        status: "completed",
        exit_code: 0,
        aggregated_output: output,
      },
    },
  };
  expect(await codexNativeReadDiagnostic([entry], workspace)).toMatchObject({
    completeness: "partial",
    observedSkills: [],
    readAttempts: 1,
    truncated: false,
  });

  const unrelatedOnly = `${unrelated}name: unrelated-final\n`;
  expect(
    await codexSkillReadObservation(
      stream([read("printf ready", unrelatedOnly)]),
      workspace,
    ),
  ).toMatchObject({ completeness: "complete", data: { observedSkills: [] } });
  expect(
    await codexNativeReadDiagnostic(
      [
        {
          ...entry,
          payload: {
            ...entry.payload,
            item: { ...entry.payload.item, aggregated_output: unrelatedOnly },
          },
        },
      ],
      workspace,
    ),
  ).toMatchObject({
    completeness: "complete",
    observedSkills: [],
    readAttempts: 0,
  });
});

test("mounted operands after unresolved skill paths remain partial", async () => {
  const workspace = await fixture();
  const unresolved = Array.from(
    { length: 64 },
    (_, index) => `.agents/skills/missing-${index}/SKILL.md`,
  );
  const command = `cat ${[...unresolved, ".agents/skills/example/SKILL.md"].join(" ")}`;
  const failedRead = {
    ...read(command, "cat: one or more files could not be read\n"),
    item: {
      ...read(command).item,
      exit_code: 1,
      status: "failed",
    },
  };
  expect(
    await codexSkillReadObservation(stream([failedRead]), workspace),
  ).toMatchObject({ completeness: "partial", data: { observedSkills: [] } });

  const native = {
    ordinal: 0,
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        command: ["/bin/sh", "-c", command],
        cwd: workspace,
        status: "failed",
        exit_code: 1,
        aggregated_output: "cat: one or more files could not be read\n",
      },
    },
  };
  expect(await codexNativeReadDiagnostic([native], workspace)).toMatchObject({
    completeness: "partial",
    observedSkills: [],
    readAttempts: 1,
  });

  const unresolvedOnly = `cat ${unresolved.join(" ")}`;
  expect(
    await codexSkillReadObservation(
      stream([read(unresolvedOnly, "cat: no such files\n")]),
      workspace,
    ),
  ).toMatchObject({ completeness: "complete", data: { observedSkills: [] } });
  expect(
    await codexNativeReadDiagnostic(
      [
        {
          ...native,
          payload: {
            ...native.payload,
            item: {
              ...native.payload.item,
              command: ["/bin/sh", "-c", unresolvedOnly],
              status: "completed",
              exit_code: 1,
            },
          },
        },
      ],
      workspace,
    ),
  ).toMatchObject({
    completeness: "complete",
    observedSkills: [],
    readAttempts: 0,
  });
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
