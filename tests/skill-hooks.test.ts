import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareSkillTracking,
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
    (await skillTrackingObservation(tracking, "session-a", true)).completeness,
  ).toBe("partial");
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
    (await skillTrackingObservation(tracking, "session-a", false)).completeness,
  ).toBe("partial");
  expect(
    (await skillTrackingObservation(tracking, "other", true)).completeness,
  ).toBe("partial");
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
  ]) {
    await storeReceipts(tracking, [...valid, invalid]);
    const observation = await skillTrackingObservation(tracking, "s", true);
    expect(observation.completeness).toBe("partial");
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
    expect(observation.data.observedSkills).toEqual(["fixture"]);
    if (padding) expect(observation.data.calls.length).toBeLessThan(128);
    else expect(observation.data.calls).toHaveLength(128);
    expect(
      Buffer.byteLength(JSON.stringify(observation.data.calls)),
    ).toBeLessThanOrEqual(24 * 1024);
  }
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
