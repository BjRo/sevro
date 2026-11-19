/**
 * The contract between evaluation and native hosts.
 *
 * A host adapter receives one resolved case prompt, workspace and policy, and
 * returns a bounded host result. Hosts, evidence validation and case loading
 * depend on this contract instead of on evaluation orchestration.
 */
export {
  EvaluationConfigurationError,
  HostExecutionFailure,
  type HostAdapter,
  type HostResult,
  type ResolvedCase,
} from "./host-contract";
