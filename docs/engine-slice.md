# First engine slice

`runEvaluation` accepts a resolved inline-fixture case and an injected host
adapter. It is an internal API while the host isolation adapters, extension
lifecycle, and public CLI are being built. The synthetic adapter in the tests
exercises the actual engine path without a model call.

The engine validates check configuration and fixture paths before execution.
For each trial it creates a separate workspace, asks the adapter to run the
prompt, grades its bounded final message, writes the raw-message reference and
trial artifact, and only then removes the workspace. An adapter exception
becomes an execution failure; a later failure leaves earlier trial artifacts
intact. A failed trial checkpoint retains its fixture and cannot produce a
successful result.

The final `run.json` follows the v1 evidence schema and contains separate
execution, grading, and task states. It records the exact runner build and
project content digests supplied by the caller, plus a computed evaluation
identity. Missing optional usage stays `null` and incomplete. Results storage
is explicit and independent of the project root. A packaged runner records its
package identity without Git; a private development checkout reads its own Git
revision and hashes tracked and untracked changes for the local runner
identity. An optional independent run-state root holds an active record and a
checkpoint pointing to each retained trial. The record reaches `complete`
only after final run evidence is written. These records track progress but do
not yet enforce exclusive process ownership or abandoned-run recovery.

This slice accepts output checks with no additional required host evidence.
It also accepts shell checks when the caller explicitly supplies protected
source roots. They run through the macOS outer sandbox after host execution,
and their exit observations are retained with the trial. An unavailable
boundary produces a grading error rather than a passing check.
An optional negotiated extension can add declared checks. The engine calls its
`prepare` method before host execution and its `evaluate` method for each
trial. It retains extension identity, configuration digest, protocol,
capabilities, grader selection, check evidence references, and metrics.
Missing declared extension checks remain unavailable; extension errors cannot
become a passing assessment. Inline preparation artifacts are decoded, checked
against their SHA-256 digests, mounted into each fixture, and retained outside
it for later inspection. Source-reference artifacts resolve only through a
caller-declared ID-to-file-URL map under an explicit case source root. Their
bytes receive the same size, path, and digest checks before mounting and
retention. Instrumentation, task-policy replacement, and other host evidence
remain unsupported and are rejected before execution.

The future host adapters must provide fixture isolation, credential
protection, and verified condition observations before the CLI can expose
model-backed runs.
