import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defined,
  expectUnknown,
  parseCheckpoint,
  parseCliResult,
  parseRunEvidence,
  string,
} from "../../fixtures/assertions";
import { createFixture, invoke } from "../../fixtures/cli-fixtures";
import { createTemporaryFixtures } from "../../fixtures/filesystem";

const roots: string[] = [];
const { temporaryFixture, cleanupTemporaryFixtures } =
  createTemporaryFixtures(roots);
afterEach(cleanupTemporaryFixtures);

const fixture = createFixture(roots);

test("CLI supplies a canonical candidate workspace", async () => {
  const { args, caseFile } = await fixture();
  const host = join(caseFile, "..", "canonical-host.ts");
  await writeFile(
    host,
    `import { realpath } from "node:fs/promises";
export default {
  id: "sevro.host.synthetic", model: "synthetic-v1", effort: "none",
  async run({ workspace }) {
    return {
      finalMessage: "ready", complete: true,
      observations: [{ id: "sevro.test.workspace", source: "sevro.host.synthetic", completeness: "complete", data: { path: workspace, canonicalPath: await realpath(workspace) } }],
    };
  },
};\n`,
  );
  args[args.indexOf("--adapter-module") + 1] = host;
  const run = await invoke(args);
  expect(run.code, run.stderr).toBe(0);
  expect(run.result.execution.status).toBe("completed");
  const evidence = parseRunEvidence(
    await readFile(defined(run.result.evidencePath), "utf8"),
  );
  const observation = defined(evidence.trials[0]).observations.find(
    (item: { id: string }) => item.id === "sevro.test.workspace",
  );
  expect(defined(observation).data.path).toBeString();
  expect(defined(observation).data.path).toBe(
    defined(observation).data.canonicalPath,
  );
});

function lockedFixturePath(location: string) {
  return location === "child" ? 'join(workspace, "locked")' : "workspace";
}

function lockedFixtureMode(location: string) {
  return location === "readable root" ? "0o500" : "0o000";
}

test.each(["child", "root", "readable root"])(
  "CLI removes a permission-locked candidate directory (%s)",
  async (location) => {
    const { args, caseFile } = await fixture();
    const host = join(caseFile, "..", "locked-host.ts");
    const external = join(caseFile, "..", "external");
    await mkdir(external);
    const externalFile = join(external, "retained.txt");
    await writeFile(externalFile, "external retained\n");
    await chmod(externalFile, 0o400);
    await chmod(external, 0o500);
    const externalMode = (await stat(external)).mode;
    const externalFileMode = (await stat(externalFile)).mode;
    await writeFile(
      host,
      `import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
export default {
  id: "sevro.host.synthetic", model: "synthetic-v1", effort: "none",
  async run({ workspace }) {
    const locked = ${lockedFixturePath(location)};
    if (locked !== workspace) await mkdir(locked);
    await writeFile(join(locked, "value.txt"), "candidate output\\n");
    await symlink(${JSON.stringify(external)}, join(locked, "external"), "junction");
    await chmod(locked, ${lockedFixtureMode(location)});
    return {
      finalMessage: "ready", complete: true,
      observations: [{ id: "sevro.test.workspace", source: "sevro.host.synthetic", completeness: "complete", data: { path: workspace } }],
    };
  },
};\n`,
    );
    args[args.indexOf("--adapter-module") + 1] = host;
    let workspace = "";
    try {
      const run = await invoke(args);
      expect(run.code, run.stderr).toBe(0);
      const evidence = parseRunEvidence(
        await readFile(defined(run.result.evidencePath), "utf8"),
      );
      expectUnknown(evidence.result).toEqual(run.result);
      workspace = string(
        defined(
          defined(evidence.trials[0]).observations.find(
            (item: { id: string }) => item.id === "sevro.test.workspace",
          ),
        ).data.path,
      );
      expect(workspace).toBeString();
      expect(workspace.length).toBeGreaterThan(0);
      expect(existsSync(workspace)).toBe(false);
      expect((await stat(external)).mode).toBe(externalMode);
      expect((await stat(externalFile)).mode).toBe(externalFileMode);
      expect(await readFile(externalFile, "utf8")).toBe("external retained\n");
    } finally {
      if (workspace && existsSync(workspace)) {
        await chmod(workspace, 0o700);
        if (existsSync(join(workspace, "locked")))
          await chmod(join(workspace, "locked"), 0o700);
        await rm(workspace, { recursive: true, force: true });
      }
      await chmod(external, 0o700);
      await chmod(externalFile, 0o600);
    }
  },
);

test("CLI accepts an independent run-state root", async () => {
  const { args } = await fixture();
  const runStateRoot = await temporaryFixture(
    join(tmpdir(), "sevro-cli-state-"),
  );

  const run = await invoke([...args, "--run-state-root", runStateRoot]);
  expect(run.code).toBe(0);
  const active = parseCheckpoint(
    await readFile(
      join(runStateRoot, "active", `${run.result.runId}.json`),
      "utf8",
    ),
  );
  expect(active.status).toBe("complete");
  expect(active.artifactPath).toBe(defined(run.result.evidencePath));
  const invalid = await invoke([...args, "--run-state-root", ""]);
  expect(invalid.code).toBe(64);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`CLI ${signal} cancels host work and retains interruption evidence`, async () => {
    const { args, caseFile } = await fixture();
    const projectRoot = join(caseFile, "..");
    const ready = join(projectRoot, "host-ready");
    const waitingAdapter = join(projectRoot, "waiting-adapter.ts");
    await writeFile(
      waitingAdapter,
      `import { writeFile } from "node:fs/promises";
export default {
  id: "synthetic", model: "synthetic-v1", effort: "none",
  async run({ signal }) {
    const cancelled = new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new Error("cancelled"));
      else signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    cancelled.catch(() => {});
    await writeFile(${JSON.stringify(ready)}, "ready");
    return cancelled;
  },
};
`,
    );
    const command = args.map((value, index) =>
      args[index - 1] === "--adapter-module" ? waitingAdapter : value,
    );
    const proc = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    try {
      const deadline = Date.now() + 5000;
      while (!(await Bun.file(ready).exists())) {
        if (Date.now() > deadline) throw new Error("host did not start");
        await Bun.sleep(20);
      }
      proc.kill(signal);
      const [stdout, code] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      expect(code).toBe(signal === "SIGINT" ? 130 : 143);
      const result = parseCliResult(stdout);
      expect(result.execution.status).toBe("cancelled");
      expect(result.exitCode).toBe(signal === "SIGINT" ? 130 : 143);
      const active = parseCheckpoint(
        await readFile(
          join(projectRoot, "results", "active", `${result.runId}.json`),
          "utf8",
        ),
      );
      expect(active.status).toBe("interrupted");
      expect(await Bun.file(defined(result.evidencePath)).exists()).toBeTrue();
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });
}
