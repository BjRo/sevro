import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareSkillTracking,
  skillTrackingObservation,
  type SkillTracking,
} from "../src/hosts/skill-hooks";
import { skillHookCatalog } from "../src/hosts/skill-hook-catalog";

const roots: string[] = [];
const body =
  "---\nname: fixture\ndescription: Fixture only.\n---\n# Instructions\nRead the entire fixture.\n";
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
