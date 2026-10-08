import { defined } from "./fixtures/assertions";
import { test, expect } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostIsolationError,
  macSandboxProfile,
  prepareMacSandboxCommand,
} from "../src/hosts/mac-sandbox";
import { evaluationProtectedRoots } from "../src/hosts/isolation-roots";
import { protectedWorktrees } from "../src/hosts/protected-worktrees";
import {
  cleanupTemporaryFixtures,
  fixtureGit,
  repositoryFixture,
} from "./quality-fixtures/fixture-preparation-tools";

const invalidSandboxCommands: {
  label: string;
  change: Partial<Parameters<typeof prepareMacSandboxCommand>[0]>;
  diagnostic: string;
}[] = [
  {
    label: "empty argv",
    change: { argv: [] },
    diagnostic: "isolated command must be nonempty",
  },
  {
    label: "empty argument",
    change: { argv: ["/usr/bin/true", ""] },
    diagnostic: "isolated command must be nonempty",
  },
  {
    label: "no protected roots",
    change: { protectedRoots: [] },
    diagnostic: "isolated command needs protected roots",
  },
  {
    label: "relative workspace",
    change: { workspace: "workspace" },
    diagnostic: "isolation paths must be absolute",
  },
  {
    label: "relative private state",
    change: { privateStateRoot: "state" },
    diagnostic: "isolation paths must be absolute",
  },
  {
    label: "relative protected root",
    change: { protectedRoots: ["source"] },
    diagnostic: "isolation paths must be absolute",
  },
];
test.each(invalidSandboxCommands)(
  "sandbox command refuses $label before accessing any declared path",
  ({ change, diagnostic }) => {
    if (process.platform !== "darwin") return;
    expect(
      prepareMacSandboxCommand({
        argv: ["/usr/bin/true"],
        workspace: "/unused/workspace",
        protectedRoots: ["/unused/source"],
        privateStateRoot: "/unused/state",
        ...change,
      }),
    ).rejects.toThrow(diagnostic);
  },
);

test("sandbox private state must stay outside an otherwise disjoint workspace", async () => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(join(tmpdir(), "sevro-sandbox-state-"));
  try {
    const workspace = join(root, "workspace");
    const source = join(root, "source");
    await mkdir(workspace);
    await mkdir(source);
    await writeFile(join(source, "original.txt"), "original source");
    expect(
      prepareMacSandboxCommand({
        argv: ["/usr/bin/true"],
        workspace,
        protectedRoots: [source],
        privateStateRoot: join(workspace, "state"),
      }),
    ).rejects.toThrow("sandbox state is inside the candidate workspace");
    expect(await readFile(join(source, "original.txt"), "utf8")).toBe(
      "original source",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["relative", "missing"])(
  "evaluation isolation refuses a %s explicitly declared protected root",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "sevro-isolation-root-"));
    try {
      expect(
        evaluationProtectedRoots({
          workspace: root,
          projectRoot: root,
          resultsRoot: root,
          additionalRoots: [
            kind === "relative"
              ? "relative-source"
              : join(root, "missing-source"),
          ],
        }),
      ).rejects.toThrow(
        kind === "relative"
          ? "evaluation protected roots must be absolute"
          : "evaluation protected root is unreadable",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("protection retains an existing checkout when a registered linked worktree has been removed", async () => {
  const source = await repositoryFixture();
  try {
    const linked = join(source.root, "linked");
    await fixtureGit(
      source.repository,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      linked,
    );
    expect(await protectedWorktrees(source.repository)).toContain(
      await realpath(linked),
    );
    await rm(linked, { recursive: true });
    expect(await protectedWorktrees(source.repository)).toEqual([
      await realpath(source.repository),
    ]);
    expect(await readFile(join(source.repository, "README.md"), "utf8")).toBe(
      "baseline\n",
    );
  } finally {
    await cleanupTemporaryFixtures();
  }
});

test("protection refuses ordinary invalid repository metadata rather than treating it as no repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "sevro-protection-metadata-"));
  try {
    await writeFile(join(root, ".git"), "not a Git metadata reference\n");
    expect(protectedWorktrees(root)).rejects.toThrow(
      "protected repository worktrees are unavailable",
    );
    expect(await readFile(join(root, ".git"), "utf8")).toBe(
      "not a Git metadata reference\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("profile denies reads and writes of each protected root", () => {
  const profile = macSandboxProfile(["/private/source", "/private/evidence"]);
  expect(profile).toContain('(deny file-read* (subpath "/private/source"))');
  expect(profile).toContain('(deny file-write* (subpath "/private/evidence"))');
  expect(macSandboxProfile(["/private/source"], true)).toContain(
    "(deny network*)",
  );
  expect(() => macSandboxProfile([])).toThrow(HostIsolationError);
  expect(() => macSandboxProfile(["/bad\npath"])).toThrow(/control character/);
});
test("outer sandbox permits the fixture but denies protected source", async () => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(join(tmpdir(), "sevro-sandbox-test-"));
  const workspace = join(root, "workspace");
  const source = join(root, "source");
  const state = join(root, "state");
  try {
    await Bun.write(join(workspace, "visible.txt"), "visible");
    await Bun.write(join(source, "secret.txt"), "secret");
    const command = await prepareMacSandboxCommand({
      argv: ["/bin/cat", join(workspace, "visible.txt")],
      workspace,
      protectedRoots: [source],
      privateStateRoot: state,
    });
    const profilePath = defined(defined(command.argv[2]));
    expect(await readFile(profilePath, "utf8")).toContain(source);
    const allowed = Bun.spawn(command.argv, { stdout: "pipe", stderr: "pipe" });
    expect(await new Response(allowed.stdout).text()).toBe("visible");
    expect(await allowed.exited).toBe(0);
    await command.release();
    const deniedCommand = await prepareMacSandboxCommand({
      argv: ["/bin/cat", join(source, "secret.txt")],
      workspace,
      protectedRoots: [source],
      privateStateRoot: state,
    });
    const denied = Bun.spawn(deniedCommand.argv, {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await denied.exited).not.toBe(0);
    await deniedCommand.release();
    const writeCommand = await prepareMacSandboxCommand({
      argv: ["/bin/mkdir", join(source, "created")],
      workspace,
      protectedRoots: [source],
      privateStateRoot: state,
    });
    const writeAttempt = Bun.spawn(writeCommand.argv, {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await writeAttempt.exited).not.toBe(0);
    await writeCommand.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("workspace cannot overlap a protected root", async () => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(join(tmpdir(), "sevro-sandbox-overlap-"));
  try {
    expect(
      prepareMacSandboxCommand({
        argv: ["/usr/bin/true"],
        workspace: root,
        protectedRoots: [root],
        privateStateRoot: join(root, "state"),
      }),
    ).rejects.toThrow(/candidate workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("a verified peer path remains denied after its fixture is removed", async () => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(join(tmpdir(), "sevro-sandbox-removed-peer-"));
  const workspace = join(root, "workspace");
  const peer = join(root, "peer");
  try {
    await Bun.write(join(workspace, "visible.txt"), "visible");
    await Bun.write(join(peer, "temporary.txt"), "peer");
    const canonicalPeer = await realpath(peer);
    await rm(peer, { recursive: true });
    expect(
      prepareMacSandboxCommand({
        argv: ["/bin/true"],
        workspace,
        protectedRoots: [canonicalPeer],
        privateStateRoot: join(root, "state"),
      }),
    ).rejects.toThrow();
    const command = await prepareMacSandboxCommand({
      argv: ["/usr/bin/true"],
      workspace,
      protectedRoots: [canonicalPeer],
      protectedRootsCanonical: true,
      privateStateRoot: join(root, "state"),
    });
    const proc = Bun.spawn(command.argv, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, stderr).toBe(0);
    await command.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
