import { afterAll } from "bun:test";
import type { Subprocess } from "bun";
import capture from "./capture.cjs";
import { existsSync } from "node:fs";
import { join } from "node:path";

afterAll(() => capture?.dump("complete"));
const originalSpawn = Bun.spawn;
Reflect.set(Bun, "spawn", function (...args: unknown[]) {
  // Reflect.apply erases the overloaded return type. This invokes the original
  // factory with unchanged arguments and returns the same Subprocess object.
  const child = Reflect.apply(
    originalSpawn,
    Bun,
    args,
  ) as unknown as Subprocess;
  const kill = child.kill.bind(child);
  child.kill = function (signal?: NodeJS.Signals | number) {
    if (
      capture &&
      (signal === "SIGKILL" || signal === 9) &&
      existsSync(join(capture.directory, `${child.pid}.started.json`))
    ) {
      capture.writeRecord(capture.directory, `${child.pid}.killed.json`, {
        ...capture.identity,
        pid: child.pid,
        ppid: process.pid,
        signal: "SIGKILL",
      });
    }
    kill(signal);
  };
  return child;
});
