import { HostIsolationError, prepareMacSandboxCommand } from "./mac-sandbox";
import { prepareLinuxSandboxCommand } from "./linux-sandbox";

/** Select the native filesystem boundary for evaluator-owned commands. */
export function prepareIsolatedCommand(
  options: Parameters<typeof prepareMacSandboxCommand>[0],
) {
  if (process.platform === "darwin") return prepareMacSandboxCommand(options);
  if (process.platform === "linux") return prepareLinuxSandboxCommand(options);
  throw new HostIsolationError("host isolation is unavailable");
}
