/**
 * The contract between evaluation and native hosts.
 *
 * A host adapter receives one resolved case prompt, workspace and policy, and
 * returns a bounded host result. The resolved case includes its fixture
 * declaration shapes. Hosts, fixtures, evidence validation and case loading
 * depend on this contract instead of on evaluation orchestration.
 */
export {
  EvaluationConfigurationError,
  HostExecutionFailure,
  type GeneratedFixture,
  type HostAdapter,
  type HostResult,
  type RepositoryFixture,
  type ResolvedCase,
} from "./host-contract";
