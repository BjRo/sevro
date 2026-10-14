import type { HostAdapter } from "../engine";
import { createClaudeHost } from "../hosts/claude";
import { createCodexHost } from "../hosts/codex";
import { codexAgentConcurrency } from "../hosts/codex-configuration";
import { InvocationError, type Invocation } from "./invocation";
import { loadHost } from "./loading";

export async function selectedConcurrency(
  invocation: Invocation,
  configRoot: string,
): Promise<number | null> {
  return [
    invocation.codex,
    invocation.semanticCodex,
    invocation.advisoryCodex,
  ].some(Boolean)
    ? codexAgentConcurrency(configRoot)
    : null;
}

export async function candidateHost(
  invocation: Invocation,
  agentConcurrencyLimit: number | null,
): Promise<HostAdapter> {
  if (invocation.codex)
    return createCodexHost({ ...invocation.codex, agentConcurrencyLimit });
  if (invocation.claude) return createClaudeHost(invocation.claude);
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
  if (codex) return createCodexHost({ ...codex, agentConcurrencyLimit });
  return undefined;
}
