import { afterEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runCodexProcess } from "../../src/hosts/codex-process";
import { runClaudeProcess } from "../../src/hosts/claude-process";
import { defined, record } from "../fixtures/assertions";
import { peerEvents } from "../fixtures/native-host-fixtures";
import { createWorkspace } from "../fixtures/native-host-fixtures";

const testDirectory = join(import.meta.dir, "..");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const workspace = createWorkspace(roots);

const nativeProcessRunners = {
  Codex: runCodexProcess,
  Claude: runClaudeProcess,
};

test("Codex drains stderr while retaining a raw prefix cut inside a UTF-8 sequence", async () => {
  const root = await workspace();
  const result = await runCodexProcess({
    argv: [
      process.execPath,
      "-e",
      `await new Promise(resolve => process.stderr.write(
        Buffer.concat([Buffer.alloc(65535, 120), Buffer.from("€"), Buffer.alloc(200000, 121)]), resolve
      ));
      process.stdout.write("complete");`,
    ],
    cwd: root,
    env: {},
    timeoutMs: 2000,
  });
  expect(result.code).toBe(0);
  expect(result.out).toBe("complete");
  expect(result.stderrTruncated).toBe(true);
  expect(Buffer.from(result.stderr)).toEqual(
    Buffer.concat([Buffer.alloc(65535, 120), Buffer.from([0xe2])]),
  );
});

async function processBoundaryOptions(
  stream: "stdout" | "stderr",
  size: number,
  overflow: boolean,
) {
  const root = await workspace();
  return {
    argv: [
      process.execPath,
      join(testDirectory, "fixtures/host-app-server.ts"),
      `process-${stream}`,
      String(size),
      overflow ? "stay-open" : "exit",
    ],
    cwd: root,
    env: {},
    timeoutMs: 2000,
  };
}

test.each(["Codex", "Claude"] as const)(
  "native process pre-aborted %s request refuses child admission",
  async (host) => {
    const options = await processBoundaryOptions("stdout", 1, false);
    const controller = new AbortController();
    controller.abort();
    expect(
      nativeProcessRunners[host]({ ...options, signal: controller.signal }),
    ).rejects.toThrow(`${host} run cancelled`);
    expect(
      readFile(join(options.cwd, ".git/peer-events.jsonl")),
    ).rejects.toThrow(/ENOENT/);
  },
);

test.each([
  ["Codex", "stdout", 8 * 1024 * 1024, false],
  ["Codex", "stdout", 8 * 1024 * 1024, true],
  ["Claude", "stdout", 8 * 1024 * 1024, false],
  ["Claude", "stdout", 8 * 1024 * 1024, true],
  ["Claude", "stderr", 64 * 1024, false],
  ["Claude", "stderr", 64 * 1024, true],
] as const)(
  "native process %s %s byte boundary %s; overflow=%s",
  async (host, stream, limit, overflow) => {
    const options = await processBoundaryOptions(
      stream,
      limit + Number(overflow),
      overflow,
    );
    const pending = nativeProcessRunners[host](options);
    if (overflow) {
      const diagnostic =
        host === "Codex"
          ? "Codex event stream exceeds the size limit"
          : "Claude process output exceeds its limit";
      expect(pending).rejects.toThrow(diagnostic);
    } else {
      const result = await pending;
      expect(result.code).toBe(0);
      const output = stream === "stdout" ? result.out : record(result).err;
      expect(output).toBe("x".repeat(limit));
    }
    const events = await peerEvents(options.cwd);
    expect(defined(events[0]).event).toBe("process-started");
    const pid = Number(defined(events[0]).pid);
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH|No such process/);
  },
);
