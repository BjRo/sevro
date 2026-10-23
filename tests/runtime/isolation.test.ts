import { syntheticClaudeLogin } from "../fixtures/claude-login";
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
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
import { createClaudeHost } from "../../src/hosts/claude";
import { randomUUID } from "node:crypto";
import { runtimeSeedDigest } from "../../src/runtime/seeds";
import { allocateNativeState } from "../../src/native-transcript-state";
import { loadRuntimeConfiguration } from "../../src/engine";
import { defined } from "../fixtures/assertions";
import { waitForNativeCommand } from "../fixtures/runtime-host-fixtures";
import { createCodexFixture } from "../fixtures/runtime-host-fixtures";

const testDirectory = join(import.meta.dir, "..");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const codexFixture = createCodexFixture(roots);

const nativeRuntimeCases = (
  ["candidate", "semantic", "advisory"] as const
).flatMap((role) =>
  [false, true].map((nativeTranscripts) => ({ role, nativeTranscripts })),
);

test("public Codex Linux profile keeps trusted native trees visible under an empty root", async () => {
  const { root, workspace } = await codexFixture();
  const sourceRoot =
    process.env.SEVRO_COVERAGE_SOURCE_ROOT ?? join(testDirectory, "..");
  const packageRoot = join(root, "package");
  await mkdir(packageRoot);
  await cp(join(sourceRoot, "src"), join(packageRoot, "src"), {
    recursive: true,
  });
  await symlink(
    join(testDirectory, "../node_modules"),
    join(packageRoot, "node_modules"),
  );
  const binary = join(root, "linux-codex");
  const profile = join(root, "emitted-profile.toml");
  await writeFile(
    binary,
    `#!${process.execPath}
import {parse} from '${join(testDirectory, "../node_modules/smol-toml/dist/index.js")}';
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

function gitMetadataCommand(): string {
  return [
    "set -eu",
    "git switch -c docs/native-publication-authority 1>&2",
    "printf accepted > NOTES.md",
    "git add NOTES.md",
    "git write-tree > captured-tree",
    "git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm accepted",
    "mkdir -p .git/artificer",
    "(set -C; printf locked > .git/artificer/admission.lock)",
    "printf revoked > .git/artificer/grant",
    "rm .git/artificer/admission.lock",
    "git init --bare -q remote.git",
    "git push ./remote.git HEAD:refs/heads/published 1>&2",
    'for path in "$PROTECTED_SOURCE" "$PROTECTED_RESULTS" "$PROTECTED_LOGIN"; do',
    '  if cat "$path" >/dev/null 2>&1; then exit 81; fi',
    '  if printf changed > "$path" 2>/dev/null; then exit 82; fi',
    "done",
    'for path in "$CODEX_HOME/auth.json" "$CODEX_HOME/config.toml"; do',
    '  if cat "$path" >/dev/null 2>&1; then exit 81; fi',
    // Linux may allow new files in synthetic ancestors; the parent verifies the originals below.
    '  printf changed 2>/dev/null > "$path" || true',
    "done",
    "if printf changed > .agents/skills/probe/SKILL.md 2>/dev/null; then exit 83; fi",
    "if mkdir -p .codex 2>/dev/null && printf changed 2>/dev/null > .codex/config.toml; then exit 84; fi",
    "printf accepted",
  ].join("\n");
}

async function verifyOriginalCodexConfiguration(binary: string): Promise<void> {
  const source = await readFile(binary, "utf8");
  const snapshot =
    '/usr/bin/cksum "$CODEX_HOME/auth.json" "$CODEX_HOME/config.toml"';
  await writeFile(
    binary,
    source
      .replace("answer=$(", `original_configuration=$(${snapshot})\nanswer=$(`)
      .replace(
        " || answer=unavailable",
        ` || answer=unavailable\nif [ "$original_configuration" != "$(${snapshot})" ]; then answer=modified-private-configuration; fi`,
      ),
  );
}

test("Codex candidate can commit, publish local refs and update admission state", async () => {
  const { host, root, workspace } = await codexFixture(gitMetadataCommand());
  await verifyOriginalCodexConfiguration(join(root, "candidate"));
  const source = join(root, "project", "hidden.txt");
  const results = join(root, "results", "hidden.txt");
  await Promise.all([
    writeFile(source, "hidden source"),
    writeFile(results, "hidden grading"),
    mkdir(join(workspace, ".agents/skills/probe"), { recursive: true }),
  ]);
  await writeFile(join(workspace, ".agents/skills/probe/SKILL.md"), "skill");
  expect(await Bun.spawn(["git", "init", "-q", workspace]).exited).toBe(0);
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: {
        set: {
          PATH: "/usr/bin:/bin",
          PROTECTED_SOURCE: source,
          PROTECTED_RESULTS: results,
          PROTECTED_LOGIN: join(root, "auth.json"),
        },
      },
      nativeTranscripts: true,
    }),
  );
  const runtimePolicy = await loadRuntimeConfiguration(
    join(root, "project"),
    join(root, "runtime.json"),
  );
  const result = await host.run({
    prompt:
      "Commit and publish to the local fixture remote, then revoke the grant.",
    workspace,
    condition: "passive",
    runtimePolicy,
  });
  expect(
    result.finalMessage,
    await readFile(join(workspace, "sandbox-error"), "utf8"),
  ).toBe("accepted");
  const head = await readFile(
    join(workspace, ".git/refs/heads/docs/native-publication-authority"),
    "utf8",
  );
  expect(
    await readFile(join(workspace, "remote.git/refs/heads/published"), "utf8"),
  ).toBe(head);
  expect(await readFile(join(workspace, ".git/HEAD"), "utf8")).toBe(
    "ref: refs/heads/docs/native-publication-authority\n",
  );
  expect(await readFile(join(workspace, ".git/artificer/grant"), "utf8")).toBe(
    "revoked",
  );
  expect(existsSync(join(workspace, ".git/artificer/admission.lock"))).toBe(
    false,
  );
  expect(await readFile(join(workspace, "NOTES.md"), "utf8")).toBe("accepted");
  expect(await readFile(source, "utf8")).toBe("hidden source");
  expect(await readFile(results, "utf8")).toBe("hidden grading");
});

test("Codex Git metadata grant cannot write through a link into protected source", async () => {
  const { host, root, workspace } = await codexFixture(
    "if printf changed > .git/private.txt 2>/dev/null; then printf exposed; else printf blocked; fi",
  );
  const metadata = join(root, "project", "metadata");
  await mkdir(metadata);
  await writeFile(join(metadata, "private.txt"), "protected");
  await symlink(metadata, join(workspace, ".git"));
  const result = await host
    .run({
      prompt: "Try writing protected metadata.",
      workspace,
      condition: "passive",
    })
    .catch((cause: unknown) => {
      if (
        !(cause instanceof Error) ||
        cause.message !== "Codex Git metadata must be an isolated directory"
      )
        throw cause;
      return { finalMessage: "blocked" };
    });
  expect(result.finalMessage).toBe("blocked");
  expect(await readFile(join(metadata, "private.txt"), "utf8")).toBe(
    "protected",
  );
});

test.each([false, true])(
  "Codex runtime cannot read or write another native trial tree: transcripts %s",
  async (nativeTranscripts) => {
    const peer = await allocateNativeState("claude-peer-");
    roots.push(peer);
    await writeFile(join(peer, "secret"), "peer-transcript");
    const { host, workspace } = await codexFixture(
      `if /bin/cat "${peer}/secret" >/dev/null 2>&1 || printf changed > "${peer}/secret" 2>/dev/null || mkdir "${peer}/child" 2>/dev/null; then printf exposed; else printf denied; fi`,
    );
    const result = await host.run({
      prompt: "Check boundary",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        nativeTranscripts,
      },
    });
    expect(result.finalMessage).toBe("denied");
    expect(await readFile(join(peer, "secret"), "utf8")).toBe(
      "peer-transcript",
    );
  },
);

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

test.each([false, true])(
  "running native commands cannot read or write a later-created peer tree: transcripts %s",
  async (nativeTranscripts) => {
    const parent = join(
      process.platform === "linux" ? "/var/tmp" : tmpdir(),
      "sevro-native-private",
    );
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const namespace = await realpath(parent);
    const peer = join(namespace, `late-peer-${randomUUID()}`);
    roots.push(peer);
    const { host, workspace } = await codexFixture(
      `printf ready > late-ready; sleep 0.5; if cat "${peer}/secret" >/dev/null 2>&1 || printf changed > "${peer}/secret" 2>/dev/null || mkdir "${peer}/child" 2>/dev/null; then printf exposed; else printf denied; fi`,
    );
    const running = host.run({
      prompt: "Check boundary",
      workspace,
      condition: "passive",
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: {},
        readOnlyRoots: [],
        nativeTranscripts,
      },
    });
    await waitForNativeCommand(join(workspace, "late-ready"));
    await mkdir(peer, { mode: 0o700 });
    await writeFile(join(peer, "secret"), "later private transcript");
    expect((await running).finalMessage).toBe("denied");
    expect(await readFile(join(peer, "secret"), "utf8")).toBe(
      "later private transcript",
    );
  },
  45000,
);

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
      `import {createCodexHost} from ${JSON.stringify(join(testDirectory, "../src/hosts/codex.ts"))};
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
  30000,
);

test.each(nativeRuntimeCases)(
  "Codex runtime supports plugin review artifacts outside the repository: $role, transcripts $nativeTranscripts",
  async ({ role, nativeTranscripts }) => {
    const { host, workspace } = await codexFixture(
      'if /bin/cat "$RUNTIME_ROOT/../codex-home/auth.json" >/dev/null 2>&1 || /bin/cat "$RUNTIME_ROOT/../codex-home/config.toml" >/dev/null 2>&1 || printf changed > "$RUNTIME_ROOT/../home/planted" 2>/dev/null; then printf exposed; exit 0; fi; case "$HOME" in "$PWD"/*) printf repository-local;; *) /bin/mkdir -p "$HOME/.darrow/reviews" && printf review > "$HOME/.darrow/reviews/result" && /bin/cat "$HOME/.darrow/reviews/result"; printf "%s" "$HOME" > runtime-home;; esac',
    );
    const result = await host.run({
      prompt: "Write review state outside the Git fixture.",
      workspace,
      condition: "passive",
      runtimeRole: role,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: { RUNTIME_ROOT: "{{sevro.runtime}}" },
        readOnlyRoots: [],
        nativeTranscripts,
      },
    });
    expect(
      result.finalMessage,
      await readFile(join(workspace, "sandbox-error"), "utf8"),
    ).toBe("review");
    const home = await readFile(join(workspace, "runtime-home"), "utf8");
    expect(home.startsWith(`${workspace}/`)).toBe(false);
    expect(await Bun.file(join(home, ".darrow/reviews/result")).exists()).toBe(
      false,
    );
  },
  30000,
);

test.each(nativeRuntimeCases)(
  "Claude runtime supports plugin review artifacts with narrow external grants: $role, transcripts $nativeTranscripts",
  async ({ role, nativeTranscripts }) => {
    const { root, workspace } = await codexFixture();
    const binary = join(root, "claude-runtime-artifact");
    await writeFile(
      binary,
      `#!${process.execPath}
const args = process.argv;
const settings = await Bun.file(args[args.indexOf('--settings') + 1]).json();
const fs = settings.sandbox.filesystem;
const runtime = process.env.RUNTIME_ROOT;
const namespace = runtime.split('/').slice(0, -2).join('/');
const writable = fs.allowWrite?.length === 1 && fs.allowWrite[0] === runtime && !fs.denyWrite.some(path => runtime === path || runtime.startsWith(path + '/'));
const bounded = fs.allowRead.includes(runtime) && fs.denyRead.includes(namespace) && !fs.allowRead.includes(namespace) && !settings.permissions.deny.includes('Edit(/' + namespace + '/**)') && !settings.permissions.additionalDirectories.includes(namespace);
const editsBounded = !settings.permissions.allow.includes('Edit') && settings.permissions.allow.includes('Edit(/' + process.cwd() + '/**)') && settings.permissions.allow.includes('Edit(/' + runtime + '/**)');
const shell = Bun.spawn(['/bin/sh', '-c', 'case "$HOME" in "$PWD"/*) printf repository-local;; *) /bin/mkdir -p "$HOME/.darrow/reviews" && printf review > "$HOME/.darrow/reviews/result" && /bin/cat "$HOME/.darrow/reviews/result";; esac'], {stdout:'pipe'});
const artifact = await new Response(shell.stdout).text();
await shell.exited;
await Bun.write('runtime-home', process.env.HOME);
const result = artifact === 'repository-local' ? artifact : writable && bounded && editsBounded ? artifact : 'invalid grants';
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result}));
`,
      { mode: 0o700 },
    );
    const credentialFile = join(root, "claude-credential.json");
    await writeFile(credentialFile, syntheticClaudeLogin());
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
      prompt: "Write private review state.",
      workspace,
      condition: "passive",
      runtimeRole: role,
      runtimePolicy: {
        format: "sevro.runtime.v1",
        environment: { RUNTIME_ROOT: "{{sevro.runtime}}" },
        readOnlyRoots: [],
        nativeTranscripts,
      },
    });
    expect(result.finalMessage).toBe("review");
    const home = await readFile(join(workspace, "runtime-home"), "utf8");
    expect(home.startsWith(`${workspace}/`)).toBe(false);
    expect(await Bun.file(join(home, ".darrow/reviews/result")).exists()).toBe(
      false,
    );
  },
);
