# Rust fixture setup deadline evidence

This slice preserves the real two-minute fixture setup deadline through the
public `sevro run` command. The
[extension setup contract](../extension-protocol-v1.md#negotiation-and-operations) requires
setup to finish before host execution and requires failure to remain unassessed.
The test uses an actual negotiated extension, Git repository fixture, setup
process and owned descendant. Product time and process APIs are unchanged.

## Independent TypeScript observation

The external probe `/tmp/sevro-setup-deadline-baseline.mjs` ran the unmodified
TypeScript CLI with a native dry selection. Its setup launched a shell descendant
that published its own PID and waited for a release file. The parent published
both PIDs, its private HOME and its actual workspace only after that descendant
was ready. The probe verified that both processes were alive and that the
descendant belonged to the setup process group before waiting for Sevro.

An external 150-second watchdog bounded the probe; it did not change Sevro's
120-second deadline. Sevro exited naturally after 120,601.6 ms, or 120,007.9 ms
after causal readiness. The observed result was:

```json
{
  "format": "sevro.cli-result.v1",
  "runId": null,
  "execution": { "status": "not_run" },
  "grading": { "status": "not_requested" },
  "task": { "verdict": "not_assessed" },
  "exitCode": 70,
  "evidencePath": null,
  "cases": [],
  "diagnostic": {
    "code": "sevro.runner.error",
    "message": "fixture setup timed out"
  }
}
```

The private setup HOME was removed, the descendant no longer existed, and
releasing its sentinel produced no late write. The native host was not invoked.
The source repository retained its original README, clean status and revision
`f4d351b20b90e67f9e9092777856c0135110b023`. No latest-result pointer appeared.

The admitted workspace remained available. The probe's provisional assertion
that this directory would be removed failed after the observation was saved;
that assertion is not a product failure or TDD red. Inspection confirmed deliberate
retention: [trial preparation](../../src/evaluation/resources.ts) marks its
reserved workspace retained before [materialization](../../src/fixtures/create.ts),
which leaves reserved workspaces to their owner. The retained workspace's owner
record also reported `state: "retained"`. Raw stdout, stderr and measured
observations remain in
`/private/tmp/sevro-setup-deadline-baseline-Qn71bi/`.

## Durable Rust boundary

[The public CLI test](../../crates/sevro/tests/run_repository/setup.rs) reproduces
the same setup and readiness handshake. It waits through the actual product
deadline, with a separate 150-second watchdog and unconditional cleanup of only
its own processes and retained fixture. It checks the exact JSON result, elapsed
time, retained workspace README, private HOME removal, unchanged source, absent
host invocation and absent latest-result pointer.

The descendant must be absent or terminated, including an unreaped zombie on
platforms where orphan reaping is delayed. Releasing its sentinel after CLI exit
must produce no write. This checks actual termination separately from elapsed
time and the CLI diagnostic.

## Sequential observations

- Red — `cargo test -p sevro --test run_repository setup::times_out_setup_after_two_minutes_and_terminates_its_descendant --locked -- --exact`:
  one test failed after 120.66 seconds because the timed-out workspace README
  no longer existed. The preceding assertions passed for the real deadline,
  exact failure result, descendant termination, private HOME removal, source
  preservation and absent host execution.
- Green — `cargo test -p sevro --test run_repository setup::times_out_setup_after_two_minutes_and_terminates_its_descendant --locked -- --exact`:
  one test passed in 126.04 seconds after the materialization retention repair.

The repair removes materialization's failure-path directory deletion. This
matches the TypeScript CLI's reservation boundary for materialization failures;
it does not special-case the timeout diagnostic. The existing 120-second wait,
process-group termination and private HOME cleanup remain unchanged. Existing
successful-trial cleanup assertions and nonzero setup failure checks remain
regression targets. No earlier oracle was changed.

## Final checks and limits

- `cargo test -p sevro --test run_repository --locked`: 37 passed, with no ignored
  or filtered cases, in 128.79 seconds. This includes the real deadline again,
  successful fixture cleanup, nonzero setup failure, preparation artifact
  failures and cancellation retention.
- `cargo clippy -p sevro --test run_repository --locked -- -D warnings`: passed.
  The initial attempt encountered an unrelated concurrent `graders.rs`
  collapsible-if lint; its owner repaired it before the passing rerun.
- `rustfmt --check --edition 2024 --config skip_children=true crates/sevro/src/run/fixtures.rs crates/sevro/tests/run_repository/setup.rs`:
  passed.
- `bunx prettier --check docs/specs/rust-tdd-setup-deadline.md` and
  `bun run check:docs`: passed.

This slice does not add run-state checkpoints, workspace ownership metadata or
expiry cleanup. It preserves the observed failed directory while keeping
private setup state and process cleanup mandatory. These local checks do not
claim full port acceptance or replace either platform's complete CI gates.
