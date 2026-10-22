import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareSkillTracking,
  skillExposureClaims,
  skillTrackingObservation,
  type SkillTracking,
} from "../src/hosts/skill-hooks";
import {
  codexSkillCatalogRoots,
  skillHookCatalog,
} from "../src/hosts/skill-hook-catalog";
import {
  skillHookReceipt,
  type SkillHookConfiguration,
} from "../src/hosts/skill-hook-handler";

const roots: string[] = [];
const body =
  "---\nname: fixture\ndescription: Fixture only.\n---\n# Instructions\nRead the entire fixture.\n";
const receiptConfiguration: SkillHookConfiguration = {
  host: "codex",
  receipts: "unused-by-pure-parser",
  skills: [{ invocation: "fixture", sha256: "fixture-hash", body }],
  catalogComplete: true,
};

test("hook receipt parsing rejects invalid envelopes and incomplete tool identities", () => {
  for (const input of [null, [], {}, { hook_event_name: 42 }]) {
    expect(() => skillHookReceipt(input, receiptConfiguration)).toThrow(
      "invalid skill hook input",
    );
  }
  for (const fields of [
    { session_id: null },
    { session_id: "invalid session" },
    { tool_use_id: null },
    { tool_name: null },
  ]) {
    const receipt = skillHookReceipt(
      {
        hook_event_name: "PostToolUse",
        session_id: "session-a",
        tool_use_id: "tool-a",
        tool_name: "Bash",
        ...fields,
      },
      receiptConfiguration,
    );
    expect(receipt.partial).toBe(true);
  }
  expect(
    skillHookReceipt(
      { hook_event_name: "SessionStart", session_id: "session-a" },
      receiptConfiguration,
    ).partial,
  ).toBe(false);
});

test("hook receipts match complete bodies in nested responses and discard unrelated values", () => {
  const receipt = skillHookReceipt(
    {
      hook_event_name: "PostToolUse",
      session_id: "session-a",
      turn_id: "turn-a",
      tool_use_id: "tool-a",
      tool_name: "mcp.read",
      tool_response: [null, 42, false, { content: [body, body, "unrelated"] }],
    },
    receiptConfiguration,
  );
  expect(receipt).toEqual({
    event: "PostToolUse",
    sessionId: "session-a",
    turnId: "turn-a",
    toolUseId: "tool-a",
    toolName: "mcp.read",
    invocations: ["fixture"],
    ambiguousInvocations: [],
    partial: false,
  });
  const ignored = skillHookReceipt(
    {
      hook_event_name: "PreToolUse",
      session_id: "session-a",
      tool_response: body,
    },
    receiptConfiguration,
  );
  expect(ignored.invocations).toEqual([]);
});

test("hook receipts separate unique matches from identical skill bodies", () => {
  const configuration = {
    ...receiptConfiguration,
    skills: [
      ...receiptConfiguration.skills,
      { invocation: "other", sha256: "fixture-hash", body },
      {
        invocation: "unique",
        sha256: "unique-hash",
        body: "Unique instructions.",
      },
    ],
  };
  const receipt = skillHookReceipt(
    {
      hook_event_name: "PostToolUse",
      session_id: "session-a",
      tool_use_id: "tool-a",
      tool_name: "Bash",
      tool_response: [body, "Unique instructions."],
    },
    configuration,
  );
  expect(receipt.invocations).toEqual(["unique"]);
  expect(receipt.ambiguousInvocations).toEqual(["fixture", "other"]);
  expect(receipt.partial).toBe(true);
});

function pageReceipt(skillBody: string, output: unknown) {
  return skillHookReceipt(
    {
      hook_event_name: "PostToolUse",
      session_id: "session-a",
      turn_id: "turn-a",
      tool_use_id: "tool-a",
      tool_name: "mcp.read",
      tool_response: output,
    },
    {
      ...receiptConfiguration,
      skills: [
        { invocation: "fixture", sha256: "fixture-hash", body: skillBody },
      ],
    },
  );
}

test("page receipts map nested fragments to exact body offsets without retaining output", () => {
  const prefix = "Start here 🧭.\n\n";
  const first =
    "Read this first line completely.\nContinue with this instruction.\n";
  const gap = "An instruction between the pages.\n";
  const second =
    "Read this independent instruction.\nOnly part of the last line";
  const skillBody = prefix + first + gap + second + " is returned.\nEnd.\n";
  const receipt = pageReceipt(skillBody, {
    content: [first + "private suffix", { text: second }],
  });
  expect(receipt.invocations).toEqual([]);
  expect(receipt.bodyRanges).toEqual([
    {
      invocation: "fixture",
      sha256: "fixture-hash",
      ranges: [
        [prefix.length, prefix.length + first.length],
        [
          prefix.length + first.length + gap.length,
          skillBody.indexOf(" is returned."),
        ],
      ],
    },
  ]);
  expect(JSON.stringify(receipt)).not.toContain(first);
  expect(JSON.stringify(receipt)).not.toContain("private suffix");
});

test("page matching extends an anchor into adjacent partial lines", () => {
  const skillBody =
    "Start of the preceding line.\nRead this anchored instruction.\nThe following line continues.\n";
  const fragment =
    "preceding line.\nRead this anchored instruction.\nThe following";
  const start = skillBody.indexOf(fragment);
  const receipt = pageReceipt(skillBody, fragment);
  expect(receipt.bodyRanges?.[0]?.ranges).toEqual([
    [start, start + fragment.length],
  ]);
});

test("page receipts distinguish short, unanchored and repeated fragments", () => {
  const line = "Read this repeated instruction before any subsequent action.\n";
  expect(pageReceipt(line.repeat(3), line).bodyRanges).toEqual([
    { invocation: "fixture", sha256: "fixture-hash", ranges: [] },
  ]);
  for (const output of ["short\n", "x".repeat(80), line.toUpperCase()]) {
    expect(
      pageReceipt("short\n" + line.repeat(3), output).bodyRanges,
    ).toBeUndefined();
  }
  const boundary = "x".repeat(31) + "\n";
  expect(
    pageReceipt(boundary + "tail", boundary).bodyRanges?.[0]?.ranges,
  ).toEqual([[0, 32]]);
});

test.each([
  ["repeat\n", "skill page anchors exceed limit"],
  [
    "Read this repeated instruction before any subsequent action.\n",
    "skill page matching exceeds limit",
  ],
])("page receipt matching bounds repeated anchors: %j", (line, message) => {
  expect(() => pageReceipt(line.repeat(5000), line)).toThrow(message);
});

test("excessively nested hook responses cannot masquerade as complete evidence", () => {
  let nested: unknown = body;
  for (let depth = 0; depth < 18; depth++) nested = [nested];
  expect(() =>
    skillHookReceipt(
      { hook_event_name: "PostToolUse", tool_response: nested },
      receiptConfiguration,
    ),
  ).toThrow("skill hook response nesting exceeds limit");
});
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sevro-skill-hooks-"));
  roots.push(root);
  const directory = join(root, "skills");
  await mkdir(join(directory, "fixture"), { recursive: true });
  await writeFile(join(directory, "fixture/SKILL.md"), body);
  const tracking = await prepareSkillTracking({
    privateRoot: root,
    host: "codex",
    roots: [{ directory, boundary: root, namespace: "plugin" }],
  });
  return { root, directory, tracking };
}

async function emit(
  tracking: SkillTracking,
  event: string,
  fields: Record<string, unknown> = {},
) {
  const child = Bun.spawn(["/bin/sh", "-c", tracking.command], {
    stdin: Buffer.from(
      JSON.stringify({
        hook_event_name: event,
        session_id: "session-a",
        ...fields,
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ stdout, stderr, code }).toEqual({ stdout: "", stderr: "", code: 0 });
}

async function tool(tracking: SkillTracking, id: string, output: unknown) {
  const identity = { tool_use_id: id, tool_name: "Bash", turn_id: "turn-a" };
  await emit(tracking, "PreToolUse", identity);
  await emit(tracking, "PostToolUse", {
    ...identity,
    tool_input: { command: "arbitrary python, variables or Code Mode" },
    tool_response: output,
  });
}

test("passive hooks identify returned bodies without parsing commands or retaining private output", async () => {
  const { tracking } = await fixture();
  await emit(tracking, "SessionStart");
  await tool(tracking, "full", {
    content: [{ type: "text", text: "private-response-prefix\n" + body }],
  });
  await tool(tracking, "partial", body.slice(0, 20));
  await tool(tracking, "metadata", "skills/fixture/SKILL.md");
  await tool(tracking, "failed", "No such file");
  await emit(tracking, "Stop");
  const observation = await skillTrackingObservation(
    tracking,
    "session-a",
    true,
  );
  expect(observation.completeness).toBe("complete");
  expect(observation.data.incompleteReasons).toEqual([]);
  expect(observation.data.observedSkills).toEqual(["plugin:fixture"]);
  expect(observation.data.calls.map((call) => call.toolUseId)).toEqual([
    "full",
  ]);
  expect(JSON.stringify(observation)).not.toContain("private-response-prefix");
  expect(JSON.stringify(observation)).not.toContain("arbitrary python");
  expect(JSON.stringify(observation)).not.toContain(body);
});

test("missing collection and unfinished tools remain partial while preserving positive evidence", async () => {
  const { tracking } = await fixture();
  expect(
    (await skillTrackingObservation(tracking, "session-a", true)).data
      .incompleteReasons,
  ).toEqual([
    "receipts_unavailable",
    "session_start_missing",
    "session_stop_missing",
  ]);
  await emit(tracking, "SessionStart");
  await tool(tracking, "positive", body);
  await emit(tracking, "PreToolUse", {
    tool_use_id: "pending",
    tool_name: "Bash",
  });
  await emit(tracking, "Stop");
  const observation = await skillTrackingObservation(
    tracking,
    "session-a",
    true,
  );
  expect(observation.completeness).toBe("partial");
  expect(observation.data.observedSkills).toEqual(["plugin:fixture"]);
});

test("an output without its paired pre-hook cannot establish complete collection", async () => {
  const { tracking } = await fixture();
  await emit(tracking, "SessionStart");
  await emit(tracking, "PostToolUse", {
    tool_use_id: "orphan",
    tool_name: "Bash",
    tool_response: body,
  });
  await emit(tracking, "Stop");
  expect(
    (await skillTrackingObservation(tracking, "session-a", true)).completeness,
  ).toBe("partial");
});

test("complete empty collection differs from a failed host or the wrong session", async () => {
  const { tracking } = await fixture();
  await emit(tracking, "SessionStart");
  await emit(tracking, "Stop");
  expect(
    (await skillTrackingObservation(tracking, "session-a", true)).completeness,
  ).toBe("complete");
  expect(
    (await skillTrackingObservation(tracking, "session-a", false)).data
      .incompleteReasons,
  ).toEqual(["host_incomplete"]);
  expect(
    (await skillTrackingObservation(tracking, "other", true)).data
      .incompleteReasons,
  ).toEqual(["session_start_missing", "session_stop_missing"]);
  expect(
    (await skillTrackingObservation(tracking, null, true)).data
      .incompleteReasons,
  ).toEqual([
    "session_identity_missing",
    "session_start_missing",
    "session_stop_missing",
  ]);
});

test("malformed hook inputs stay silent and mark evidence partial", async () => {
  const { tracking } = await fixture();
  await emit(tracking, "SessionStart");
  await emit(tracking, "PostToolUse", { tool_response: body });
  await emit(tracking, "Stop");
  expect(
    (await skillTrackingObservation(tracking, "session-a", true)).completeness,
  ).toBe("partial");
});

test("catalogs reject redirected mounts and skill files", async () => {
  const { root, directory } = await fixture();
  await mkdir(join(directory, "redirect"));
  await symlink(
    join(directory, "fixture/SKILL.md"),
    join(directory, "redirect/SKILL.md"),
  );
  const files = await skillHookCatalog([{ directory, boundary: root }]);
  expect(files.catalogComplete).toBe(false);
  expect(files.skills.map((skill) => skill.invocation)).toEqual(["fixture"]);
  const alias = join(root, "alias");
  await symlink(directory, alias);
  expect(
    await skillHookCatalog([{ directory: alias, boundary: root }]),
  ).toEqual({ skills: [], catalogComplete: false });
});

test("identical bodies belonging to different skills remain ambiguous", async () => {
  const { root, directory } = await fixture();
  await mkdir(join(directory, "other"));
  await writeFile(join(directory, "other/SKILL.md"), body);
  const tracking = await prepareSkillTracking({
    privateRoot: join(root, "ambiguous"),
    host: "codex",
    roots: [{ directory, boundary: root }],
  });
  await emit(tracking, "SessionStart");
  await tool(tracking, "ambiguous", body);
  await emit(tracking, "Stop");
  const observation = await skillTrackingObservation(
    tracking,
    "session-a",
    true,
  );
  expect(observation.completeness).toBe("partial");
  expect(observation.data.observedSkills).toEqual([]);
  expect(observation.data.ambiguousSkills).toEqual(["fixture", "other"]);
});

test("oversized catalogs and skills report incomplete discovery", async () => {
  const { root, directory } = await fixture();
  await mkdir(join(directory, "large"));
  await writeFile(
    join(directory, "large/SKILL.md"),
    Buffer.alloc(1024 * 1024 + 1),
  );
  expect(
    (await skillHookCatalog([{ directory, boundary: root }])).catalogComplete,
  ).toBe(false);
  await rm(join(directory, "large"), { recursive: true });
  for (let index = 0; index < 128; index++) {
    const child = join(directory, `extra-${index}`);
    await mkdir(child);
    await writeFile(join(child, "SKILL.md"), `Instructions ${index}.\n`);
  }
  const catalog = await skillHookCatalog([{ directory, boundary: root }]);
  expect(catalog.skills).toHaveLength(128);
  expect(catalog.catalogComplete).toBe(false);
});

function recorded(event: string, fields: Record<string, unknown> = {}) {
  return skillHookReceipt(
    {
      hook_event_name: event,
      session_id: "s",
      tool_name: "B",
      ...fields,
    },
    receiptConfiguration,
  );
}

async function storeReceipts(tracking: SkillTracking, events: unknown[]) {
  await writeFile(
    join(tracking.configuration.receipts, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
}

test("invalid receipt tails preserve earlier positives while marking collection partial", async () => {
  const { tracking } = await fixture();
  const valid = [
    recorded("SessionStart"),
    recorded("PreToolUse", { tool_use_id: "a" }),
    recorded("PostToolUse", { tool_use_id: "a", tool_response: body }),
    recorded("Stop"),
  ];
  for (const invalid of [
    null,
    { ...valid[0], event: "Unknown" },
    { ...valid[0], sessionId: 42 },
    { ...valid[0], invocations: null },
    { ...valid[0], invocations: [42] },
    { ...valid[0], ambiguousInvocations: null },
    { ...valid[0], partial: null },
    { ...valid[0], bodyRanges: null },
    { ...valid[0], bodyRanges: [null] },
    {
      ...valid[0],
      bodyRanges: [{ invocation: "unknown", sha256: "unknown", ranges: [] }],
    },
    {
      ...valid[0],
      bodyRanges: [
        { ...tracking.configuration.skills[0], body: undefined, ranges: null },
      ],
    },
    ...[
      null,
      [],
      [0],
      [0, 1, 2],
      ["0", 1],
      [-1, 2],
      [0.5, 2],
      [2, 1],
      [0, body.length + 1],
    ].map((range) => ({
      ...valid[0],
      bodyRanges: [
        {
          ...tracking.configuration.skills[0],
          body: undefined,
          ranges: [range],
        },
      ],
    })),
  ]) {
    await storeReceipts(tracking, [...valid, invalid]);
    const observation = await skillTrackingObservation(tracking, "s", true);
    expect(observation.completeness).toBe("partial");
    expect(observation.data.incompleteReasons).toEqual(["invalid_receipts"]);
    expect(observation.data.observedSkills).toEqual(["fixture"]);
  }
});

test("receipt files exceeding the collection budget cannot report complete evidence", async () => {
  const { tracking } = await fixture();
  await writeFile(
    join(tracking.configuration.receipts, "events.jsonl"),
    Buffer.alloc(8 * 1024 * 1024 + 1),
  );
  const observation = await skillTrackingObservation(tracking, "s", true);
  expect(observation.completeness).toBe("partial");
  expect(observation.data.calls).toEqual([]);
  expect(observation.data.incompleteReasons).toEqual([
    "receipt_limit",
    "session_start_missing",
    "session_stop_missing",
  ]);
});

test("duplicate tool identities make an otherwise finished lifecycle partial", async () => {
  const { tracking } = await fixture();
  const pre = recorded("PreToolUse", { tool_use_id: "a" });
  const post = recorded("PostToolUse", {
    tool_use_id: "a",
    tool_response: body,
  });
  for (const tools of [
    [pre, pre, post],
    [pre, post, pre, post],
  ]) {
    await storeReceipts(tracking, [
      recorded("SessionStart"),
      ...tools,
      recorded("Stop"),
    ]);
    expect(
      (await skillTrackingObservation(tracking, "s", true)).completeness,
    ).toBe("partial");
  }
});

test("retained activation calls respect both count and serialized byte limits", async () => {
  const { tracking } = await fixture();
  for (const padding of ["", "x".repeat(240)]) {
    const events = [recorded("SessionStart")];
    for (let index = 0; index < 129; index++) {
      const identity = { tool_use_id: `${padding}${index}` };
      events.push(recorded("PreToolUse", identity));
      events.push(
        recorded("PostToolUse", { ...identity, tool_response: body }),
      );
    }
    events.push(recorded("Stop"));
    await storeReceipts(tracking, events);
    const observation = await skillTrackingObservation(tracking, "s", true);
    expect(observation.completeness).toBe("partial");
    expect(observation.data.truncated).toBe(true);
    expect(observation.data.incompleteReasons).toEqual(["calls_truncated"]);
    expect(observation.data.observedSkills).toEqual(["fixture"]);
    if (padding) expect(observation.data.calls.length).toBeLessThan(128);
    else expect(observation.data.calls).toHaveLength(128);
    expect(
      Buffer.byteLength(JSON.stringify(observation.data.calls)),
    ).toBeLessThanOrEqual(24 * 1024);
  }
});

test("exposure claims preserve proven reads beyond the retained call budget", async () => {
  const { tracking } = await fixture();
  const events = [
    recorded("SessionStart"),
    ...Array.from({ length: 128 }, (_, index) =>
      recorded("PreToolUse", { tool_use_id: `pending-${index}` }),
    ),
    recorded("PreToolUse", { tool_use_id: "full" }),
    {
      ...recorded("PostToolUse", { tool_use_id: "full" }),
      invocations: ["plugin:fixture"],
    },
    recorded("Stop"),
  ];
  await storeReceipts(tracking, events);
  const observation = await skillTrackingObservation(tracking, "s", true);
  expect(observation.data.truncated).toBe(true);
  expect(observation.data.calls).toHaveLength(128);
  expect(observation.data.skillExposures).toEqual([
    { skill: "plugin:fixture", status: "full" },
  ]);
  expect(skillExposureClaims(observation)).toEqual([
    {
      id: "sevro.host.skill-exposure-claims",
      completeness: "complete",
      data: {
        method: "tool_result_body_match",
        scope: "positive_exposure",
        collectionStatus: "partial",
        skillExposures: [{ skill: "plugin:fixture", status: "full" }],
      },
    },
  ]);
});

test("the observer can collect a complete empty catalog when no roots are configured", async () => {
  const { root } = await fixture();
  const tracking = await prepareSkillTracking({
    privateRoot: join(root, "empty"),
    host: "codex",
  });
  await emit(tracking, "SessionStart");
  await emit(tracking, "Stop");
  const observation = await skillTrackingObservation(
    tracking,
    "session-a",
    true,
  );
  expect(observation.completeness).toBe("complete");
  expect(observation.data.observedSkills).toEqual([]);
});

test("catalog discovery rejects invalid plugin identity before installing a namespace", async () => {
  const { root } = await fixture();
  await mkdir(join(root, ".claude-plugin"));
  for (const manifest of [null, {}, { name: 42 }]) {
    await writeFile(
      join(root, ".claude-plugin/plugin.json"),
      JSON.stringify(manifest),
    );
    expect(codexSkillCatalogRoots(root, [root], [])).rejects.toThrow(
      "invalid skill catalog plugin manifest",
    );
  }
});

test("catalog discovery skips empty documents and unrelated entries but flags redirected skill folders", async () => {
  const { root, directory } = await fixture();
  await mkdir(join(directory, "empty"));
  await writeFile(join(directory, "empty/SKILL.md"), "");
  await mkdir(join(directory, "invalid name"));
  await writeFile(join(directory, "README.md"), "not a skill");
  const clean = await skillHookCatalog([{ directory, boundary: root }]);
  expect(clean.catalogComplete).toBe(true);
  expect(clean.skills.map((skill) => skill.invocation)).toEqual(["fixture"]);
  await symlink(join(directory, "fixture"), join(directory, "alias"));
  const redirected = await skillHookCatalog([{ directory, boundary: root }]);
  expect(redirected.catalogComplete).toBe(false);
  expect(redirected.skills.map((skill) => skill.invocation)).toEqual([
    "fixture",
  ]);
});

async function directHook(configurationPath: string | null, input: Uint8Array) {
  const args = [
    process.execPath,
    fileURLToPath(
      new URL("../src/hosts/skill-hook-handler.ts", import.meta.url),
    ),
  ];
  if (configurationPath !== null) args.push(configurationPath);
  const child = Bun.spawn(args, {
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ stdout, stderr, code }).toEqual({ stdout: "", stderr: "", code: 0 });
}

test("the hook executable appends private receipts without producing tool output", async () => {
  const { root, tracking } = await fixture();
  const configuration = join(root, "direct.json");
  await writeFile(configuration, JSON.stringify(tracking.configuration));
  for (const event of ["SessionStart", "Stop"]) {
    await directHook(
      configuration,
      Buffer.from(JSON.stringify({ hook_event_name: event, session_id: "s" })),
    );
  }
  const path = join(tracking.configuration.receipts, "events.jsonl");
  expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(
    (await skillTrackingObservation(tracking, "s", true)).completeness,
  ).toBe("complete");
});

test("hook transport errors and input or receipt limits remain silent and incomplete", async () => {
  const { root, tracking } = await fixture();
  const configuration = join(root, "direct.json");
  await writeFile(configuration, JSON.stringify(tracking.configuration));
  const partial = join(tracking.configuration.receipts, "partial");
  for (const input of [
    Buffer.from("{"),
    Buffer.alloc(8 * 1024 * 1024 + 1, 32),
  ]) {
    await rm(partial, { force: true });
    await directHook(configuration, input);
    expect(await Bun.file(partial).exists()).toBe(true);
  }
  await rm(partial);
  const events = join(tracking.configuration.receipts, "events.jsonl");
  const size = 4 * 1024 * 1024 + 1;
  await writeFile(events, Buffer.alloc(size));
  await directHook(
    configuration,
    Buffer.from(JSON.stringify({ hook_event_name: "Stop", session_id: "s" })),
  );
  expect(await readFile(partial, "utf8")).toBe("limit\n");
  expect((await stat(events)).size).toBe(size);
  expect(
    (await skillTrackingObservation(tracking, "s", true)).completeness,
  ).toBe("partial");
  await directHook(null, Buffer.from("{}"));
});

test("the total catalog budget and unreadable documents preserve partial discovery", async () => {
  const { root, directory } = await fixture();
  const blocked = join(directory, "blocked/SKILL.md");
  await mkdir(join(directory, "blocked"));
  await writeFile(blocked, "Blocked instructions.");
  await chmod(blocked, 0);
  try {
    const catalog = await skillHookCatalog([{ directory, boundary: root }]);
    expect(catalog.catalogComplete).toBe(false);
    expect(catalog.skills.map((skill) => skill.invocation)).toEqual([
      "fixture",
    ]);
  } finally {
    await chmod(blocked, 0o600);
  }
  await rm(join(directory, "blocked"), { recursive: true });
  for (let index = 0; index < 9; index++) {
    const path = join(directory, `bulk-${index}`);
    await mkdir(path);
    await writeFile(join(path, "SKILL.md"), Buffer.alloc(1024 * 1024, 65));
  }
  const catalog = await skillHookCatalog([{ directory, boundary: root }]);
  expect(catalog.catalogComplete).toBe(false);
  expect(catalog.skills).toHaveLength(8);
});
