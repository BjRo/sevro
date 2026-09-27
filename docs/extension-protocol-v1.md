# Extension protocol v1

This is the target public contract for `sevro.extension.v1`. Extensions are
explicitly configured development tools. Installing one does not change
built-in grading or grant it control of fixture isolation, execution,
persistence, or cleanup. The executable is trusted by the operator; a process
boundary alone is not a sandbox.

[`extension-v1.schema.json`](../schemas/extension-v1.schema.json) validates the
versioned request and response shapes. The engine also validates request IDs,
negotiated capabilities, path containment, decoded content, and the source and
configuration digests at runtime.

## Transport

The runner receives an extension command as an argv array and never interprets
it through a shell. For each method it starts a fresh process, writes exactly
one UTF-8 JSON request to stdin, closes stdin, and reads exactly one UTF-8 JSON
response from stdout before process exit. The request and response are each
limited to 8 MiB. Extra stdout, malformed JSON, an unmatched request ID, a
nonzero exit, timeout, or an oversized message is a protocol error. Stderr is
diagnostic only, bounded to 64 KiB in retained evidence; it cannot supply a
result. The runner cancels the extension process group on interruption.

Every request has this envelope. `describe` uses the stable
`sevro.discovery.v1` bootstrap protocol; subsequent methods use the selected
extension protocol:

```json
{
  "protocol": "sevro.discovery.v1",
  "id": "request-1",
  "method": "describe",
  "params": {}
}
```

A response echoes `protocol`, `id`, and `method`, then supplies exactly one of
`result` or `error`:

```json
{
  "protocol": "sevro.discovery.v1",
  "id": "request-1",
  "method": "describe",
  "result": {
    "extension": { "id": "example.policy", "version": "1.0.0" },
    "protocols": ["sevro.extension.v1"],
    "requiredCapabilities": [],
    "optionalCapabilities": [],
    "graders": [],
    "taskVerdictPolicies": []
  }
}
```

An error has `{ "code": "namespaced.code", "message": "bounded text" }`.
An error response, process failure, or invalid response never becomes a
successful grade. The engine retains the method, error class, and bounded
diagnostic without copying secrets or unbounded extension output.

## Negotiation and operations

The engine calls `describe` first through the discovery protocol. The
extension identifies its stable ID and version, supported protocol versions,
required and optional capability IDs,
grader IDs it supplies, and task-verdict policy IDs it supplies. Capability IDs
are namespaced strings. The engine chooses one compatible protocol, verifies
all required capabilities against its own and the selected host's capability
registry, and records the negotiated set. An unknown required capability is an
error. Unknown optional capabilities remain unavailable and cannot be used.
The engine, not the extension, classifies whether instrumentation changes host
execution. Future extension protocols still need a compatible discovery
response or an explicitly selected bridge; an unsupported protocol cannot be
guessed from a failed extension call.

`resolve` receives the selected project root, selectors, and extension
configuration. It returns neutral case descriptions with stable IDs, prompts,
fixture and built-in check declarations, required evidence declarations, and
namespaced extension data. Paths in case descriptions are resolved and
validated by the engine against the declared project and case-source roots.
The extension cannot add a hidden source root by returning an arbitrary path.
Fixtures may contain inline files, a declared clean repository source, or a
bounded generated Git history. Both Git fixture kinds support optional
working-tree files, staged paths, committed scaffolding, and bounded Git
hooks. Sevro validates overlay paths, refuses symlinks and repository metadata
in repository clones, installs hooks after its own commits, and includes these
declarations in fixture identity. Repository-specific policy and
custom setup remain in the extension.

An extension that negotiates `sevro.fixture.setup` may return an optional
`fixtureSetup` from `prepare`. It names an absolute executable and bounded argv,
plus optional environment variables. Sevro runs that trusted command once per
trial in the Git fixture after source history and working-tree files are built,
before extension artifacts are mounted or the host starts. The command is never
interpreted through a shell by Sevro; an extension may explicitly select a
shell executable. `{{sevro.project}}` and `{{sevro.workspace}}` in environment
values resolve to the declared roots at execution time. The symbolic values and
command enter fixture and comparison identity, while retained configuration
records only their digest. Setup has a two-minute limit, inherits no credential
environment variables, and its output is discarded. Failure or interruption
stops the run before host execution; it cannot become a passing assessment.
Absolute path references in this protocol use `file:///` URLs so Windows and
Unix hosts share one serialized form. Fixture-relative paths use `/` separators
and cannot escape their declared root.

`prepare` receives one resolved case, the chosen host and capabilities, the
configured passive or enforced condition, and extension data. It returns
fixture preparation artifacts and requested instrumentation IDs with
parameters. The engine validates these requests before host execution and
passes them to the host. It rejects unknown or unsupported IDs and rejects any
execution-changing instrumentation in a passive trial. Requested and applied
instrumentation are recorded separately. Host adapters declare supported IDs
and whether each changes execution. A requested ID must be among the
negotiated capabilities. The host receives the validated request and must
report the same applied IDs and parameters; a mismatch fails execution. An
execution-changing request also requires the host to confirm an enforced
condition. Instrumentation parameters enter retained evidence and must not
contain secrets.

An artifact for a generated or cloned Git fixture may set `gitExclude: true`.
Sevro mounts its verified bytes, adds only that exact artifact path to the
fixture's `.git/info/exclude`, and retains the flag in artifact evidence and
fixture identity. The flag is invalid for a non-Git fixture. It lets evaluator
assets such as project skills remain visible to the host without appearing as
candidate changes in Git status checks.
An artifact may set `executable: true` to install its verified bytes with owner
execute permission. The flag enters fixture identity and retained artifact
references; absent or false leaves the file readable without execute permission.

`evaluate` receives one completed or failed trial's bounded host observations,
their source and completeness, built-in check results, artifact references,
and the extension's namespaced case data. It returns namespaced checks and
metrics. A check is `passed`, `failed`, or `unavailable`; it names the evidence
used. A missing required observation remains unavailable. The extension may
return a task-verdict recommendation only when an explicitly configured
task-verdict policy names that extension policy. In that case, `evaluate`
receives `selectedTaskVerdictPolicy` and must return a recommendation. The
engine uses it only for a completed trial with completed grading and available
required evidence. It retains the selected policy and each trial's
recommendation. An omitted recommendation is a grading error. A policy may
change a failed check's task verdict, but cannot conceal execution failure,
grader error, or unavailable required evidence.
Host adapters can supply additional namespaced observations. The engine bounds
and retains those records, then passes them to `evaluate`. Required observation
IDs must be present with `complete` evidence before a task can pass.
Host adapters can also supply bounded evidence artifacts. The engine persists
their bytes outside the candidate workspace before `evaluate`, then passes
file URLs and digests through the existing artifact references. A required host
artifact must be present before a task can pass.

The methods are stateless. Every request carries the configuration and prior
extension data it needs. The runner verifies extension identity and source
digest for the run; a changed executable or configuration cannot silently
continue the same run.

The session client in [`extension-session.ts`](../src/extension-session.ts)
implements discovery, `resolve`, `prepare`, and `evaluate` as separate process
calls. Its caller declares the extension source-file closure; the client also
includes the executable and hashes that closure before discovery and before
and after later calls. The redacted configuration and command argv affect the
configuration digest. Command argv must not contain credentials. A passing
extension check must cite available, complete evidence. The engine now accepts
inline and declared clean-repository cases with additive extension checks, runs `prepare` before the host,
and persists check outcomes, evidence references, and metrics before fixture
cleanup. It applies and retains bounded inline preparation artifacts after
checking their path and digest. Source references require a caller-declared
ID-to-file-URL map under a case source root and receive the same checks.
The bundled Codex host currently advertises no instrumentation capabilities.

## Grading and replacement

The runner provides built-in shell, regex, JSON/schema, combined output,
semantic-output, and
advisory quality graders. A run can use those without any extension. An
extension's graders add checks and metrics by default. The run configuration
must explicitly name each built-in grader it replaces, or explicitly select
one advertised task-verdict policy. Unknown or duplicate replacement IDs are
errors. Retained evidence lists every active grader, its identity and route,
and any replaced default.

An extension may also return namespaced `domainOutcomes` with passed, failed,
or unavailable status, evidence references, and bounded domain data. Sevro
validates their evidence and retains them separately from task checks. They do
not change the task verdict. Older evidence without this field leaves domain
outcomes unknown.

When a built-in grader is selected for replacement, the engine validates its
declared check configuration but does not run its checks. It requires at least
one declared, advertised extension check, and grades those checks instead.
Unselected built-in checks stay active. The replacement list enters extension
configuration and evaluation identity; evidence retains the selected defaults
and omits them from active graders and trial check results. A replaced shell or
semantic grader does not require its usual isolation or host route because it
does not execute.

An extension cannot replace execution status, grading status, or the evidence
availability rules. It cannot turn an error or missing required evidence into
a successful task assessment. A prompt without success criteria produces
execution evidence and a task verdict of `not_assessed`.

## Lifecycle

The engine orders each trial as follows:

1. Negotiate protocol and capabilities; resolve the case.
2. Prepare the fixture and extension inputs; validate instrumentation against
   the host and passive/enforced condition.
3. Execute or resume the host and collect bounded observations.
4. Run built-in checks, then extension grading, then compute separate
   execution, grading, and task states.
5. Persist complete trial evidence before fixture cleanup.

On cancellation or failure, completed trials remain persisted and partial
attempts retain an explicit incomplete or diagnostic state. The engine owns
process-group cancellation and cleanup even when an extension fails. A dry
run records preparation but no observed behavioral success.
