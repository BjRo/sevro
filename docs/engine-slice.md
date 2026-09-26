# First engine slice

`runEvaluation` accepts a resolved inline or repository fixture case and an injected host
adapter. It is an internal API while the host isolation adapters, extension
lifecycle, and public CLI are being built. The synthetic adapter in the tests
exercises the actual engine path without a model call.

The engine validates check configuration and fixture paths before execution.
Repository sources must be declared under an explicit source root, clean, and
committed. Each trial clones the fixed commit without hardlinks or remotes.
The source revision contributes to fixture identity; a changed or dirty source
is refused before it can silently alter a trial. Submodules and preparation
artifacts targeting `.git/` are refused.
For each trial it creates a separate workspace, asks the adapter to run the
prompt, grades its bounded final message, writes the raw-message reference and
trial artifact, and only then removes the workspace. An adapter exception
becomes an execution failure; a later failure leaves earlier trial artifacts
intact. A failed trial checkpoint retains its fixture and cannot produce a
successful result.
Dry preparation still validates the case, runs extension preparation, creates
the fixture, and retains a trial record. It skips the host and all grading,
records `not_run` / `not_requested` / `not_assessed`, and has a separate
evaluation identity from an executed run.

The final `run.json` follows the v1 evidence schema and contains separate
execution, grading, and task states. It records the exact runner build and
project content digests supplied by the caller, plus a computed evaluation
identity. Missing optional usage stays `null` and incomplete. Results storage
is explicit and independent of the project root. A packaged runner records its
package identity without Git; a private development checkout reads its own Git
revision and hashes tracked and untracked changes for the local runner
identity. A Git-backed project records its own revision and dirty content;
a project without a commit retains unknown Git provenance alongside the
explicit caller-supplied project content digest. An optional independent
run-state root holds an active record and a checkpoint pointing to each
retained trial. An evaluation-identity claim uses a short SQLite transaction
to admit one verified process owner. A live owner blocks an equivalent run;
an unverifiable owner is refused, while a confirmed dead owner is marked
interrupted and its prior attempt files are kept before a new claim starts.
The active record reaches `complete` only after final run evidence is written.
Process identity includes the PID, host, and operating-system start time to
protect against PID reuse. If start time cannot be verified, the run stops
before host execution.
The CLI passes SIGINT and SIGTERM through an abort signal. A cooperating host
stops its work; the engine retains completed trial artifacts, records the
cancelled trial, finalizes the active attempt as `interrupted`, and exits 130
or 143 after writing run evidence. An adapter that ignores cancellation cannot
be force-stopped by the injected-host interface.

The host can return bounded, namespaced observations alongside its final
message and bounded evidence artifacts. The engine retains them before
extension grading. It passes observations and artifact file references to the
extension without copying artifact bytes into run JSON. Missing or partial
required host evidence makes grading unavailable; malformed host evidence
fails execution. The engine also accepts shell checks when the caller supplies
protected source roots. They run through the macOS outer sandbox after host
execution, and their exit observations are retained with the trial. An
unavailable boundary produces a grading error rather than a passing check.
Semantic checks use a separately supplied host identity and an empty grader
workspace. A complete candidate final message is sent to that route with the
declared propositions. The engine requires one bounded verdict per check,
retains the raw response and grader artifacts outside the fixture, and records
the route and per-check observations. Missing candidate output makes semantic
checks unavailable; failed or malformed grader output makes grading an error.
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
retention.
An explicitly selected extension task-verdict policy receives its policy ID
during `evaluate` and must return a recommendation. The engine uses that
recommendation only when execution and grading completed with all required
evidence available. It retains the selected policy and trial recommendation;
missing recommendations are grading errors. An explicitly replaced built-in
grader still has its declaration validated, but its checks do not run or count
toward the task verdict. At least one declared extension check must take its
place. The selection enters comparison identity and retained evidence.
An extension may request a negotiated host instrumentation capability during
`prepare`. The engine checks the host-declared capability and whether it
changes execution before starting a trial. Execution-changing requests are
refused in a passive condition. The host receives the request and must report
exactly what it applied; a mismatch or an unconfirmed enforced condition fails
execution. Run and trial evidence retain requested and applied instrumentation
separately. The bundled Codex adapter advertises no instrumentation capabilities.

Additional host adapters and host-specific instrumentation implementations
remain in progress.
