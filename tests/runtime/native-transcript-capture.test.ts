import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeHost } from "../../src/hosts/claude";
import { nativeStateParent } from "../../src/native-transcript-state";
import { createHash } from "node:crypto";
import { defined } from "../fixtures/assertions";
import { nativeRoot } from "../fixtures/runtime-host-fixtures";
import { createCodexFixture } from "../fixtures/runtime-host-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const codexFixture = createCodexFixture(roots);

type NativeBundle = {
  completeness: string;
  files: { path: string; bytesBase64: string; sha256: string }[];
};

test.each([false, undefined])(
  "Claude disabled transcript policy keeps command home and temp outside private denial: %s",
  async (nativeTranscripts) => {
    const { root, workspace } = await codexFixture();
    const binary = join(root, "claude-command-state");
    await writeFile(
      binary,
      `#!${process.execPath}
const args = process.argv;
const settings = await Bun.file(args[args.indexOf('--settings') + 1]).json();
const fs = settings.sandbox.filesystem;
const own = [process.env.HOME, process.env.TMPDIR];
const denied = own.some(path => fs.denyWrite.some(root => path === root || path.startsWith(root + '/')) || (fs.denyRead.some(root => path === root || path.startsWith(root + '/')) && !fs.allowRead.some(root => path === root || path.startsWith(root + '/'))));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:denied?'denied':'writable'}));
`,
      { mode: 0o700 },
    );
    const credentialFile = join(root, "credential.json");
    await writeFile(credentialFile, "{}");
    const host = createClaudeHost({
      binary,
      credentialFile,
      model: "synthetic",
      effort: "low",
      projectRoot: join(root, "project"),
      resultsRoot: join(root, "results"),
      additionalProtectedRoots: [],
    });
    const result = await host.run({
      prompt: "Use home and temp",
      workspace,
      condition: "passive",
      ...(nativeTranscripts === undefined
        ? {}
        : {
            runtimePolicy: {
              format: "sevro.runtime.v1" as const,
              environment: {},
              readOnlyRoots: [],
              nativeTranscripts,
            },
          }),
    });
    expect(result.finalMessage).toBe("writable");
  },
);

test.each(["child.jsonl", "child.meta.json"])(
  "successful native capture retains malformed child evidence and downgrades tree: %s",
  async (name) => {
    const { host, root, workspace } = await codexFixture();
    await writeFile(
      join(root, "candidate"),
      `#!${process.execPath}
import {mkdir,writeFile} from 'node:fs/promises';
const path = process.env.CODEX_HOME + '/sessions';
await mkdir(path, {recursive:true});
await writeFile(path + '/rollout-runtime-test.jsonl', '{"type":"future_native_record","unknown":{"preserved":true}}\\r\\n');
await writeFile(path + '/${name}', '{"truncated":');
console.log(JSON.stringify({type:'thread.started',thread_id:'runtime-test'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ready'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,
      { mode: 0o700 },
    );
    const result = await host.run({
      prompt: "Return ready",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        nativeTranscripts: true,
      },
    });
    expect(result.complete).toBe(true);
    const observation = defined(
      result.observations?.find(
        (item) => item.id === "sevro.host.native-transcripts",
      ),
    );
    const bundle: NativeBundle = JSON.parse(
      Buffer.from(
        defined(
          result.artifacts?.find(
            (item) => item.id === "sevro.native-transcripts.bundle",
          ),
        ).bytes,
      ).toString(),
    ) as NativeBundle;
    expect(observation.completeness).toBe("partial");
    expect(bundle.completeness).toBe(observation.completeness);
    const child = defined(bundle.files.find((file) => file.path === name));
    expect(child.bytesBase64).toBe(
      Buffer.from('{"truncated":').toString("base64"),
    );
    expect(child.sha256).toBe(
      createHash("sha256").update('{"truncated":').digest("hex"),
    );
  },
);

test.each([
  "native-root",
  "",
  '{"type":',
  "{}",
  "[]",
  "null",
  '{"type":""}',
  '{"type":"future"}\n\n',
  "\ufffd",
])(
  "successful native capture preserves malformed root bytes without claiming complete: %j",
  async (content) => {
    const { host, root, workspace } = await codexFixture();
    await writeFile(
      join(root, "candidate"),
      `#!${process.execPath}
import {mkdir,writeFile} from 'node:fs/promises';
const path = process.env.CODEX_HOME + '/sessions';
await mkdir(path, {recursive:true});
await writeFile(path + '/rollout-runtime-test.jsonl', Buffer.from('${Buffer.from(content === "\ufffd" ? Buffer.from([0xff]) : content).toString("base64")}', 'base64'));
console.log(JSON.stringify({type:'thread.started',thread_id:'runtime-test'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ready'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,
      { mode: 0o700 },
    );
    const result = await host.run({
      prompt: "Return ready",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        nativeTranscripts: true,
      },
    });
    expect(result.complete).toBe(true);
    const observation = defined(
      result.observations?.find(
        (item) => item.id === "sevro.host.native-transcripts",
      ),
    );
    const bundle: NativeBundle = JSON.parse(
      Buffer.from(
        defined(
          result.artifacts?.find(
            (item) => item.id === "sevro.native-transcripts.bundle",
          ),
        ).bytes,
      ).toString(),
    ) as NativeBundle;
    expect(observation.completeness).toBe("partial");
    expect(bundle.completeness).toBe(observation.completeness);
    const bytes =
      content === "\ufffd" ? Buffer.from([0xff]) : Buffer.from(content);
    expect(defined(bundle.files[0]).bytesBase64).toBe(bytes.toString("base64"));
    expect(defined(bundle.files[0]).sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  },
);

test("Claude opt-in supplies live transcript discovery without granting private settings", async () => {
  const { root, workspace } = await codexFixture();
  const binary = join(root, "claude-transcripts");
  await writeFile(
    binary,
    `#!${process.execPath}
const args = process.argv;
const settings = await Bun.file(args[args.indexOf('--settings') + 1]).json();
const config = process.env.CLAUDE_CONFIG_DIR;
const root = process.env.SEVRO_NATIVE_TRANSCRIPT_ROOT;
const fs = settings.sandbox.filesystem;
const startup = process.env.BASH_ENV;
  const script = startup ? await Bun.file(startup).text() : '';
const peerRoot = process.env.SEVRO_RUNTIME_PEER;
const peerDenied = !peerRoot || fs.denyRead.some(path => peerRoot === path || peerRoot.startsWith(path + '/'));
const namespace = root ? root.split('/').slice(0, -3).join('/') : '';
const namespaceDenied = namespace.endsWith('/sevro-native-private') && fs.denyRead.includes(namespace);
const shells = ['/bin/bash'];
const zsh = Bun.which('zsh');
if (zsh) shells.push(zsh);
const discoveries = await Promise.all(shells.map(async shell => {
  const child = Bun.spawn([shell, '-c', 'printf "%s" "$CLAUDE_CONFIG_DIR"'], {env: {...process.env, CLAUDE_CONFIG_DIR: ''}, stdout:'pipe'});
  return {config: await new Response(child.stdout).text(), exitCode: await child.exited};
}));
const valid = namespaceDenied && peerDenied && root && discoveries.every(shell => shell.exitCode === 0 && shell.config + '/projects' === root) && fs.allowRead.includes(root) && fs.denyWrite.includes(root) && fs.denyRead.some(path => config.startsWith(path)) && script.includes('CLAUDE_CONFIG_DIR=');
console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: valid ? 'available' : 'missing'}));
`,
    { mode: 0o700 },
  );
  const credentialFile = join(root, "claude-credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
  });
  const peer = await realpath(
    await mkdtemp(join(await nativeStateParent(), "claude-peer-")),
  );
  roots.push(peer);
  const result = await host.run({
    prompt: "Read transcript",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { SEVRO_RUNTIME_PEER: peer },
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  expect(result.finalMessage).toBe("available");
});

test("Claude opt-in reports unavailable native transcript evidence after cleanup", async () => {
  const { root, workspace } = await codexFixture();
  const binary = join(root, "claude-empty-transcripts");
  await writeFile(
    binary,
    '#!/bin/sh\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
    { mode: 0o700 },
  );
  const credentialFile = join(root, "credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
  });
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    )?.completeness,
  ).toBe("unavailable");
});

test("native capture leaves an unbound root session partial", async () => {
  const { root, workspace } = await codexFixture();
  const binary = join(root, "claude-unbound-transcripts");
  await writeFile(
    binary,
    '#!/bin/sh\nmkdir -p "$CLAUDE_CONFIG_DIR/projects/project"\nprintf native > "$CLAUDE_CONFIG_DIR/projects/project/session.jsonl"\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
    { mode: 0o700 },
  );
  const credentialFile = join(root, "credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
  });
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    )?.completeness,
  ).toBe("partial");
});

test("Claude native capture associates root and child files with their native session", async () => {
  const { root, workspace } = await codexFixture();
  const binary = join(root, "claude-tree");
  await writeFile(
    binary,
    `#!${process.execPath}
import {mkdir,writeFile} from 'node:fs/promises';
const path = process.env.CLAUDE_CONFIG_DIR + '/projects/' + process.cwd().replace(/[^A-Za-z0-9]/g, '-');
await mkdir(path + '/11111111-1111-4111-8111-111111111111/subagents', {recursive:true});
await writeFile(path + '/11111111-1111-4111-8111-111111111111.jsonl', JSON.stringify({type:'assistant',sessionId:'11111111-1111-4111-8111-111111111111',message:{model:'synthetic',content:[{type:'tool_use',name:'Agent',id:'task',input:{}}]}})+'\\n'+JSON.stringify({type:'user',sessionId:'11111111-1111-4111-8111-111111111111',message:{content:[{type:'tool_result',tool_use_id:'task'}]},toolUseResult:{status:'completed',agentId:'child'}})+'\\n');
await writeFile(path + '/11111111-1111-4111-8111-111111111111/subagents/agent-child.jsonl', JSON.stringify({type:'assistant',sessionId:'11111111-1111-4111-8111-111111111111',agentId:'child',message:{content:[{type:'tool_use',name:'Skill',id:'read',input:{skill:'example:read'}}]}}));
await writeFile(path + '/11111111-1111-4111-8111-111111111111/subagents/agent-child.meta.json', '{"toolUseId":"task","parentAgentId":null}');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'11111111-1111-4111-8111-111111111111'}));
console.log(JSON.stringify({type:'result',session_id:'11111111-1111-4111-8111-111111111111',subtype:'success',is_error:false,result:'ready'}));
`,
    { mode: 0o700 },
  );
  const credentialFile = join(root, "credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
  });
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  const capture = defined(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    ),
  );
  expect(capture.data.rootSessionId).toBe(
    "11111111-1111-4111-8111-111111111111",
  );
  expect(capture.data.files).toHaveLength(3);
  expect(capture.completeness).toBe("complete");
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.claude.nested-skills",
    )?.completeness,
  ).toBe("complete");
});

test("Claude opt-in preserves partial native transcripts on stream failure", async () => {
  const { root, workspace } = await codexFixture();
  const binary = join(root, "claude-failed-transcripts");
  await writeFile(
    binary,
    '#!/bin/sh\nmkdir -p "$CLAUDE_CONFIG_DIR/projects/project"\nprintf unfinished > "$CLAUDE_CONFIG_DIR/projects/project/failed.jsonl"\nsleep 2\n',
    { mode: 0o700 },
  );
  const credentialFile = join(root, "credential.json");
  await writeFile(credentialFile, "{}");
  const host = createClaudeHost({
    binary,
    credentialFile,
    model: "synthetic",
    effort: "low",
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [],
    timeoutMs: 300,
  });
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  expect(result.executionFailed).toBe(true);
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    )?.completeness,
  ).toBe("partial");
});

test("Codex opt-in exposes live native transcripts read-only while protecting private siblings", async () => {
  const { host, workspace } = await codexFixture(
    '/bin/cat "$CODEX_HOME/sessions/rollout-runtime-test.jsonl" >/dev/null && printf native-root; ! /bin/cat "$CODEX_HOME/auth.json"; ! /bin/cat "$CODEX_HOME/config.toml"; ! /bin/echo changed > "$CODEX_HOME/sessions/rollout-runtime-test.jsonl"',
  );
  const result = await host.run({
    prompt: "Read transcript",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("native-root");
});

test("Codex opt-in retains native bytes and marks missing sessions unavailable", async () => {
  const { host, workspace } = await codexFixture();
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  const capture = result.observations?.find(
    (item) => item.id === "sevro.host.native-transcripts",
  );
  expect(capture?.completeness).toBe("complete");
  expect(capture?.data.rootSessionId).toBe("runtime-test");
  const artifact = defined(
    result.artifacts?.find(
      (item) => item.id === "sevro.native-transcripts.bundle",
    ),
  );
  expect(Buffer.from(artifact.bytes).toString()).toContain(
    Buffer.from(nativeRoot).toString("base64"),
  );
});

test("native capture refuses to call a missing original session complete", async () => {
  const { host, root, workspace } = await codexFixture();
  const binary = join(root, "candidate");
  const source = await readFile(binary, "utf8");
  await writeFile(
    binary,
    source.replace(
      "answer=$(",
      'mv "$CODEX_HOME/sessions/rollout-runtime-test.jsonl" "$CODEX_HOME/sessions/rollout-child.jsonl"\nanswer=$(',
    ),
  );
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  const capture = result.observations?.find(
    (item) => item.id === "sevro.host.native-transcripts",
  );
  expect(capture?.completeness).toBe("partial");
  expect(capture?.data.issues).toContain("root_session_missing");
});

test("native transcript metadata cannot overflow the existing artifact budget", async () => {
  const { host, root, workspace } = await codexFixture();
  const binary = join(root, "candidate");
  await writeFile(
    binary,
    `#!${process.execPath}
import {mkdir,writeFile} from 'node:fs/promises';
const path = process.env.CODEX_HOME + '/sessions';
await mkdir(path, {recursive:true});
await writeFile(path + '/000-rollout-runtime-test.jsonl', Buffer.alloc(5*1024*1024));
for (let index=0; index<4094; index++) await writeFile(path + '/' + String(index).padStart(4,'0') + 'x'.repeat(244) + '.json', '');
console.log(JSON.stringify({type:'thread.started',thread_id:'runtime-test'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ready'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,
    { mode: 0o700 },
  );
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  const artifact = defined(
    result.artifacts?.find(
      (item) => item.id === "sevro.native-transcripts.bundle",
    ),
  );
  expect(artifact.bytes.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    )?.completeness,
  ).toBe("partial");
}, 15000);

test("Codex opt-in preserves partial native transcripts when native execution fails", async () => {
  const { host, root, workspace } = await codexFixture();
  await writeFile(
    join(root, "candidate"),
    '#!/bin/sh\nmkdir -p "$CODEX_HOME/sessions"\nprintf unfinished > "$CODEX_HOME/sessions/rollout-failed.jsonl"\nexit 1\n',
    { mode: 0o700 },
  );
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  expect(result.executionFailed).toBe(true);
  expect(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    )?.completeness,
  ).toBe("partial");
  expect(
    Buffer.from(
      defined(
        result.artifacts?.find(
          (item) => item.id === "sevro.native-transcripts.bundle",
        ),
      ).bytes,
    ).toString(),
  ).toContain(Buffer.from("unfinished").toString("base64"));
});

test("native host refuses an unsafe pre-existing transcript namespace", async () => {
  const { host, workspace } = await codexFixture();
  const namespace = join(
    process.platform === "linux" ? "/var/tmp" : tmpdir(),
    "sevro-native-private",
  );
  await mkdir(namespace, { recursive: true, mode: 0o700 });
  await chmod(namespace, 0o777);
  try {
    expect(
      host.run({
        prompt: "Return ready",
        workspace,
        condition: "passive",
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
          nativeTranscripts: true,
        },
      }),
    ).rejects.toThrow("native state namespace");
  } finally {
    await chmod(namespace, 0o700);
  }
});

test("native host refuses a forged retained transcript view", async () => {
  const { host, root, workspace } = await codexFixture();
  const external = join(root, "external-view");
  await mkdir(external);
  expect(
    host.run({
      prompt: "Return ready",
      workspace,
      condition: "passive",
      candidateTranscriptRoot: external,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
      },
    }),
  ).rejects.toThrow("native transcript view");
});

test("native capture marks the declared native byte limit partial", async () => {
  const { host, root, workspace } = await codexFixture();
  const binary = join(root, "candidate");
  await writeFile(
    binary,
    `#!${process.execPath}
import {mkdir,writeFile} from 'node:fs/promises';
const path = process.env.CODEX_HOME + '/sessions';
await mkdir(path, {recursive:true});
await writeFile(path + '/rollout-runtime-test.jsonl', 'native root bytes');
await writeFile(path + '/rollout-child.jsonl', Buffer.alloc(6*1024*1024));
console.log(JSON.stringify({type:'thread.started',thread_id:'runtime-test'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ready'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,
    { mode: 0o700 },
  );
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  const capture = defined(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    ),
  );
  expect(capture.completeness).toBe("partial");
  expect(capture.data.issues).toContain("byte_limit");
  expect(capture.data.files).toHaveLength(1);
});

test("native capture refuses credential-bearing source links", async () => {
  const { host, root, workspace } = await codexFixture(
    'if cat "$CODEX_HOME/sessions/escape.jsonl" >/dev/null 2>&1; then printf exposed; else printf denied; fi',
  );
  const binary = join(root, "candidate");
  const source = await readFile(binary, "utf8");
  await writeFile(
    binary,
    source.replace(
      "answer=$(",
      'ln -s "$CODEX_HOME/auth.json" "$CODEX_HOME/sessions/escape.jsonl"\nanswer=$(',
    ),
  );
  const result = await host.run({
    prompt: "Return ready",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  expect(result.finalMessage).toBe("denied");
  const capture = defined(
    result.observations?.find(
      (item) => item.id === "sevro.host.native-transcripts",
    ),
  );
  expect(capture.completeness).toBe("partial");
  expect(capture.data.issues).toContain("unsafe_entry");
  const artifact = defined(
    result.artifacts?.find(
      (item) => item.id === "sevro.native-transcripts.bundle",
    ),
  );
  expect(Buffer.from(artifact.bytes).toString()).not.toContain(
    Buffer.from("synthetic-auth").toString("base64"),
  );
});
