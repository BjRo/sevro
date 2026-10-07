import { expectUnknown } from "./fixtures/assertions";
import { defined } from "./fixtures/assertions";
import { afterEach, test, expect } from "bun:test";
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
