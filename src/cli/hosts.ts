import type { HostAdapter } from "../engine";
import { createClaudeHost } from "../hosts/claude";
import { createCodexHost } from "../hosts/codex";
import { codexAgentConcurrency } from "../hosts/codex-configuration";
import { InvocationError, nativeRoutes, type Invocation } from "./invocation";
import { loadHost } from "./loading";

export async function selectedConcurrency(
  invocation: Invocation,
  configRoot: string,
): Promise<number | null> {
  return nativeRoutes({ ...invocation, claude: undefined }).length
    ? codexAgentConcurrency(configRoot)
    : null;
}

export async function candidateHost(
  invocation: Invocation,
  agentConcurrencyLimit: number | null,
): Promise<HostAdapter> {
  if (invocation.codex)
    return retainExecutable(
      createCodexHost({ ...invocation.codex, agentConcurrencyLimit }),
      invocation.codex.binary,
    );
  if (invocation.claude)
    return retainExecutable(
      createClaudeHost(invocation.claude),
      invocation.claude.binary,
    );
  if (!invocation.adapterModule)
    throw new InvocationError("missing --adapter-module or --host");
  return loadHost(invocation.adapterModule);
}

export async function secondaryHost(
  module: string | undefined,
  codex: Invocation["semanticCodex"],
  agentConcurrencyLimit: number | null,
): Promise<HostAdapter | undefined> {
  if (module) return loadHost(module);
  if (codex)
    return retainExecutable(
      createCodexHost({ ...codex, agentConcurrencyLimit }),
      codex.binary,
    );
  return undefined;
}

function retainExecutable(host: HostAdapter, binary: string): HostAdapter {
  return {
    ...host,
    configuration: { ...host.configuration, "sevro.host.executable": binary },
  };
}
