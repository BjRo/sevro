import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isolatedNativeHost,
  ordinaryCodexRequest,
} from "../../fixtures/codex-host";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { cleanupTemporaryFixtures } = createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

test("Codex host collects runner-owned hooks independently of command syntax", async () => {
  if (!isolatedNativeHost) return;
  const { host, request } = await ordinaryCodexRequest(roots);
  await mkdir(join(request.workspace, ".git"));
  await mkdir(join(request.workspace, ".agents/skills/probe"), {
    recursive: true,
  });
  await writeFile(
    join(request.workspace, ".agents/skills/probe/SKILL.md"),
    "Full private skill instructions.\n",
  );
  await writeFile(
    join(request.workspace, ".git/skill-hooks.ts"),
    `
const definitions = await Bun.file(process.env.CODEX_HOME + "/hooks.json").json();
const body = await Bun.file(".agents/skills/probe/SKILL.md").text();
for (const name of ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]) {
  const input = {hook_event_name: name, session_id: "thread-1", tool_use_id: "read-1", tool_name: "mcp__reader__read", tool_response: body};
  const command = definitions.hooks[name][0].hooks[0].command;
  const child = Bun.spawn(["/bin/sh", "-c", command], {stdin: Buffer.from(JSON.stringify(input)), stdout: "pipe", stderr: "pipe"});
  if (await child.exited !== 0) process.exit(90);
}
`,
  );
  const result = await host.run(request);
  expect(result.complete).toBe(true);
  expect(host.hostCapabilities).toContain("sevro.host.skill-activations");
  expect(host.hostCapabilities).toContain("sevro.host.skill-exposure-claims");
  expect(
    result.observations?.some((item) => item.id.endsWith("skill-reads")),
  ).toBe(false);
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.skill-activations",
    ),
  ).toMatchObject({
    completeness: "complete",
    data: { method: "tool_result_body_match", observedSkills: ["probe"] },
  });
  expect(JSON.stringify(result.observations)).not.toContain(
    "Full private skill instructions.",
  );
});
