import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexSkillCatalogRoots,
  prepareSkillTracking,
  skillExposureClaims,
  skillTrackingObservation,
  type SkillTracking,
} from "../../../src/skill-tracking/index";
import { shellQuote } from "../../../src/platform/index";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const body =
  "---\nname: fixture\ndescription: Fixture only.\n---\n# Instructions\nRead the entire fixture.\n";

type SkillRoot = Parameters<typeof prepareSkillTracking>[0]["roots"];

async function temporaryRoot() {
  return temporaryFixture(join(tmpdir(), "sevro-skill-hooks-"));
}

async function fixture() {
  const root = await temporaryRoot();
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

/** Prepare tracking over un-namespaced skills whose invocation is their folder. */
async function trackSkills(skills: Record<string, string>) {
  const root = await temporaryRoot();
  const directory = join(root, "skills");
  for (const [name, skillBody] of Object.entries(skills)) {
    await mkdir(join(directory, name), { recursive: true });
    await writeFile(join(directory, name, "SKILL.md"), skillBody);
  }
  return prepareSkillTracking({
    privateRoot: root,
    host: "codex",
    roots: [{ directory, boundary: root }],
  });
}

/** Discover a catalog through the public preparation step. */
async function catalog(skillRoots: NonNullable<SkillRoot>) {
  const { configuration } = await prepareSkillTracking({
    privateRoot: await temporaryRoot(),
    host: "codex",
    roots: skillRoots,
  });
  return {
    skills: configuration.skills.map((skill) => skill.invocation),
    catalogComplete: configuration.catalogComplete,
  };
}

const coverageVariables = [
  "SEVRO_COVERAGE_REPORTS",
  "SEVRO_COVERAGE_RUN_ID",
  "SEVRO_COVERAGE_LAYOUT",
  "SEVRO_COVERAGE_SOURCE_ROOT",
];

/**
 * The hook command clears its environment, which would also drop an active
 * coverage run's capture identity. Forward only that identity, so the real
 * command still records the handler's counters without altering its behavior.
 */
function withCoverageCapture(command: string) {
  const assignments = coverageVariables.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [shellQuote(`${name}=${value}`)];
  });
  if (assignments.length === 0) return command;
  const marker = `${shellQuote("-i")} `;
  if (!command.includes(marker))
    throw new Error("Hook command no longer clears its environment");
  return command.replace(marker, `${marker}${assignments.join(" ")} `);
}

async function hook(command: string, input: Uint8Array) {
  const child = Bun.spawn(["/bin/sh", "-c", withCoverageCapture(command)], {
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

async function emitRaw(tracking: SkillTracking, input: unknown) {
  await hook(tracking.command, Buffer.from(JSON.stringify(input)));
}

async function emit(
  tracking: SkillTracking,
  event: string,
  fields: Record<string, unknown> = {},
) {
  await emitRaw(tracking, {
    hook_event_name: event,
    session_id: "session-a",
    ...fields,
  });
}

async function tool(
  tracking: SkillTracking,
  id: string,
  output: unknown,
  fields: Record<string, unknown> = {},
) {
  const identity = {
    tool_use_id: id,
    tool_name: "Bash",
    turn_id: "turn-a",
    ...fields,
  };
  await emit(tracking, "PreToolUse", identity);
  await emit(tracking, "PostToolUse", {
    ...identity,
    tool_input: { command: "arbitrary python, variables or Code Mode" },
    tool_response: output,
  });
}

/** Run one finished session whose tool calls return the given outputs. */
async function session(tracking: SkillTracking, outputs: unknown[]) {
  await emit(tracking, "SessionStart");
  for (const [index, output] of outputs.entries())
    await tool(tracking, `tool-${index}`, output, { tool_name: "mcp.read" });
  await emit(tracking, "Stop");
  return skillTrackingObservation(tracking, "session-a", true);
}

function receiptsPath(tracking: SkillTracking) {
  return join(tracking.configuration.receipts, "events.jsonl");
}

/** Receipts the real hook command recorded, as untyped records. */
async function recordedReceipts(tracking: SkillTracking) {
  const text = await readFile(receiptsPath(tracking), "utf8");
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function storeReceipts(tracking: SkillTracking, events: unknown[]) {
  await writeFile(
    receiptsPath(tracking),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
}

/** Record a real session around one positive read and return its receipts. */
async function templateReceipts(tracking: SkillTracking) {
  await emit(tracking, "SessionStart");
  await tool(tracking, "template", body);
  await emit(tracking, "Stop");
  const [start, pre, post, stop] = await recordedReceipts(tracking);
  if (!start || !pre || !post || !stop)
    throw new Error("expected four template receipts");
  return { start, pre, post, stop };
}

test("hook inputs with invalid envelopes are rejected as observer failures", async () => {
  for (const input of [null, [], {}, { hook_event_name: 42 }]) {
    const tracking = await trackSkills({ fixture: body });
    await emit(tracking, "SessionStart");
    await emitRaw(tracking, input);
    await emit(tracking, "Stop");
    const observation = await skillTrackingObservation(
      tracking,
      "session-a",
      true,
    );
    expect(observation.completeness).toBe("partial");
    expect(observation.data.incompleteReasons).toEqual(["observer_failure"]);
    expect(observation.data.collection.eventCount).toBe(2);
  }
});

test("tool events with incomplete identities are retained as partial hook events", async () => {
  for (const fields of [
    { session_id: null },
    { session_id: "invalid session" },
    { tool_use_id: null },
    { tool_name: null },
  ]) {
    const tracking = await trackSkills({ fixture: body });
    await emit(tracking, "SessionStart");
    await tool(tracking, "tool-a", "unrelated", fields);
    await emit(tracking, "Stop");
    const observation = await skillTrackingObservation(
      tracking,
      "session-a",
      true,
    );
    expect(observation.data.incompleteReasons).toEqual(["partial_hook_events"]);
    expect(observation.data.collection.partialEventCount).toBe(2);
    expect(observation.data.calls.map((call) => call.partial)).toEqual([
      true,
      true,
    ]);
  }
  const tracking = await trackSkills({ fixture: body });
  await emit(tracking, "SessionStart");
  await emit(tracking, "Stop");
  const observation = await skillTrackingObservation(
    tracking,
    "session-a",
    true,
  );
  expect(observation.data.collection.partialEventCount).toBe(0);
  expect(observation.completeness).toBe("complete");
});

test("hook receipts match complete bodies in nested responses and discard unrelated values", async () => {
  const { tracking } = await fixture();
  await emit(tracking, "SessionStart");
  await tool(
    tracking,
    "tool-a",
    [null, 42, false, { content: [body, body, "unrelated"] }],
    { tool_name: "mcp.read" },
  );
  await emit(tracking, "Stop");
  const observation = await skillTrackingObservation(
    tracking,
    "session-a",
    true,
  );
  expect(observation.completeness).toBe("complete");
  expect(observation.data.calls).toEqual([
    {
      event: "PostToolUse",
      sessionId: "session-a",
      turnId: "turn-a",
      toolUseId: "tool-a",
      toolName: "mcp.read",
      invocations: ["plugin:fixture"],
      ambiguousInvocations: [],
      partial: false,
      fragmentSkills: [],
    },
  ]);
  expect(observation.data.skillExposures).toEqual([
    { skill: "plugin:fixture", status: "full" },
  ]);
});

test("bodies carried by events other than tool results are ignored", async () => {
  const { tracking } = await fixture();
  await emit(tracking, "SessionStart");
  const identity = { tool_use_id: "ignored", tool_name: "Bash" };
  await emit(tracking, "PreToolUse", { ...identity, tool_response: body });
  await emit(tracking, "PostToolUse", {
    ...identity,
    tool_response: "unrelated",
  });
  await emit(tracking, "Stop");
  const observation = await skillTrackingObservation(
    tracking,
    "session-a",
    true,
  );
  expect(observation.completeness).toBe("complete");
  expect(observation.data.observedSkills).toEqual([]);
  expect(observation.data.calls).toEqual([]);
  expect(observation.data.skillExposures).toEqual([
    { skill: "plugin:fixture", status: "none" },
  ]);
});

test("hook receipts separate unique matches from identical skill bodies", async () => {
  const tracking = await trackSkills({
    fixture: body,
    other: body,
    unique: "Unique instructions.",
  });
  const observation = await session(tracking, [[body, "Unique instructions."]]);
  expect(observation.data.calls).toHaveLength(1);
  expect(observation.data.calls[0]).toMatchObject({
    invocations: ["unique"],
    ambiguousInvocations: ["fixture", "other"],
    partial: true,
  });
  expect(observation.data.observedSkills).toEqual(["unique"]);
  expect(observation.data.ambiguousSkills).toEqual(["fixture", "other"]);
  expect(observation.data.incompleteReasons).toEqual([
    "ambiguous_skill_bodies",
  ]);
  expect(observation.data.skillExposures).toEqual([
    { skill: "fixture", status: "ambiguous" },
    { skill: "other", status: "ambiguous" },
    { skill: "unique", status: "full" },
  ]);
});

test("page receipts map nested fragments to exact body offsets without retaining output", async () => {
  const prefix = "Start here 🧭 before reading these pages.\n";
  const first =
    "Read this first line completely.\nContinue with this instruction.\n";
  const gap = "An instruction between the pages.\n";
  const second =
    "Read this independent instruction.\nOnly part of the last line";
  const tail = " is returned at the end of the page.\nEnd.\n";
  const skillBody = prefix + first + gap + second + tail;
  const pages = { content: [first + "private suffix", { text: second }] };

  const partial = await session(await trackSkills({ fixture: skillBody }), [
    pages,
  ]);
  expect(partial.completeness).toBe("partial");
  expect(partial.data.incompleteReasons).toEqual(["partial_skill_bodies"]);
  expect(partial.data.partialSkills).toEqual(["fixture"]);
  expect(partial.data.observedSkills).toEqual([]);
  expect(partial.data.skillExposures).toEqual([
    { skill: "fixture", status: "partial" },
  ]);
  expect(partial.data.calls.map((call) => call.fragmentSkills)).toEqual([
    ["fixture"],
  ]);
  expect(JSON.stringify(partial)).not.toContain(first);
  expect(JSON.stringify(partial)).not.toContain("private suffix");

  // The complement covers exactly the offsets the first pages did not.
  const complete = await session(await trackSkills({ fixture: skillBody }), [
    pages,
    [prefix, gap, tail],
  ]);
  expect(complete.completeness).toBe("complete");
  expect(complete.data.partialSkills).toEqual([]);
  expect(complete.data.observedSkills).toEqual(["fixture"]);
  expect(complete.data.skillExposures).toEqual([
    { skill: "fixture", status: "full" },
  ]);

  const incomplete = await session(await trackSkills({ fixture: skillBody }), [
    pages,
    [prefix, gap],
  ]);
  expect(incomplete.data.partialSkills).toEqual(["fixture"]);
});

test("page matching extends an anchor into adjacent partial lines", async () => {
  const leading = "A leading instruction line for this page.\n";
  const trailing = "A trailing instruction line for this page.\n";
  const skillBody =
    leading +
    "Start of the preceding line.\nRead this anchored instruction.\nThe following line continues.\n" +
    trailing;
  const fragment =
    "preceding line.\nRead this anchored instruction.\nThe following";
  const complement = [
    leading + "Start of the ",
    " line continues.\n" + trailing,
  ];
  const observation = await session(await trackSkills({ fixture: skillBody }), [
    fragment,
    complement,
  ]);
  expect(observation.completeness).toBe("complete");
  expect(observation.data.skillExposures).toEqual([
    { skill: "fixture", status: "full" },
  ]);
  const unextended = await session(await trackSkills({ fixture: skillBody }), [
    "Read this anchored instruction.\n",
    complement,
  ]);
  expect(unextended.data.skillExposures).toEqual([
    { skill: "fixture", status: "partial" },
  ]);
});

test("page receipts distinguish short, unanchored and repeated fragments", async () => {
  const line = "Read this repeated instruction before any subsequent action.\n";
  const repeated = await session(
    await trackSkills({ fixture: line.repeat(3) }),
    [line, line + line],
  );
  expect(repeated.data.skillExposures).toEqual([
    { skill: "fixture", status: "partial" },
  ]);
  expect(repeated.data.incompleteReasons).toEqual(["partial_skill_bodies"]);

  for (const output of ["short\n", "x".repeat(80), line.toUpperCase()]) {
    const observation = await session(
      await trackSkills({ fixture: "short\n" + line.repeat(3) }),
      [output],
    );
    expect(observation.completeness).toBe("complete");
    expect(observation.data.calls).toEqual([]);
    expect(observation.data.skillExposures).toEqual([
      { skill: "fixture", status: "none" },
    ]);
  }

  const trailing = "A trailing instruction line for this page.\n";
  const boundary = "x".repeat(31) + "\n";
  const atBoundary = await session(
    await trackSkills({ fixture: boundary + trailing }),
    [boundary, trailing],
  );
  expect(atBoundary.data.skillExposures).toEqual([
    { skill: "fixture", status: "full" },
  ]);
  const belowBoundary = "x".repeat(30) + "\n";
  const tooShort = await session(
    await trackSkills({ fixture: belowBoundary + trailing }),
    [belowBoundary],
  );
  expect(tooShort.data.skillExposures).toEqual([
    { skill: "fixture", status: "none" },
  ]);
});

test.each([
  ["repeat\n"],
  ["Read this repeated instruction before any subsequent action.\n"],
])(
  "page receipt matching bounds repeated anchors: %j",
  async (line: string) => {
    const observation = await session(
      await trackSkills({ fixture: line.repeat(5000) }),
      [line],
    );
    expect(observation.completeness).toBe("partial");
    expect(observation.data.incompleteReasons).toEqual([
      "observer_failure",
      "pending_tool_calls",
    ]);
    expect(observation.data.calls.map((call) => call.event)).toEqual([
      "PreToolUse",
    ]);
    expect(observation.data.skillExposures).toEqual([
      { skill: "fixture", status: "unknown" },
    ]);
  },
);

test("excessively nested hook responses cannot masquerade as complete evidence", async () => {
  let nested: unknown = body;
  for (let depth = 0; depth < 18; depth++) nested = [nested];
  const observation = await session(await trackSkills({ fixture: body }), [
    nested,
  ]);
  expect(observation.completeness).toBe("partial");
  expect(observation.data.incompleteReasons).toEqual([
    "observer_failure",
    "pending_tool_calls",
  ]);
  expect(observation.data.observedSkills).toEqual([]);
  expect(observation.data.skillExposures).toEqual([
    { skill: "fixture", status: "unknown" },
  ]);
});

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
  expect(observation.data.incompleteReasons).toEqual(["pending_tool_calls"]);
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
  const observation = await skillTrackingObservation(
    tracking,
    "session-a",
    true,
  );
  expect(observation.completeness).toBe("partial");
  expect(observation.data.incompleteReasons).toEqual([
    "unmatched_post_tool_use",
  ]);
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
  expect(await catalog([{ directory, boundary: root }])).toEqual({
    skills: ["fixture"],
    catalogComplete: false,
  });
  const alias = join(root, "alias");
  await symlink(directory, alias);
  expect(await catalog([{ directory: alias, boundary: root }])).toEqual({
    skills: [],
    catalogComplete: false,
  });
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
  expect(await catalog([{ directory, boundary: root }])).toEqual({
    skills: ["fixture"],
    catalogComplete: false,
  });
  await rm(join(directory, "large"), { recursive: true });
  for (let index = 0; index < 128; index++) {
    const child = join(directory, `extra-${index}`);
    await mkdir(child);
    await writeFile(join(child, "SKILL.md"), `Instructions ${index}.\n`);
  }
  const discovered = await catalog([{ directory, boundary: root }]);
  expect(discovered.skills).toHaveLength(128);
  expect(discovered.catalogComplete).toBe(false);
});

test("invalid receipt tails preserve earlier positives while marking collection partial", async () => {
  const { tracking } = await fixture();
  const { start, pre, post, stop } = await templateReceipts(tracking);
  const valid = [start, pre, post, stop];
  const [skill] = tracking.configuration.skills;
  if (!skill) throw new Error("expected one catalog skill");
  const page = { invocation: skill.invocation, sha256: skill.sha256 };
  for (const invalid of [
    null,
    { ...start, event: "Unknown" },
    { ...start, sessionId: 42 },
    { ...start, invocations: null },
    { ...start, invocations: [42] },
    { ...start, ambiguousInvocations: null },
    { ...start, partial: null },
    { ...start, bodyRanges: null },
    { ...start, bodyRanges: [null] },
    {
      ...start,
      bodyRanges: [{ invocation: "unknown", sha256: "unknown", ranges: [] }],
    },
    { ...start, bodyRanges: [{ ...page, ranges: null }] },
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
      ...start,
      bodyRanges: [{ ...page, ranges: [range] }],
    })),
  ]) {
    await storeReceipts(tracking, [...valid, invalid]);
    const observation = await skillTrackingObservation(
      tracking,
      "session-a",
      true,
    );
    expect(observation.completeness).toBe("partial");
    expect(observation.data.incompleteReasons).toEqual(["invalid_receipts"]);
    expect(observation.data.observedSkills).toEqual(["plugin:fixture"]);
  }
});

test("receipt files exceeding the collection budget cannot report complete evidence", async () => {
  const { tracking } = await fixture();
  await writeFile(receiptsPath(tracking), Buffer.alloc(8 * 1024 * 1024 + 1));
  const observation = await skillTrackingObservation(
    tracking,
    "session-a",
    true,
  );
  expect(observation.completeness).toBe("partial");
  expect(observation.data.calls).toEqual([]);
  expect(observation.data.incompleteReasons).toEqual([
    "receipt_limit",
    "session_start_missing",
    "session_stop_missing",
  ]);
});

test("duplicate tool identities make an otherwise finished lifecycle partial", async () => {
  const identity = { tool_use_id: "a", tool_name: "Bash" };
  for (const events of [
    ["PreToolUse", "PreToolUse", "PostToolUse"],
    ["PreToolUse", "PostToolUse", "PreToolUse", "PostToolUse"],
  ]) {
    const tracking = await trackSkills({ fixture: body });
    await emit(tracking, "SessionStart");
    for (const event of events)
      await emit(tracking, event, { ...identity, tool_response: body });
    await emit(tracking, "Stop");
    const observation = await skillTrackingObservation(
      tracking,
      "session-a",
      true,
    );
    expect(observation.completeness).toBe("partial");
    expect(observation.data.incompleteReasons).toEqual([
      "duplicate_tool_calls",
    ]);
    expect(observation.data.collection.duplicateToolCallCount).toBe(1);
  }
});

test("retained activation calls respect both count and serialized byte limits", async () => {
  const { tracking } = await fixture();
  const { start, pre, post, stop } = await templateReceipts(tracking);
  for (const padding of ["", "x".repeat(240)]) {
    const events = [start];
    for (let index = 0; index < 129; index++) {
      // Compact identities keep 128 calls inside the serialized budget.
      const identity = {
        sessionId: "s",
        turnId: null,
        toolUseId: `${padding}${index}`,
        toolName: "B",
      };
      events.push({ ...pre, ...identity }, { ...post, ...identity });
    }
    events.push(stop);
    await storeReceipts(tracking, events);
    const observation = await skillTrackingObservation(
      tracking,
      "session-a",
      true,
    );
    expect(observation.completeness).toBe("partial");
    expect(observation.data.truncated).toBe(true);
    expect(observation.data.incompleteReasons).toEqual(["calls_truncated"]);
    expect(observation.data.observedSkills).toEqual(["plugin:fixture"]);
    if (padding) expect(observation.data.calls.length).toBeLessThan(128);
    else expect(observation.data.calls).toHaveLength(128);
    expect(
      Buffer.byteLength(JSON.stringify(observation.data.calls)),
    ).toBeLessThanOrEqual(24 * 1024);
  }
});

test("exposure claims preserve proven reads beyond the retained call budget", async () => {
  const { tracking } = await fixture();
  const { start, pre, post, stop } = await templateReceipts(tracking);
  await storeReceipts(tracking, [
    start,
    ...Array.from({ length: 128 }, (_, index) => ({
      ...pre,
      toolUseId: `pending-${index}`,
    })),
    pre,
    post,
    stop,
  ]);
  const observation = await skillTrackingObservation(
    tracking,
    "session-a",
    true,
  );
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
  expect(tracking.configuration.skills).toEqual([]);
  expect(tracking.configuration.catalogComplete).toBe(true);
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
  expect(await catalog([{ directory, boundary: root }])).toEqual({
    skills: ["fixture"],
    catalogComplete: true,
  });
  await symlink(join(directory, "fixture"), join(directory, "alias"));
  expect(await catalog([{ directory, boundary: root }])).toEqual({
    skills: ["fixture"],
    catalogComplete: false,
  });
});

test("the hook executable appends private receipts without producing tool output", async () => {
  const { tracking } = await fixture();
  for (const event of ["SessionStart", "Stop"]) await emit(tracking, event);
  const path = receiptsPath(tracking);
  expect(await recordedReceipts(tracking)).toHaveLength(2);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(
    (await skillTrackingObservation(tracking, "session-a", true)).completeness,
  ).toBe("complete");
});

test("hook transport errors and input or receipt limits remain silent and incomplete", async () => {
  const { tracking } = await fixture();
  const partial = join(tracking.configuration.receipts, "partial");
  for (const input of [
    Buffer.from("{"),
    Buffer.alloc(8 * 1024 * 1024 + 1, 32),
  ]) {
    await rm(partial, { force: true });
    await hook(tracking.command, input);
    expect(await Bun.file(partial).exists()).toBe(true);
  }
  await rm(partial);
  const events = receiptsPath(tracking);
  const size = 4 * 1024 * 1024 + 1;
  await writeFile(events, Buffer.alloc(size));
  await emit(tracking, "Stop");
  expect(await readFile(partial, "utf8")).toBe("limit\n");
  expect((await stat(events)).size).toBe(size);
  expect(
    (await skillTrackingObservation(tracking, "session-a", true)).completeness,
  ).toBe("partial");
  // Without its configuration argument the handler still exits silently.
  const command = tracking.command.slice(0, tracking.command.lastIndexOf(" '"));
  await hook(command, Buffer.from("{}"));
});

test("the total catalog budget and unreadable documents preserve partial discovery", async () => {
  const { root, directory } = await fixture();
  const blocked = join(directory, "blocked/SKILL.md");
  await mkdir(join(directory, "blocked"));
  await writeFile(blocked, "Blocked instructions.");
  await chmod(blocked, 0);
  try {
    expect(await catalog([{ directory, boundary: root }])).toEqual({
      skills: ["fixture"],
      catalogComplete: false,
    });
  } finally {
    await chmod(blocked, 0o600);
  }
  await rm(join(directory, "blocked"), { recursive: true });
  for (let index = 0; index < 9; index++) {
    const path = join(directory, `bulk-${index}`);
    await mkdir(path);
    await writeFile(join(path, "SKILL.md"), Buffer.alloc(1024 * 1024, 65));
  }
  const discovered = await catalog([{ directory, boundary: root }]);
  expect(discovered.catalogComplete).toBe(false);
  expect(discovered.skills).toHaveLength(8);
});
