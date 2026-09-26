import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSkillReadObservation } from "../src/hosts/codex-skill-reads";

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
  expect(observed).toEqual({
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
