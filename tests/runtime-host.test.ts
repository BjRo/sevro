import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexHost } from "../src/hosts/codex";
import { createClaudeHost } from "../src/hosts/claude";
import { createHash, randomUUID } from "node:crypto";
import { runtimeSeedDigest } from "../src/runtime-seeds";
import {
  loadRuntimeConfiguration,
  runEvaluation,
  type HostAdapter,
} from "../src/engine";
import { parseRunEvidence } from "./fixtures/assertions";
import { defined } from "./fixtures/assertions";

type NativeBundle = {
  completeness: string;
  files: { path: string; bytesBase64: string; sha256: string }[];
};
const roots: string[] = [];
const nativeRoot =
  '{"type":"session_meta","payload":{"id":"runtime-test"},"future":"preserved"}';
test("public Codex Linux profile keeps trusted native trees visible under an empty root", async () => {
  const { root, workspace } = await codexFixture();
  const sourceRoot =
    process.env.SEVRO_COVERAGE_SOURCE_ROOT ?? join(import.meta.dir, "..");
  const packageRoot = join(root, "package");
  await mkdir(packageRoot);
  await cp(join(sourceRoot, "src"), join(packageRoot, "src"), {
    recursive: true,
  });
  await symlink(
    join(import.meta.dir, "../node_modules"),
    join(packageRoot, "node_modules"),
  );
  const binary = join(root, "linux-codex");
  const profile = join(root, "emitted-profile.toml");
  await writeFile(
    binary,
    `#!${process.execPath}
import {parse} from '${join(import.meta.dir, "../node_modules/smol-toml/dist/index.js")}';
const args=process.argv.slice(2);
const raw=await Bun.file(process.env.CODEX_HOME+'/config.toml').text();
if(args[0]==='sandbox'){await Bun.write('${profile}',raw);process.exit(0);}
const config=parse(raw);const rules=config.permissions[config.default_permissions].filesystem;
const home=process.env.CODEX_HOME;const namespace=home.split('/').slice(0,-2).join('/');
const exposed=Object.entries(rules).some(([path,mode])=>(mode==='read'||mode==='write')&&(path===namespace||namespace.startsWith(path+'/')));
const safe=rules[':root']==='deny'&&!exposed&&rules[namespace]===undefined&&rules[home+'/sessions']==='read'&&rules[home+'/tmp/arg0']==='read';
console.log(JSON.stringify({type:'thread.started',thread_id:'linux-profile'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:safe?'protected and visible':'masked or exposed'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,
    { mode: 0o700 },
  );
  const script = `Object.defineProperty(process,'platform',{value:'linux'});const {createCodexHost}=await import(${JSON.stringify(join(packageRoot, "src/hosts/codex.ts"))});const host=createCodexHost(${JSON.stringify({ binary, sandboxBinary: binary, authFile: join(root, "auth.json"), projectRoot: join(root, "project"), resultsRoot: join(root, "results"), additionalProtectedRoots: [], model: "synthetic", effort: "low", agentConcurrencyLimit: null })});console.log(JSON.stringify(await host.run(${JSON.stringify({ prompt: "Return ready", workspace, condition: "passive", runtimePolicy: { format: "sevro.runtime.v1", environment: {}, readOnlyRoots: [], nativeTranscripts: true } })})));`;
  const processResult = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
    processResult.exited,
  ]);
  expect(code, stderr).toBe(0);
  const result = JSON.parse(stdout) as {
    complete: boolean;
    finalMessage: string;
  };
  expect(result.complete).toBe(true);
  expect(result.finalMessage).toBe("protected and visible");
});
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
const denied = own.some(path => fs.denyRead.concat(fs.denyWrite).some(root => path === root || path.startsWith(root + '/')));
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
const peerDenied = !peerRoot || fs.denyRead.includes(peerRoot);
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
    await mkdtemp(join(tmpdir(), "sevro-claude-state-")),
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
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("Claude fixture binaries keep precedence with a declared PATH", async () => {
  const { root, workspace, bin } = await codexFixture();
  const fixtureBinDir = join(workspace, ".git", "fixture-bin");
  await mkdir(fixtureBinDir, { recursive: true });
  await writeFile(join(fixtureBinDir, "probe"), "#!/bin/sh\nprintf fixture\n", {
    mode: 0o755,
  });
  const binary = join(root, "claude-fixture");
  await writeFile(
    binary,
    `#!/bin/sh
answer=$(probe)
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}\\n' "$answer"
`,
    { mode: 0o755 },
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
  const result = await host.run({
    prompt: "Return probe output.",
    workspace,
    fixtureBinDir,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {
        PATH: `${bin}:/usr/bin:/bin`,
        SEVRO_RUNTIME_SAMPLE: "host tool",
      },
      readOnlyRoots: [bin],
    },
  });
  expect(result.finalMessage).toBe("fixture");
});

test("Claude refuses direct read access to an original seed source", async () => {
  const { root, workspace } = await codexFixture();
  const source = join(root, "seed");
  await mkdir(source);
  const binary = join(root, "claude-fixture");
  await writeFile(
    binary,
    '#!/bin/sh\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"ready"}\\n\'\n',
    { mode: 0o755 },
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
  expect(
    host.run({
      prompt: "Return ready.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [source],
        seeds: [
          { source, target: "cache", sha256: await runtimeSeedDigest(source) },
        ],
      },
    }),
  ).rejects.toThrow("protected data");
});

async function codexFixture(
  command = "probe",
  additionalProtectedRoots: string[] = [],
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-runtime-host-")),
  );
  roots.push(root);
  const project = join(root, "project"),
    results = join(root, "results"),
    workspace = join(root, "workspace"),
    bin = join(root, "tools");
  await Promise.all(
    [project, results, workspace, bin].map((path) => mkdir(path)),
  );
  await writeFile(
    join(bin, "probe"),
    '#!/bin/sh\nprintf "%s" "$SEVRO_RUNTIME_SAMPLE"\n',
  );
  await chmod(join(bin, "probe"), 0o755);
  const codex = defined(Bun.which("codex"));
  const binary = join(root, "candidate");
  await writeFile(
    binary,
    `#!/bin/sh
/bin/cat >/dev/null
profile=$(/usr/bin/sed -n 's/^default_permissions = "\\(.*\\)"/\\1/p' "$CODEX_HOME/config.toml")
/bin/mkdir -p "$CODEX_HOME/sessions"
printf '%s' '${nativeRoot}' > "$CODEX_HOME/sessions/rollout-runtime-test.jsonl"
answer=$('${codex}' sandbox -P "$profile" -C "$PWD" -- /bin/sh -c '${command}' 2>"$PWD/sandbox-error") || answer=unavailable
printf '%s\\n' '{"type":"thread.started","thread_id":"runtime-test"}'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "$answer"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
  );
  await chmod(binary, 0o755);
  const auth = join(root, "auth.json");
  await writeFile(auth, "synthetic-auth");
  const host = createCodexHost({
    binary,
    sandboxBinary: codex,
    authFile: auth,
    projectRoot: project,
    resultsRoot: results,
    additionalProtectedRoots: [auth, ...additionalProtectedRoots],
    model: "synthetic",
    effort: "low",
  });
  return { host, workspace, root, bin };
}

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

test("Codex transcript access cannot read another native trial tree", async () => {
  const peer = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-claude-state-")),
  );
  roots.push(peer);
  await writeFile(join(peer, "secret"), "peer-transcript");
  const { host, workspace } = await codexFixture(
    `if /bin/cat "${peer}/secret" >/dev/null 2>&1; then printf exposed; else printf denied; fi`,
  );
  const result = await host.run({
    prompt: "Check boundary",
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

test("direct runtime policy refuses lexical native seed aliases to public caches", async () => {
  const { host, root, workspace } = await codexFixture();
  const namespace = join(
    process.platform === "linux" ? "/var/tmp" : tmpdir(),
    "sevro-native-private",
  );
  await mkdir(namespace, { recursive: true, mode: 0o700 });
  const privateRoot = await mkdtemp(join(namespace, "seed-alias-probe-"));
  roots.push(privateRoot);
  const source = join(root, "public-cache");
  await mkdir(source);
  await writeFile(join(source, "value"), "public dependency");
  const alias = join(privateRoot, "public-alias");
  await symlink(source, alias);
  const sha256 = await runtimeSeedDigest(source);
  expect(
    host.run({
      prompt: "Return ready",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        seeds: [{ source: alias, target: "cache", sha256 }],
      },
    }),
  ).rejects.toThrow("protected data");
  expect(
    await Bun.file(
      join(workspace, ".git/sevro-runtime/candidate/cache/value"),
    ).exists(),
  ).toBe(false);
});

test("direct runtime policy cannot copy a symlinked private native seed", async () => {
  const { host, root, workspace } = await codexFixture();
  const namespace = join(
    process.platform === "linux" ? "/var/tmp" : tmpdir(),
    "sevro-native-private",
  );
  await mkdir(namespace, { recursive: true, mode: 0o700 });
  const source = await realpath(await mkdtemp(join(namespace, "seed-probe-")));
  roots.push(source);
  await writeFile(join(source, "private.txt"), "peer private input");
  const alias = join(root, "native-state-alias");
  await symlink(source, alias);
  expect(
    host.run({
      prompt: "Return ready",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        seeds: [{ source: alias, target: "cache", sha256: "a".repeat(64) }],
      },
    }),
  ).rejects.toThrow("protected data");
  expect(
    await Bun.file(
      join(workspace, ".git/sevro-runtime/candidate/cache/private.txt"),
    ).exists(),
  ).toBe(false);
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

async function waitForNativeCommand(path: string): Promise<void> {
  for (let index = 0; index < 800; index++) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error("native command did not start");
}

test("running native commands cannot read a later-created peer transcript tree", async () => {
  const parent = join(
    process.platform === "linux" ? "/var/tmp" : tmpdir(),
    "sevro-native-private",
  );
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const namespace = await realpath(parent);
  const peer = join(namespace, `late-peer-${randomUUID()}`);
  roots.push(peer);
  const { host, workspace } = await codexFixture(
    `printf ready > late-ready; sleep 0.5; if cat "${peer}/secret" >/dev/null 2>&1; then printf exposed; else printf denied; fi`,
  );
  const running = host.run({
    prompt: "Check boundary",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
  });
  await waitForNativeCommand(join(workspace, "late-ready"));
  await mkdir(peer, { mode: 0o700 });
  await writeFile(join(peer, "secret"), "later private transcript");
  expect((await running).finalMessage).toBe("denied");
}, 15000);

test("evaluation exposes retained native evidence to isolated shell and semantic consumers", async () => {
  const { host, root } = await codexFixture();
  const semanticHost: HostAdapter = {
    id: "transcript.semantic",
    model: "fixture",
    effort: "low",
    async run(request) {
      const view = request.candidateTranscriptRoot;
      const content = view
        ? await readFile(
            join(view, "codex", "rollout-runtime-test.jsonl"),
            "utf8",
          )
        : "missing";
      return {
        complete: true,
        finalMessage: JSON.stringify({
          checks: [
            {
              id: "semantic",
              verdict: content === nativeRoot ? "pass" : "fail",
              reason: "Retained native evidence",
            },
          ],
        }),
      };
    },
  };
  const { result } = await runEvaluation({
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
    shellIsolation: { protectedRoots: [] },
    case: {
      id: "transcript-consumers",
      prompt: "Return ready",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [
        {
          id: "shell",
          grader: "sevro.shell",
          configuration: {
            run: 'cat "$SEVRO_CANDIDATE_TRANSCRIPTS/codex/rollout-runtime-test.jsonl"; ! printf changed > "$SEVRO_CANDIDATE_TRANSCRIPTS/codex/rollout-runtime-test.jsonl"',
            expectExact: nativeRoot,
          },
        },
        {
          id: "semantic",
          grader: "sevro.semantic",
          configuration: { proposition: "Transcript is available" },
        },
      ],
    },
  });
  expect(result.task.verdict).toBe("passed");
});

test("evaluation retains native transcript artifacts when cancellation follows host completion", async () => {
  const { root, host } = await codexFixture();
  const controller = new AbortController();
  const cancellingHost: HostAdapter = {
    ...host,
    async run(request) {
      const result = await host.run(request);
      controller.abort();
      return result;
    },
  };
  const { result } = await runEvaluation({
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host: cancellingHost,
    signal: controller.signal,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      nativeTranscripts: true,
    },
    case: {
      id: "cancelled-transcripts",
      prompt: "Return ready",
      fixture: { files: {} },
      requiredEvidence: [],
      checks: [],
    },
  });
  expect(result.execution.status).toBe("cancelled");
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(
    defined(evidence.trials[0]).artifactRefs.some(
      (item) => item.id === "sevro.native-transcripts.bundle",
    ),
  ).toBe(true);
});

test("Codex candidate commands use the declared runtime environment", async () => {
  const { host, workspace, bin } = await codexFixture();
  const result = await host.run({
    prompt: "Return probe output.",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {
        PATH: `${bin}:/usr/bin:/bin`,
        SEVRO_RUNTIME_SAMPLE: "from caller",
      },
      readOnlyRoots: [bin],
    },
  });
  expect(result.complete).toBe(true);
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("from caller");
});

test("Codex resolved support-tree aliases grant reads and refuse writes", async () => {
  const support = await realpath(
    await mkdtemp(join(homedir(), ".sevro-runtime-alias-")),
  );
  roots.push(support);
  const source = join(support, "protected-source"),
    privateSibling = join(support, "private-sibling"),
    deniedFile = join(support, "protected-login.json");
  await Promise.all([source, privateSibling].map((path) => mkdir(path)));
  await writeFile(join(source, "value"), "source marker");
  await writeFile(join(privateSibling, "value"), "private sibling marker");
  await writeFile(deniedFile, "login marker");
  const { host, workspace, root } = await codexFixture(
    '/bin/cat "$SUPPORT_ALIAS/value"; if printf changed > "$SUPPORT_ALIAS/value" 2>/dev/null; then printf writable; fi; for path in "$SUPPORT_SOURCE/value" "$SUPPORT_PRIVATE/value" "$SUPPORT_DENIED_FILE"; do if /bin/cat "$path" >/dev/null 2>&1; then printf private-readable; fi; done',
    [source, deniedFile],
  );
  const cellar = join(support, "Cellar"),
    opt = join(support, "opt");
  const target = join(cellar, "package"),
    alias = join(opt, "package");
  await mkdir(target, { recursive: true });
  await mkdir(opt);
  await writeFile(join(target, "value"), "alias support");
  await symlink(target, alias);
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: {
        set: {
          SUPPORT_ALIAS: alias,
          SUPPORT_SOURCE: source,
          SUPPORT_PRIVATE: privateSibling,
          SUPPORT_DENIED_FILE: deniedFile,
        },
      },
      filesystem: { optionalReadOnlyRoots: [opt, cellar] },
    }),
  );
  const policy = await loadRuntimeConfiguration(
    join(root, "project"),
    join(root, "runtime.json"),
  );
  const result = await host.run({
    prompt: "Read support",
    workspace,
    condition: "passive",
    runtimePolicy: policy,
  });
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("alias support");
  expect(await readFile(join(target, "value"), "utf8")).toBe("alias support");
});

test.skipIf(process.platform !== "linux")(
  "Codex retains protected home denial inside platform read baselines",
  async () => {
    const { root, workspace } = await codexFixture(
      "if /bin/cat /usr/bin/env >/dev/null 2>&1; then printf exposed; else printf blocked; fi",
    );
    const peer = join(root, "baseline-peer.ts");
    const options = {
      binary: join(root, "candidate"),
      sandboxBinary: defined(Bun.which("codex")),
      authFile: join(root, "auth.json"),
      projectRoot: join(root, "project"),
      resultsRoot: join(root, "results"),
      additionalProtectedRoots: [join(root, "auth.json")],
      model: "synthetic",
      effort: "low",
    };
    const request = {
      prompt: "Inspect runtime",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: ["/usr/local/bin"],
      },
    };
    await writeFile(
      peer,
      `import {createCodexHost} from ${JSON.stringify(join(import.meta.dir, "../src/hosts/codex.ts"))};
try { const result = await createCodexHost(${JSON.stringify(options)}).run(${JSON.stringify(request)}); console.log(result.finalMessage); }
catch (cause) { if (!(cause instanceof Error) || !/Codex (?:isolation|executable) preflight failed/.test(cause.message)) throw cause; console.log("blocked-before-execution"); }
`,
    );
    const child = Bun.spawn([process.execPath, peer], {
      env: { ...process.env, HOME: "/usr" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(["blocked", "blocked-before-execution"]).toContain(stdout.trim());
  },
);

test.skipIf(process.platform !== "darwin")(
  "Codex selected Apple Git can query configuration",
  async () => {
    const { host, root, workspace } = await codexFixture(
      'git config --system --get sevro.nonexistent.runtimeprobe; code=$?; test "$code" -eq 1 && printf accessible',
    );
    await writeFile(
      join(root, "runtime.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { set: { PATH: "/usr/bin:/bin" } },
      }),
    );
    const runtimePolicy = await loadRuntimeConfiguration(
      join(root, "project"),
      join(root, "runtime.json"),
    );
    const result = await host.run({
      prompt: "Query Git",
      workspace,
      condition: "passive",
      runtimePolicy,
    });
    expect(
      result.finalMessage,
      await readFile(join(workspace, "sandbox-error"), "utf8"),
    ).toBe("accessible");
  },
  15000,
);

test("Codex candidate commands use private runtime seeds", async () => {
  const { host, workspace, root } = await codexFixture(
    '/bin/cat "$UV_CACHE_DIR/input"; /bin/echo changed > "$UV_CACHE_DIR/input"',
  );
  const source = join(root, "seed");
  await mkdir(source);
  await writeFile(join(source, "input"), "seeded");
  const result = await host.run({
    prompt: "Use the private cache.",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { UV_CACHE_DIR: "{{sevro.runtime}}/cache" },
      readOnlyRoots: [],
      seeds: [
        { source, target: "cache", sha256: await runtimeSeedDigest(source) },
      ],
    },
  });
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("seeded");
  expect(await readFile(join(source, "input"), "utf8")).toBe("seeded");
});

test("Codex refuses a seed changed after its configuration snapshot", async () => {
  const { host, workspace, root } = await codexFixture();
  const source = join(root, "seed");
  await mkdir(source);
  await writeFile(join(source, "input"), "original");
  const sha256 = await runtimeSeedDigest(source);
  await writeFile(join(source, "input"), "changed");
  expect(
    host.run({
      prompt: "Return ready.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        seeds: [{ source, target: "cache", sha256 }],
      },
    }),
  ).rejects.toThrow("changed after");
});

test("Codex refuses a file planted in an owned runtime seed slot", async () => {
  const { host, workspace, root } = await codexFixture();
  const source = join(root, "seed");
  await mkdir(source);
  const directory = join(workspace, ".git/sevro-runtime/candidate");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "cache"), "not a directory");
  expect(
    host.run({
      prompt: "Return ready.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        seeds: [
          { source, target: "cache", sha256: await runtimeSeedDigest(source) },
        ],
      },
    }),
  ).rejects.toThrow("not a directory");
});

test("Codex rejects runner-owned environment values in direct runtime requests", async () => {
  const { host, workspace } = await codexFixture();
  expect(
    host.run({
      prompt: "Return ready.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: { NODE_OPTIONS: "--no-warnings" },
        readOnlyRoots: [],
      },
    }),
  ).rejects.toThrow("protected");
});

// Keep the public evaluation invocation and both role outcomes together; bounded by the 200-line test rule.
// eslint-disable-next-line max-lines-per-function
test("evaluation applies the selected runtime policy to semantic and advisory hosts", async () => {
  const { root } = await codexFixture();
  const host: HostAdapter = {
    id: "runtime.candidate",
    model: "fixture",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      if (
        request.runtimePolicy?.environment.SEVRO_RUNTIME_SAMPLE !== "selected"
      )
        throw new Error("runtime unavailable");
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [{ id: "meaning", verdict: "pass", reason: "Ready" }],
        }),
      });
    },
  };
  const advisoryHost: HostAdapter = {
    ...host,
    id: "runtime.advisory",
    run(request) {
      if (
        request.runtimePolicy?.environment.SEVRO_RUNTIME_SAMPLE !== "selected"
      )
        throw new Error("runtime unavailable");
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          verdict: "pass",
          overallScore: 5,
          dimensions: {
            correctness: 5,
            maintainability: 5,
            testQuality: 5,
            scopeDiscipline: 5,
          },
          strengths: [],
          weaknesses: [],
          summary: "Ready",
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "results-evaluation"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    advisoryHost,
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { SEVRO_RUNTIME_SAMPLE: "selected" },
      readOnlyRoots: [],
    },
    case: {
      id: "runtime-roles",
      prompt: "Return ready.",
      fixture: {
        kind: "generated",
        commits: [{ message: "baseline", files: { "README.md": "baseline" } }],
      },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The response is ready." },
        },
      ],
      requiredEvidence: [],
    },
  });
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  expect(result.task.verdict, JSON.stringify(evidence.trials)).toBe("passed");
  expect(defined(evidence.trials[0]).advisoryReview?.status).toBe("completed");
});

test.each(["..", "home", "tmp"])(
  "Codex refuses reserved or escaping runtime seed target: %s",
  async (target) => {
    const { host, root, workspace } = await codexFixture();
    const source = join(root, "seed");
    await mkdir(source);
    expect(
      host.run({
        prompt: "Return ready.",
        workspace,
        condition: "passive",
        runtimePolicy: {
          format: "sevro.runtime.v1",
          environment: {},
          readOnlyRoots: [],
          seeds: [{ source, target, sha256: await runtimeSeedDigest(source) }],
        },
      }),
    ).rejects.toThrow("target");
  },
);

test("evaluation refuses credential-bearing runtime policy before creating results", async () => {
  const { root } = await codexFixture();
  const resultsRoot = join(root, "private-results");
  const host: HostAdapter = {
    id: "runtime.stub",
    model: "synthetic",
    effort: "none",
    run() {
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  expect(
    runEvaluation({
      projectRoot: root,
      resultsRoot,
      runnerBuildDigest: "a".repeat(64),
      projectDigest: "b".repeat(64),
      condition: "passive",
      trialCount: 1,
      passThreshold: 1,
      host,
      case: {
        id: "credential-runtime",
        prompt: "Return ready",
        fixture: { files: {} },
        checks: [],
        requiredEvidence: [],
      },
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: { OPENAI_API_KEY: "synthetic-private-value" },
        readOnlyRoots: [],
      },
    }),
  ).rejects.toThrow("protected");
  expect(await Bun.file(resultsRoot).exists()).toBe(false);
});

test("Codex refuses native-goal runtime policy on the exec route", async () => {
  const { host, workspace } = await codexFixture();
  expect(
    host.run({
      prompt: "Complete the native goal.",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        hooks: { nativeGoal: true },
      },
    }),
  ).rejects.toThrow("app-server");
});

test("evaluation snapshots runtime values before a caller changes them", async () => {
  const { root } = await codexFixture();
  const policy = {
    format: "sevro.runtime.v1" as const,
    environment: { SEVRO_RUNTIME_SAMPLE: "selected" },
    readOnlyRoots: [],
  };
  const host: HostAdapter = {
    id: "runtime.stub",
    model: "synthetic",
    effort: "none",
    run() {
      policy.environment.SEVRO_RUNTIME_SAMPLE = "changed";
      return Promise.resolve({ complete: true, finalMessage: "ready" });
    },
  };
  const semanticHost: HostAdapter = {
    ...host,
    id: "runtime.semantic",
    run(request) {
      return Promise.resolve({
        complete: true,
        finalMessage: JSON.stringify({
          checks: [
            {
              id: "meaning",
              verdict:
                request.runtimePolicy?.environment.SEVRO_RUNTIME_SAMPLE ===
                "selected"
                  ? "pass"
                  : "fail",
              reason: "Runtime value observed",
            },
          ],
        }),
      });
    },
  };
  const { result } = await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "snapshot-results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    semanticHost,
    case: {
      id: "snapshot-runtime",
      prompt: "Return ready",
      fixture: { files: {} },
      checks: [
        {
          id: "meaning",
          grader: "sevro.semantic",
          configuration: { proposition: "The runtime is selected." },
        },
      ],
      requiredEvidence: [],
    },
    runtimePolicy: policy,
  });
  expect(result.task.verdict).toBe("passed");
});

test("Codex can reuse a declared native installation under the real home", async () => {
  const { root, workspace, bin } = await codexFixture();
  const installation = await realpath(
    await mkdtemp(join(homedir(), ".sevro-native-runtime-")),
  );
  roots.push(installation);
  const binary = join(installation, "candidate");
  await writeFile(binary, await readFile(join(root, "candidate")), {
    mode: 0o700,
  });
  const host = createCodexHost({
    binary,
    sandboxBinary: defined(Bun.which("codex")),
    authFile: join(root, "auth.json"),
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    additionalProtectedRoots: [join(root, "auth.json")],
    model: "synthetic",
    effort: "low",
  });
  const result = await host.run({
    prompt: "Return probe output",
    workspace,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {
        PATH: `${bin}:/usr/bin:/bin`,
        SEVRO_RUNTIME_SAMPLE: "from caller",
      },
      readOnlyRoots: [installation, bin],
    },
  });
  expect(result.finalMessage).toBe("from caller");
});

test("Codex declared PATH preserves fixture tool access", async () => {
  const { host, workspace } = await codexFixture("fixture-probe");
  const fixtureBinDir = join(workspace, ".git/fixture-bin");
  await mkdir(fixtureBinDir, { recursive: true });
  await writeFile(
    join(fixtureBinDir, "fixture-probe"),
    '#!/bin/sh\nprintf "fixture wins"\n',
    { mode: 0o700 },
  );
  const result = await host.run({
    prompt: "Return fixture output",
    workspace,
    fixtureBinDir,
    condition: "passive",
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: { PATH: "/usr/bin:/bin" },
      readOnlyRoots: [],
    },
  });
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("fixture wins");
});

test("evaluation retains complete native runtime policy evidence", async () => {
  const { host, root, bin } = await codexFixture();
  const { result } = await runEvaluation({
    projectRoot: join(root, "project"),
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    host,
    case: {
      id: "runtime-evidence",
      prompt: "Return probe output",
      fixture: { files: {} },
      checks: [],
      requiredEvidence: ["sevro.host.runtime"],
    },
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {
        PATH: `${bin}:/usr/bin:/bin`,
        SEVRO_RUNTIME_SAMPLE: "from caller",
      },
      readOnlyRoots: [bin],
    },
  });
  const evidence = parseRunEvidence(
    await readFile(result.evidencePath, "utf8"),
  );
  const observation = defined(evidence.trials[0]).observations.find(
    (row) => row.id === "sevro.host.runtime",
  );
  expect(observation?.completeness).toBe("complete");
  expect(observation?.data.environmentNames).toContain("SEVRO_RUNTIME_SAMPLE");
  expect(observation?.data.role).toBe("candidate");
});
