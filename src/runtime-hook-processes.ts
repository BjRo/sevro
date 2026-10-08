import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isRecord } from "./value-guards";

export async function hookExecutions(
  receipts: string,
): Promise<Record<string, unknown>[]> {
  return Promise.all(
    (await readdir(receipts))
      .filter((name) => name.startsWith("call."))
      .map(async (name) => {
        try {
          const value: unknown = JSON.parse(
            await readFile(join(receipts, name), "utf8"),
          );
          return isRecord(value) ? value : { status: "unknown" };
        } catch {
          return { status: "unknown" };
        }
      }),
  );
}

async function processOutput(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(child.stdout).text();
  await child.exited;
  if (Buffer.byteLength(output) > 1024 * 1024)
    throw new Error("hook process ownership exceeds size limit");
  return output;
}

function ownedWrapper(
  execution: Record<string, unknown>,
  receipts: string,
): execution is Record<string, unknown> & { pid: number; wrapper: string } {
  return (
    validProcessId(execution.pid) &&
    typeof execution.wrapper === "string" &&
    dirname(execution.wrapper) === dirname(receipts) &&
    /^hook-[0-9]+\.sh$/.test(basename(execution.wrapper))
  );
}

function validProcessId(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1;
}

function processChildren(table: string, root: number): number[] {
  const pairs = table
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const pending = [root],
    children: number[] = [];
  while (pending.length) {
    const parent = pending.pop();
    const found = pairs
      .filter((pair) => pair[1] === parent)
      .map((pair) => pair[0])
      .filter((pid): pid is number => pid !== undefined);
    pending.push(...found);
    children.push(...found);
  }
  return children;
}

function stopProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* The owned process may already have exited. */
  }
}

/** Stop only processes still bound to a runner-owned private hook wrapper. */
export async function releaseHookProcesses(receipts: string): Promise<void> {
  await writeFile(join(receipts, "stopped"), "stopped\n", { mode: 0o600 });
  for (const execution of await hookExecutions(receipts)) {
    if (!ownedWrapper(execution, receipts)) continue;
    const command = await processOutput([
      "/bin/ps",
      "-p",
      String(execution.pid),
      "-o",
      "command=",
    ]);
    if (!command.includes(execution.wrapper)) continue;
    const children = processChildren(
      await processOutput(["/bin/ps", "-axo", "pid=,ppid="]),
      execution.pid,
    );
    children.reverse().forEach(stopProcess);
    await new Promise((resolve) => setTimeout(resolve, 50));
    stopProcess(execution.pid);
  }
}
