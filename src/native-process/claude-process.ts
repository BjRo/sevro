import { runHostProcess, type HostProcessOptions } from "./process-lifecycle";

export async function runClaudeProcess(
  options: Omit<HostProcessOptions, "host" | "input" | "phase">,
) {
  const result = await runHostProcess({ ...options, host: "Claude" });
  return {
    code: result.code,
    out: result.out,
    err: Buffer.from(result.stderr).toString("utf8"),
  };
}
