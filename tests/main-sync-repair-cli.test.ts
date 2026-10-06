import { afterEach, expect, test } from "bun:test";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function runFixture(
  declaration: Record<string, unknown>,
  options: {
    peer?: string;
    peerText?: string;
    candidate?: string;
    semantic?: string;
    appServer?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "sevro-main-sync-repair-"));
  roots.push(root);
  const caseFile = join(root, "case.json");
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "repair",
      prompt: "Return ready",
      checks: [],
      requiredEvidence: [],
      ...declaration,
    }),
  );
  const argv = [
    process.execPath,
    join(import.meta.dir, "../src/cli.ts"),
    "run",
    "--json",
    "--case-file",
    caseFile,
    "--project-root",
    root,
    "--results-root",
    join(root, "results"),
    "--condition",
    "passive",
    "--trials",
    "1",
    "--threshold",
    "1",
  ];
  if (options.peer || options.peerText) {
    const binRoot = await mkdtemp(
      join(tmpdir(), "sevro-main-sync-repair-bin-"),
    );
    roots.push(binRoot);
    const binary = join(binRoot, "codex");
    if (options.peerText) await writeFile(binary, options.peerText);
    else await cp(join(import.meta.dir, "fixtures", options.peer!), binary);
    await chmod(binary, 0o700);
    const credential = join(root, "auth.json");
    await writeFile(credential, "{}");
    argv.push(
      "--host",
      "codex",
      "--codex-bin",
      binary,
      "--codex-auth-file",
      credential,
      "--model",
      "synthetic",
      "--effort",
      "low",
    );
    if (options.appServer) argv.push("--codex-entrypoint", "app-server");
  } else {
    const candidate = join(root, "candidate.ts");
    await writeFile(
      candidate,
      options.candidate ??
        'export default {id:"test.candidate", model:"test", effort:"none", async run(){return {complete:true,finalMessage:"ready"};}};',
    );
    argv.push("--adapter-module", candidate);
  }
  if (options.semantic) {
    const semantic = join(root, "semantic.ts");
    await writeFile(semantic, options.semantic);
    argv.push("--semantic-adapter-module", semantic);
  }
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const result = JSON.parse(out);
  const evidence = result.evidencePath
    ? JSON.parse(await readFile(result.evidencePath, "utf8"))
    : null;
  return {
    result,
    evidence,
    code,
    diagnostic: out + err + JSON.stringify(evidence?.diagnostic),
  };
}

test("public CLI rejects saved document aliases into Git metadata", async () => {
  const run = await runFixture(
    {
      fixture: { files: {} },
      checks: [
        {
          id: "artifact",
          grader: "sevro.semantic",
          configuration: {
            artifactPath: "notes/last-message.md",
            proposition: "The saved document is correct.",
          },
        },
      ],
    },
    {
      candidate:
        'import {mkdir,symlink,writeFile} from "node:fs/promises"; import {join} from "node:path"; export default {id:"test.candidate", model:"test", effort:"none", async run({workspace}){await mkdir(join(workspace,".git"),{recursive:true}); await writeFile(join(workspace,".git/last-message.md"),"metadata"); await symlink(".git",join(workspace,"notes")); return {complete:true,finalMessage:"ready"};}};',
      semantic:
        'export default {id:"test.grader", model:"test", effort:"none", async run(){return {complete:true,finalMessage:JSON.stringify({checks:[{id:"artifact",verdict:"pass",reason:"Synthetic verdict"}]})};}};',
    },
  );
  expect(run.result.grading.status, run.diagnostic).toBe("error");
});

test("public CLI refuses fabricated completed executor output as a skill read", async () => {
  for (const mode of ["fabricated", "completed"]) {
    const run = await runFixture(
      {
        fixture: {
          kind: "generated",
          commits: [
            {
              message: "Initial",
              files: {
                "read-mode.txt": mode,
                ".agents/skills/probe/SKILL.md":
                  "---\nname: probe\ndescription: Fixture skill\n---\nPRIVATE_SKILL_BODY\n",
              },
            },
          ],
        },
      },
      { peer: "completed-read-peer.ts" },
    );
    expect(run.code, run.diagnostic).toBe(0);
    const reads = run.evidence.trials[0].observations.find(
      (value: { id: string }) => value.id === "sevro.codex.skill-reads",
    );
    expect(reads.data.observedSkills).toEqual(
      mode === "fabricated" ? [] : ["probe"],
    );
  }
});

test("public CLI keeps recovered skill reads on their original feedback turn", async () => {
  const peer = await readFile(
    join(import.meta.dir, "fixtures/yielded-read-peer.ts"),
    "utf8",
  );
  const prefix = peer.slice(0, peer.indexOf("const path ="));
  const nativeRead = peer.slice(
    peer.indexOf("const path ="),
    peer.indexOf('console.log(JSON.stringify({ type: "thread.started"'),
  );
  const commandOutput = peer.slice(
    peer.indexOf(
      'console.log(\n  JSON.stringify({\n    type: "item.completed",\n    item: {\n      id: "command"',
    ),
    peer.indexOf(
      'console.log(\n  JSON.stringify({\n    type: "item.completed",\n    item: { type: "agent_message"',
    ),
  );
  const end = peer.slice(
    peer.indexOf(
      'console.log(\n  JSON.stringify({\n    type: "item.completed",\n    item: { type: "agent_message"',
    ),
  );
  const peerText =
    prefix +
    '\nconsole.log(JSON.stringify({type:"thread.started",thread_id:"root"}));\n' +
    'if ((await readFile("read-turn.txt","utf8")) === (process.argv.includes("resume") ? "follow-up" : "initial")) {\n' +
    nativeRead +
    commandOutput +
    "\n}\n" +
    end;
  for (const turn of ["initial", "follow-up"]) {
    const run = await runFixture(
      {
        followUpPrompt: "User correction",
        fixture: {
          kind: "generated",
          commits: [
            {
              message: "Initial",
              files: {
                "read-turn.txt": turn,
                ".agents/skills/probe/SKILL.md":
                  "---\nname: probe\ndescription: Fixture skill\n---\nPRIVATE_SKILL_BODY\n",
              },
            },
          ],
        },
      },
      { peerText },
    );
    expect(run.code, run.diagnostic).toBe(0);
    for (const observedTurn of ["initial", "follow-up"]) {
      const read = run.evidence.trials[0].observations.find(
        (value: { id: string }) =>
          value.id === `sevro.codex.${observedTurn}-skill-reads`,
      );
      expect(read.data.observedSkills).toEqual(
        observedTurn === turn ? ["probe"] : [],
      );
      expect(read.completeness).toBe("complete");
    }
  }
});

test("public CLI retains distinct bounded skill recovery sources", async () => {
  const expectations = {
    yielded: {
      nativeOutput: false,
      yieldedChunks: 1,
      completedCall: false,
      literalCommandCall: false,
    },
    completed: {
      nativeOutput: false,
      yieldedChunks: 0,
      completedCall: true,
      literalCommandCall: false,
    },
    literal: {
      nativeOutput: false,
      yieldedChunks: 0,
      completedCall: false,
      literalCommandCall: true,
    },
    native: {
      nativeOutput: true,
      yieldedChunks: 0,
      completedCall: false,
      literalCommandCall: false,
    },
  };
  for (const [mode, expected] of Object.entries(expectations)) {
    const run = await runFixture(
      {
        fixture: {
          kind: "generated",
          commits: [
            {
              message: "Initial",
              files: {
                "read-mode.txt": mode,
                ".agents/skills/probe/SKILL.md":
                  "---\nname: probe\ndescription: Fixture skill\n---\nPRIVATE_SKILL_BODY\n",
              },
            },
          ],
        },
      },
      {
        peer:
          mode === "yielded"
            ? "yielded-read-peer.ts"
            : "completed-read-peer.ts",
      },
    );
    expect(run.code, run.diagnostic).toBe(0);
    const calls = run.evidence.trials[0].observations.find(
      (value: { id: string }) => value.id === "sevro.codex.native-calls",
    );
    expect(calls.data.parentReadDiagnostics.recoverySources).toEqual([
      expect.objectContaining(expected),
    ]);
    expect(JSON.stringify(run.evidence.trials[0].observations)).not.toContain(
      "PRIVATE_SKILL_BODY",
    );
  }
});

test("public CLI observes native goal readback without update notifications", async () => {
  const peer = await readFile(
    join(import.meta.dir, "fixtures/app-server-peer.ts"),
    "utf8",
  );
  const peerText = peer.replace(
    "reply({ goal: null });",
    'reply({ goal: goal("active") });',
  );
  const run = await runFixture(
    {
      followUpPrompt: "User correction",
      fixture: {
        kind: "generated",
        commits: [{ message: "Initial", files: { "feedback.txt": "wait" } }],
      },
    },
    { peerText, appServer: true },
  );
  expect(run.code, run.diagnostic).toBe(0);
  const boundary = run.evidence.trials[0].observations.find(
    (value: { id: string }) => value.id === "sevro.codex.continuation",
  );
  expect(boundary.data).toMatchObject({
    threadId: "root",
    nativeGoalObserved: true,
    nativeGoalStatus: "active",
  });
  expect(JSON.stringify(run.evidence.trials[0].observations)).not.toContain(
    "PRIVATE_GOAL_OBJECTIVE",
  );
});
