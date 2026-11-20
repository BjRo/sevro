import { HostIsolationError } from "./isolation-common";
import {
  createIsolationPolicy,
  type IsolationPolicy,
  type IsolationOptions,
} from "./policy";
import { prepareMacSandboxCommand } from "./mac-sandbox";
import { prepareLinuxSandboxCommand } from "./linux-sandbox";

/** Select the native policy renderer for evaluator-owned commands. */
export async function prepareIsolatedCommand(
  options:
    | IsolationOptions
    | { policy: IsolationPolicy; argv: string[]; profilePath?: string },
) {
  requireCommand(options.argv);
  const command = await policyCommand(options);
  if (process.platform === "darwin")
    return prepareMacSandboxCommand(
      command.policy,
      command.argv,
      command.profilePath,
    );
  if (process.platform === "linux")
    return prepareLinuxSandboxCommand(command.policy, command.argv);
  throw new HostIsolationError("host isolation is unavailable");
}

function requireCommand(argv: string[]): void {
  if (!argv.length || argv.some((part) => !part))
    throw new HostIsolationError("isolated command must be nonempty");
}

async function policyCommand(
  options: Parameters<typeof prepareIsolatedCommand>[0],
) {
  if ("policy" in options)
    return { ...options, profilePath: options.profilePath };
  return {
    policy: await createIsolationPolicy(options),
    argv: options.argv,
    profilePath: undefined,
  };
}
