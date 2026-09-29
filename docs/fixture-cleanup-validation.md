# Permission-locked fixture cleanup

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
