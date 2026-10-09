import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfiguration, runEvaluation } from "../src/engine";
import { defined } from "./fixtures/assertions";

const roots: string[] = [];
test.each(["required", "optional", "provider", "discovery"])(
  "portable runtime declarations retain lexical native namespace protection: %s",
  async (kind) => {
    const root = await fixture({ format: "sevro.runtime.v1" });
    const namespace = join(
      process.platform === "linux" ? "/var/tmp" : tmpdir(),
      "sevro-native-private",
    );
    await mkdir(namespace, { recursive: true, mode: 0o700 });
    const privateRoot = await mkdtemp(
      join(namespace, "discovery-alias-probe-"),
    );
    roots.push(privateRoot);
    const support = join(root, "support"),
      bin = join(root, "bin"),
      marker = join(root, "query-ran");
    await Promise.all([support, bin].map((path) => mkdir(path)));
    const alias = join(privateRoot, "public-alias");
    await symlink(kind === "provider" ? bin : support, alias);
    await writeFile(
      join(bin, "brew"),
      `#!/bin/sh\nif [ "$1" = --prefix ]; then printf '%s\\n' '${alias}'; else /usr/bin/touch '${marker}'; exit 8; fi\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(root, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        nativeTranscripts: true,
        ...nativeAliasConfiguration(kind, alias, bin),
      }),
    );
    expect(loadRuntimeConfiguration(root)).rejects.toThrow("protected data");
    expect(await Bun.file(marker).exists()).toBe(false);
  },
);
function nativeAliasConfiguration(kind: string, alias: string, bin: string) {
  return kind === "required"
    ? { filesystem: { readOnlyRoots: [alias] } }
    : kind === "optional"
      ? { filesystem: { optionalReadOnlyRoots: [alias] } }
      : { environment: { set: { PATH: kind === "provider" ? alias : bin } } };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(configuration: unknown) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sevro-discovery-")),
  );
  roots.push(root);
  await writeFile(join(root, "sevro.json"), JSON.stringify(configuration));
  return root;
}

async function appleToolBin(bin: string) {
  await mkdir(bin);
  await writeFile(join(bin, "python3"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

test("optional runtime roots skip absent directories", async () => {
  const root = await fixture({
    format: "sevro.runtime.v1",
    filesystem: { optionalReadOnlyRoots: ["./missing", "./support"] },
  });
  await mkdir(join(root, "support"));
  const policy = await loadRuntimeConfiguration(root);
  expect(policy?.readOnlyRoots).toEqual([join(root, "support")]);
});

test.each(["lexical", "canonical", "dangling"])(
  "missing optional roots preserve protected boundaries: %s",
  async (kind) => {
    const root = await fixture({ format: "sevro.runtime.v1" });
    const protectedRoot = join(root, "protected"),
      alias = join(root, "alias");
    await mkdir(protectedRoot);
    await symlink(
      kind === "dangling" ? join(protectedRoot, "missing") : protectedRoot,
      alias,
    );
    const missing = join(
      kind === "lexical" ? protectedRoot : alias,
      "absent",
      "child",
    );
    await writeFile(
      join(root, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        filesystem: { optionalReadOnlyRoots: [missing] },
      }),
    );
    let diagnostic = "configuration unexpectedly succeeded";
    try {
      await loadRuntimeConfiguration(root, undefined, [protectedRoot]);
    } catch (cause) {
      diagnostic = (cause as Error).message;
    }
    expect(diagnostic).toContain("protected");
  },
);

test("runtime roots preserve lexical symlink lookup and canonical targets", async () => {
  const root = await fixture({
    format: "sevro.runtime.v1",
    filesystem: { optionalReadOnlyRoots: ["./alias"] },
  });
  await mkdir(join(root, "target"));
  await symlink(join(root, "target"), join(root, "alias"));
  expect((await loadRuntimeConfiguration(root))?.readOnlyRoots).toEqual([
    join(root, "alias"),
    join(root, "target"),
  ]);
});

test("declared PATH discovers bounded Homebrew support from metadata", async () => {
  const root = await fixture({ format: "sevro.runtime.v1" });
  const prefix = join(root, "unusual-brew"),
    bin = join(prefix, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of ["Cellar", "opt", "etc"]) await mkdir(join(prefix, name));
  await writeFile(
    join(bin, "brew"),
    `#!/bin/sh\ncase "$1" in --prefix) printf '%s\\n' '${prefix}';; --cellar) printf '%s\\n' '${join(prefix, "Cellar")}';; *) exit 8;; esac\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(root, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { PATH: bin } },
    }),
  );
  const policy = defined(await loadRuntimeConfiguration(root));
  expect(policy.readOnlyRoots).toContain(join(prefix, "opt"));
  expect(policy.readOnlyRoots).toContain(join(prefix, "etc"));
  expect(policy.readOnlyRoots).toContain(join(prefix, "Cellar"));
  expect(policy.readOnlyRoots).not.toContain(prefix);
});

test.skipIf(process.platform !== "darwin")(
  "declared PATH discovers selected Apple developer tools",
  async () => {
    const root = await fixture({ format: "sevro.runtime.v1" });
    const bin = join(root, "tools"),
      developer = join(root, "chosen-developer");
    await appleToolBin(bin);
    await mkdir(developer);
    await writeFile(
      join(bin, "xcode-select"),
      `#!/bin/sh\nprintf '%s\\n' '${developer}'\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(root, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { set: { PATH: bin } },
      }),
    );
    expect((await loadRuntimeConfiguration(root))?.readOnlyRoots).toContain(
      developer,
    );
  },
);

test("runtime snapshot freezes discovery evidence and skipped roots", async () => {
  const root = await fixture({ format: "sevro.runtime.v1" });
  const frozen: boolean[] = [];
  await runEvaluation({
    projectRoot: root,
    resultsRoot: join(root, "results"),
    runnerBuildDigest: "a".repeat(64),
    projectDigest: "b".repeat(64),
    condition: "passive",
    trialCount: 1,
    passThreshold: 1,
    case: {
      id: "runtime-frozen",
      prompt: "Return ready",
      fixture: { files: {} },
      checks: [],
      requiredEvidence: [],
    },
    host: {
      id: "test.runtime-frozen",
      model: "fixture",
      effort: "none",
      run(request) {
        const policy = defined(request.runtimePolicy);
        const discovery = defined(policy.discovery),
          source = defined(discovery[0]);
        frozen.push(
          Object.isFrozen(discovery),
          Object.isFrozen(source),
          Object.isFrozen(source.readOnlyRoots),
          Object.isFrozen(policy.skippedOptionalReadOnlyRoots),
        );
        return Promise.resolve({ complete: true, finalMessage: "ready" });
      },
    },
    runtimePolicy: {
      format: "sevro.runtime.v1",
      environment: {},
      readOnlyRoots: [],
      discovery: [
        {
          provider: "homebrew",
          executable: "/provider/brew",
          readOnlyRoots: ["/support"],
        },
      ],
      skippedOptionalReadOnlyRoots: ["/missing"],
    },
  });
  expect(frozen).toEqual([true, true, true, true]);
});

test.skipIf(process.platform !== "darwin")(
  "Apple metadata sees declared developer selection",
  async () => {
    const root = await fixture({ format: "sevro.runtime.v1" });
    const bin = join(root, "tools"),
      developer = join(root, "override-developer");
    await appleToolBin(bin);
    await mkdir(developer);
    await writeFile(
      join(bin, "xcode-select"),
      '#!/bin/sh\nprintf "%s\\n" "$DEVELOPER_DIR"\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(root, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { set: { PATH: bin, DEVELOPER_DIR: developer } },
      }),
    );
    expect((await loadRuntimeConfiguration(root))?.readOnlyRoots).toContain(
      developer,
    );
  },
);

test.skipIf(process.getuid?.() === 0)(
  "unreadable optional runtime directories remain errors",
  async () => {
    const root = await fixture({
      format: "sevro.runtime.v1",
      filesystem: { optionalReadOnlyRoots: ["./unreadable"] },
    });
    const directory = join(root, "unreadable");
    await mkdir(directory);
    try {
      for (const mode of [0, 0o100, 0o400]) {
        await chmod(directory, mode);
        expect(await failureMessage(root)).toContain(
          "invalid runtime configuration",
        );
      }
    } finally {
      await chmod(directory, 0o700);
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "missing Apple developer installation is inert",
  async () => {
    const root = await fixture({ format: "sevro.runtime.v1" });
    const bin = join(root, "tools");
    await appleToolBin(bin);
    await writeFile(
      join(bin, "xcode-select"),
      '#!/bin/sh\nprintf "xcode-select: error: Unable to get active developer directory. Use xcode-select to set one.\\n" >&2\nexit 2\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(root, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { set: { PATH: bin } },
      }),
    );
    expect((await loadRuntimeConfiguration(root))?.readOnlyRoots).toEqual([
      bin,
    ]);
  },
);

test.skipIf(process.platform !== "darwin")(
  "unselected Apple tool shims do not import developer metadata",
  async () => {
    const root = await fixture({ format: "sevro.runtime.v1" });
    const tools = join(root, "selected"),
      metadata = join(root, "metadata");
    await mkdir(tools);
    await mkdir(metadata);
    await writeFile(join(tools, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(tools, "python3"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    await writeFile(join(metadata, "xcode-select"), "#!/bin/sh\nexit 8\n", {
      mode: 0o755,
    });
    await writeFile(
      join(root, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { set: { PATH: `${tools}:${metadata}` } },
      }),
    );
    const policy = defined(await loadRuntimeConfiguration(root));
    expect(policy.discovery).toEqual([]);
  },
);

test.skipIf(process.platform !== "darwin")(
  "declared compiler shim discovers selected developer support",
  async () => {
    const root = await fixture({ format: "sevro.runtime.v1" });
    const bin = join(root, "tools"),
      developer = join(root, "developer");
    await mkdir(bin);
    await mkdir(developer);
    await writeFile(join(bin, "clang"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(
      join(bin, "xcode-select"),
      `#!/bin/sh\nprintf '%s\\n' '${developer}'\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(root, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { set: { PATH: bin } },
      }),
    );
    expect((await loadRuntimeConfiguration(root))?.readOnlyRoots).toContain(
      developer,
    );
  },
);

test.skipIf(process.platform !== "darwin").each(["git", "clang", "provider"])(
  "Apple metadata follows selected executable aliases: %s",
  async (kind) => {
    const root = await fixture({ format: "sevro.runtime.v1" });
    const installed = join(root, "installed-apple-tools"),
      selected = join(root, "selected-tools"),
      developer = join(root, "selected-developer");
    await Promise.all(
      [installed, selected, developer].map((path) => mkdir(path)),
    );
    const name = kind === "git" ? "git" : "clang";
    await writeFile(join(installed, name), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    await writeFile(
      join(installed, "xcode-select"),
      `#!/bin/sh\nprintf '%s\\n' '${developer}'\n`,
      { mode: 0o755 },
    );
    const aliasName = kind === "provider" ? "xcode-select" : name;
    await symlink(join(installed, aliasName), join(selected, aliasName));
    await writeFile(
      join(root, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { set: { PATH: `${selected}:${installed}` } },
      }),
    );
    const policy = defined(await loadRuntimeConfiguration(root));
    expect(policy.readOnlyRoots).toContain(developer);
    expect(defined(policy.discovery)[0]?.executable).toBe(
      join(kind === "provider" ? selected : installed, "xcode-select"),
    );
  },
);

async function providerFixture(script: string) {
  const root = await fixture({ format: "sevro.runtime.v1" });
  const bin = join(root, "tools");
  await mkdir(bin);
  await writeFile(join(bin, "brew"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  await writeFile(
    join(root, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { PATH: bin } },
    }),
  );
  return root;
}

async function failureMessage(root: string): Promise<string> {
  try {
    await loadRuntimeConfiguration(root);
  } catch (cause) {
    let current = cause;
    const messages: string[] = [];
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    return messages.join("; ");
  }
  throw new Error("expected runtime configuration failure");
}

test("detected provider failures stop with bounded diagnostics", async () => {
  const root = await providerFixture(
    'printf "private-query-output" >&2\nexit 8',
  );
  const diagnostic = await failureMessage(root);
  expect(diagnostic).toContain("brew --prefix: exit 8");
  expect(diagnostic).not.toContain("private-query-output");
});

test.each(["relative", "/one\n/two"])(
  "metadata providers reject non-path output: %s",
  async (output) => {
    const root = await providerFixture(`printf '%s\\n' '${output}'`);
    expect(await failureMessage(root)).toContain(
      "expected one absolute metadata path",
    );
  },
);

test("a non-executable provider file contributes no installation grants", async () => {
  const root = await providerFixture("exit 8");
  await chmod(join(root, "tools", "brew"), 0o600);
  const policy = defined(await loadRuntimeConfiguration(root));
  expect(policy.discovery).toEqual([]);
  expect(policy.readOnlyRoots).toEqual([join(root, "tools")]);
});

test("cyclic tool aliases fail instead of becoming absent providers", async () => {
  const root = await fixture({ format: "sevro.runtime.v1" });
  const bin = join(root, "tools");
  await mkdir(bin);
  await symlink("brew", join(bin, "brew"));
  await writeFile(
    join(root, "sevro.json"),
    JSON.stringify({
      format: "sevro.runtime.v1",
      environment: { set: { PATH: bin } },
    }),
  );
  expect(await failureMessage(root)).toContain("invalid runtime configuration");
});

test("Homebrew metadata cannot grant its whole installation prefix", async () => {
  const root = await providerFixture("exit 8");
  await writeFile(
    join(root, "tools", "brew"),
    `#!/bin/sh\nprintf '%s\\n' '${root}'\n`,
    { mode: 0o755 },
  );
  expect(await failureMessage(root)).toContain("whole installation prefix");
});

test.each(["cellar", "opt", "etc"])(
  "Homebrew support cannot grant a prefix ancestor: %s",
  async (kind) => {
    const root = await providerFixture("exit 8");
    const parent = join(root, "installation-parent"),
      prefix = join(parent, "brew"),
      cellar = join(root, "independent-cellar");
    await mkdir(prefix, { recursive: true });
    await mkdir(cellar);
    if (kind !== "cellar") await symlink(parent, join(prefix, kind));
    await writeFile(
      join(root, "tools", "brew"),
      `#!/bin/sh\ncase "$1" in --prefix) printf '%s\\n' '${prefix}';; --cellar) printf '%s\\n' '${kind === "cellar" ? parent : cellar}';; *) exit 8;; esac\n`,
      { mode: 0o755 },
    );
    expect(await failureMessage(root)).toContain("whole installation prefix");
  },
);

test("Homebrew supports a bounded independent Cellar", async () => {
  const root = await providerFixture("exit 8");
  const prefix = join(root, "brew"),
    cellar = join(root, "independent-cellar");
  await Promise.all([prefix, cellar].map((path) => mkdir(path)));
  await writeFile(
    join(root, "tools", "brew"),
    `#!/bin/sh\ncase "$1" in --prefix) printf '%s\\n' '${prefix}';; --cellar) printf '%s\\n' '${cellar}';; *) exit 8;; esac\n`,
    { mode: 0o755 },
  );
  const policy = defined(await loadRuntimeConfiguration(root));
  expect(policy.readOnlyRoots).toContain(cellar);
  expect(policy.readOnlyRoots).not.toContain(prefix);
});

test("metadata spawn failures retain their operating system cause", async () => {
  const root = await providerFixture("exit 8");
  await writeFile(
    join(root, "tools", "brew"),
    "#!/sevro-absent-metadata-interpreter\n",
    { mode: 0o755 },
  );
  let caught: unknown;
  try {
    await loadRuntimeConfiguration(root);
  } catch (cause) {
    caught = cause;
  }
  expect((caught as Error).message).toContain("provider unavailable");
  const codes: (string | undefined)[] = [];
  while (caught instanceof Error) {
    codes.push((caught as NodeJS.ErrnoException).code);
    caught = caught.cause;
  }
  expect(codes).toContain("ENOENT");
});

test("metadata provider output is bounded", async () => {
  const root = await providerFixture("/usr/bin/head -c 9000 /dev/zero");
  expect(await failureMessage(root)).toContain("output limit exceeded");
});

test("metadata provider time is bounded", async () => {
  const root = await providerFixture("/bin/sleep 30 & wait");
  const start = performance.now();
  expect(await failureMessage(root)).toContain("timeout exceeded");
  expect(performance.now() - start).toBeLessThan(4500);
}, 6000);

test.each(["${UNDECLARED}", "${bad-name}", "/tmp\n", "/", "./file"])(
  "invalid optional roots remain errors: %s",
  async (path) => {
    const root = await fixture({
      format: "sevro.runtime.v1",
      filesystem: { optionalReadOnlyRoots: [path] },
    });
    await writeFile(join(root, "file"), "regular file");
    expect(await failureMessage(root)).toContain(
      "invalid runtime configuration",
    );
  },
);

test("undeclared ambient PATH cannot discover providers", async () => {
  const root = await fixture({ format: "sevro.runtime.v1" });
  const policy = defined(await loadRuntimeConfiguration(root));
  expect(policy.readOnlyRoots).toEqual([]);
  expect(policy.discovery).toEqual([]);
});

test("optional cyclic aliases remain errors instead of absent roots", async () => {
  const root = await fixture({
    format: "sevro.runtime.v1",
    filesystem: { optionalReadOnlyRoots: ["./cycle/child"] },
  });
  await symlink("cycle", join(root, "cycle"));
  expect(await failureMessage(root)).toContain("invalid runtime configuration");
});

test("Homebrew exit two is fatal even with an Apple absence diagnostic", async () => {
  const root = await providerFixture(
    'printf "Unable to get active developer directory\\n" >&2; exit 2',
  );
  const diagnostic = await failureMessage(root);
  expect(diagnostic).toContain("brew --prefix: exit 2");
  expect(diagnostic).not.toContain("Unable to get active developer directory");
});

test.skipIf(process.platform !== "darwin")(
  "declared Apple selection cannot be skipped by an absence diagnostic",
  async () => {
    const root = await fixture({ format: "sevro.runtime.v1" });
    const bin = join(root, "tools");
    await appleToolBin(bin);
    await writeFile(
      join(bin, "xcode-select"),
      '#!/bin/sh\nprintf "Unable to get active developer directory\\n" >&2\nexit 2\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(root, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: {
          set: { PATH: bin, DEVELOPER_DIR: join(root, "missing") },
        },
      }),
    );
    expect(await failureMessage(root)).toContain(
      "xcode-select --print-path: exit 2",
    );
  },
);

test.skipIf(process.platform !== "linux")(
  "Linux never queries an available Apple metadata provider",
  async () => {
    const root = await fixture({ format: "sevro.runtime.v1" });
    const bin = join(root, "tools"),
      marker = join(root, "apple-query-ran");
    await mkdir(bin);
    await writeFile(join(bin, "clang"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(
      join(bin, "xcode-select"),
      `#!/bin/sh\nprintf queried > '${marker}'\nexit 8\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(root, "sevro.json"),
      JSON.stringify({
        format: "sevro.runtime.v1",
        environment: { set: { PATH: bin } },
      }),
    );
    const policy = defined(await loadRuntimeConfiguration(root));
    expect(policy.discovery).toEqual([]);
    expect(await Bun.file(marker).exists()).toBe(false);
  },
);

test.skipIf(process.platform !== "darwin")(
  "missing declared developer override stays an error",
  async () => {
    const root = await fixture({
      format: "sevro.runtime.v1",
      environment: {
        set: {
          PATH: "/usr/bin:/bin",
          DEVELOPER_DIR: "/sevro-missing-developer",
        },
      },
    });
    expect(await failureMessage(root)).toContain(
      "selected Apple developer directory is missing",
    );
  },
);
