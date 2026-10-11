# Temporary workspace cleanup validation

Current temporary workspace retention is defined in the
[results contract](results-v1.md). The historical cleanup observations below
predate the 24-hour failure-inspection policy.

## Workspace isolation and retention regression slices

The public programmatic seam is `runEvaluation`, exported by `src/engine.ts`.
The scenarios use real files and subprocesses, synthetic candidate/grading
adapters, and native sandbox execution. Each red below preceded its product
change; green used the same literal command. The two preflight nonzero-exit
diagnostic cases have the separate fixture caveat recorded below.

Red — `bun test tests/engine.test.ts --test-name-pattern 'engine shell isolation hides a sibling created after sandbox launch'`: the late sibling was accessible and the run exited 1.

Green — `bun test tests/engine.test.ts --test-name-pattern 'engine shell isolation hides a sibling created after sandbox launch'`: the sibling remained unreadable and unwritable while the current workspace remained usable.

Red — `bun test tests/codex-host.test.ts --test-name-pattern 'Codex sandbox profile does not grow with stale temporary case folders'`: adding 200 stale folders increased deny entries from 428 to 628.

Green — `bun test tests/codex-host.test.ts --test-name-pattern 'Codex sandbox profile does not grow with stale temporary case folders'`: the deny-entry count remained unchanged.

Red — `bun test tests/engine.test.ts --test-name-pattern 'engine retains a failed candidate workspace while preserving saved evidence'`: the failed candidate workspace had been deleted.

Green — `bun test tests/engine.test.ts --test-name-pattern 'engine retains a failed candidate workspace while preserving saved evidence'`: the workspace and its contents remained available, alongside saved evidence.

Red — `bun test tests/engine.test.ts --test-name-pattern 'engine startup expires inactive failed workspaces after a day without deleting evidence'`: the expired failure workspace remained present.

Green — `bun test tests/engine.test.ts --test-name-pattern 'engine startup expires inactive failed workspaces after a day without deleting evidence'`: startup removed it after 24 hours and left the saved evidence bytes unchanged.

Red — `bun test tests/codex-host.test.ts --test-name-pattern 'Codex preflight timeout retains termination evidence'`: after the real 60-second deadline, the diagnostic was only `host execution did not complete`.

Green — `bun test tests/codex-host.test.ts --test-name-pattern 'Codex preflight timeout retains termination evidence'`: the diagnostic named the preflight timeout and evidence retained exit 137 with `SIGKILL`.

Red — `bun test tests/engine.test.ts --test-name-pattern 'engine retains the semantic workspace when grading fails'`: grading failure removed its workspace and diagnostic file.

Green — `bun test tests/engine.test.ts --test-name-pattern 'engine retains the semantic workspace when grading fails'`: both remained available for inspection.

Red — `bun test tests/engine.test.ts --test-name-pattern 'engine retains a failed candidate workspace while preserving saved evidence'`: the follow-up assertion could not find a workspace-location observation in saved evidence.

Green — `bun test tests/engine.test.ts --test-name-pattern 'engine retains a failed candidate workspace while preserving saved evidence'`: the observation identified the retained candidate workspace.

Red — `bun test tests/engine-quality.test.ts --test-name-pattern 'records a failed advisory host without accepting its passing assessment'`: the failed advisory workspace had been deleted.

Green — `bun test tests/engine-quality.test.ts --test-name-pattern 'records a failed advisory host without accepting its passing assessment'`: it remained inspectable without changing the candidate's passing verdict.

The candidate and semantic nonzero-exit diagnostic fixtures initially used
`env` instead of the public runtime policy's `environment` field. That fixture
was corrected during implementation, so their initial failures are not claimed
as valid test-first evidence. A temporary copy of the corrected tests was then
run against unchanged `main` sources: both reproduced the generic diagnostics.
On the implementation, `bun test tests/codex-host.test.ts --test-name-pattern 'preflight failure retains its cause and process evidence'`
passed both cases and verified the stage, exit code, signal, and retained stderr.

Additional passing checks covered a live workspace older than a day, ownership
metadata hidden from sandboxed commands, and stderr overflow retaining exactly
64 KiB with a truncation flag. These deterministic local observations establish
macOS behavior; full acceptance and Linux isolation are checked by source CI.

Red — `bun test tests/claude-host.test.ts --test-name-pattern 'Claude managed workspaces remain usable under the namespace policy'`: the generated native policy blocked the current managed workspace and execution remained unassessed.

Green — `bun test tests/claude-host.test.ts --test-name-pattern 'Claude managed workspaces remain usable under the namespace policy'`: the native CLI fixture accepted the current-workspace exception and bounded file-tool policy. This is native configuration-contract coverage, not a live model trial.

Red — `bun test tests/cli.test.ts --test-name-pattern 'CLI curated shell grading leaves repository caches to tools'`: the shell cache check failed because absolute `mkdir -p` could not stat the namespace parent.

Green — `bun test tests/cli.test.ts --test-name-pattern 'CLI curated shell grading leaves repository caches to tools'`: parent metadata traversal was usable while directory listing and sibling access remained denied in the isolation regression.

## Historical permission-locked fixture cleanup

The Darrow extraction comparison exposed a cleanup difference: its legacy
fixture destroyer removes permission-locked directories, while Sevro retained
them after a completed trial. Sevro now restores owner access inside completed
candidate workspaces when needed. It clears their contents after trial evidence
is retained, keeps empty reservations until active peers drain, and then removes
the completed roots. Directory traversal uses link metadata and skips symbolic
links; external targets retain their permissions and contents.

## Public CLI regression slices

The public seam is `sevro run --case-file ... --adapter-module ...`, as documented
in [Development CLI](development-cli.md). Each controlled adapter uses real
filesystem permissions and returns its workspace path as a bounded observation.
The test reads retained public evidence and verifies that the workspace is gone.
A preliminary internal-engine test was diagnostic only; it is not part of this
TDD trace and was removed before implementation.

Red — `bun test tests/cli.test.ts --test-name-pattern 'CLI removes a permission-locked candidate directory'`: completed evidence existed, but the mode-000 child directory kept the workspace present.

Green — `bun test tests/cli.test.ts --test-name-pattern 'CLI removes a permission-locked candidate directory'`: the workspace was removed and retained evidence still agreed with the CLI result.

Red — `bun test tests/cli.test.ts --test-name-pattern 'permission-locked candidate directory \(root\)'`: a mode-000 workspace root remained present after completion.

Green — `bun test tests/cli.test.ts --test-name-pattern 'permission-locked candidate directory \(root\)'`: the workspace root was removed after evidence retention.

Red — `bun test tests/cli.test.ts --test-name-pattern 'permission-locked candidate directory \(readable root\)'`: the readable mode-500 root lacked write access and remained present.

Green — `bun test tests/cli.test.ts --test-name-pattern 'permission-locked candidate directory \(readable root\)'`: restoring owner write access allowed cleanup; the external link target's mode and bytes were unchanged.

Each final example also links to an external directory with a read-only file.
All three check that its directory mode, file mode, and file contents stay intact.
These are deterministic filesystem and lifecycle checks, with no live model call.

## Final source gates

`bun test` passed all 243 tests and 1399 assertions across 38 files in 93.83
seconds. The gate includes parallel admission, peer isolation, cancellation,
failed persistence, extension lifecycle, and generated/repository fixture tests.
`bun run typecheck` and `bun run format:check` pass.
The full log and subsequent installed-archive checks are retained under
`/Users/bjro/.darrow/issue95-fixture-cleanup/`. The tests ran on macOS with Bun
1.3.13; they do not establish another platform or native model route.

## Canonical workspace follow-up

Darrow's private fixture builder also checked that its returned path was
canonical. An initial diagnostic assertion in the cleanup examples exposed
Sevro's logical temporary-directory alias; those diagnostic additions were
removed before the isolated regression. The public canonical-workspace test
records the operating system's `realpath` through a controlled host and compares
it with the received workspace in retained evidence. The full source gate above
predates this follow-up.

The public CLI contract was clarified before implementation. Candidate and
semantic workspace allocations now resolve the new directory through `realpath`
before reservation, preparation, or host execution.

Red — `bun test tests/cli.test.ts --test-name-pattern 'CLI supplies a canonical candidate workspace'`:
exit `1`; the received `/var/...` path differed from the operating system's
`/private/var/...` path. One test failed with four assertions in 222 milliseconds.

Green — `bun test tests/cli.test.ts --test-name-pattern 'CLI supplies a canonical candidate workspace'`:
exit `0`; one test and four assertions passed in 228 milliseconds after the fix.

The final `bun test` gate passed 244 tests and 1403 assertions across 38 files in
94.77 seconds. Typecheck and formatting pass. The source log is retained at
`/Users/bjro/.darrow/issue95-fixture-mounting/sevro-full-gate.log`. These remain
deterministic macOS/Bun checks, without a live model or additional platform claim.
