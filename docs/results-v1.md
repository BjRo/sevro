# Result and evidence contract v1

The public CLI accepts `--json`. In that mode stdout contains one JSON result
document and no progress text; diagnostics go to stderr. Human output names
the same execution, grading, and task states. Every result names its schema
version. A run with retained evidence names its absolute evidence path;
pre-run configuration failures can return `null`.

## Separate states

Each trial and aggregate result carries:

| Field              | Values                                               | Meaning                                                                           |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `execution.status` | `completed`, `failed`, `cancelled`, `not_run`        | Whether host execution completed. Dry preparation is `not_run`.                   |
| `grading.status`   | `completed`, `error`, `unavailable`, `not_requested` | Whether required grading completed. A prompt without criteria is `not_requested`. |
| `task.verdict`     | `passed`, `failed`, `not_assessed`                   | Judgment against declared criteria, independent of process completion.            |

With successful host execution and no success criteria, the result is
`completed` / `not_requested` / `not_assessed`. A failed check after successful
execution is `completed` / `completed` / `failed`. An execution failure,
grader error, or unavailable required evidence cannot yield `passed`. A dry
run is `not_run` / `not_requested` / `not_assessed` even when preparation checks
pass. Missing optional cost or usage remains `null` or explicitly incomplete;
it is never converted to zero.

For multiple trials, a case applies its declared pass threshold only after all
required trials are assessed. An unassessed trial makes the case
`not_assessed`; otherwise its pass rate determines `passed` or `failed`. The
run verdict is `failed` if any case fails, otherwise `not_assessed` if any case
is unassessed, otherwise `passed`. A failed run verdict can coexist with an
execution or grading error from another case. Execution and grading aggregate
states expose errors or unavailability instead of averaging them away.

## Exit codes

The CLI uses this precedence when several outcomes occur in one invocation:

| Code  | Outcome                                                                                                                                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | No execution or grading error and no failed assessment. Includes prompt-only and successful dry runs whose task verdict is `not_assessed`; output distinguishes them from `passed`. |
| `1`   | At least one completed task assessment failed.                                                                                                                                      |
| `2`   | Host execution failed.                                                                                                                                                              |
| `3`   | A required grader or extension failed.                                                                                                                                              |
| `4`   | Required evidence was unavailable.                                                                                                                                                  |
| `64`  | Invalid invocation or configuration before a run.                                                                                                                                   |
| `70`  | Internal runner or persistence failure.                                                                                                                                             |
| `130` | Interrupted by SIGINT.                                                                                                                                                              |
| `143` | Interrupted by SIGTERM.                                                                                                                                                             |

Interruption and internal failure outrank execution failure, which outranks
grading error, unavailable evidence, and task failure. The exit code is a
summary; the JSON result retains every affected trial's exact status.

## Identity and provenance

New retained evidence separately identifies:

- the Sevro package name, exact version and build digest, or an explicit local
  checkout revision and dirty-patch digest;
- the evaluated project's revision and dirty-patch digest, without assuming it
  is the runner checkout;
- the extension ID, version, source/content digest, configuration digest,
  negotiated protocol and capabilities, active graders, replaced defaults,
  selected task-verdict policy, and requested and applied instrumentation;
- each candidate, semantic grader, and advisory judge's exact host, model,
  effort, raw-result provenance, and observation completeness; and
- the declared passive/enforced condition, case inputs, check definitions,
  required evidence, and execution mode.

The evaluation identity includes evaluator version and content, configuration,
grader selection and replacements, required evidence, instrumentation, host
routes, case inputs, fixture, checks, trial count, and threshold. A comparison
cannot claim matched conditions when those dimensions differ. Timestamps,
temporary paths, run IDs, and output locations do not change evaluation
identity. Historical Darrow artifacts keep their original schema version;
fields absent from them remain unknown unless explicit historical provenance
establishes the value.
The pre-run instrumentation digest binds the requested list and its expected
application. Trial evidence records the host-reported application; a mismatch
fails execution and cannot be treated as a matched successful condition.
When a task-verdict policy is selected, each trial records its recommendation
separately from the final task verdict. A missing recommendation cannot produce
a passing assessment.
An optional advisory review records `completed`, `failed`, or `not_run` with
its structured assessment, independent usage, and raw-response provenance.
Its recommendation and any reviewer failure do not change execution, grading,
task verdict, or exit code. A failure to retain review evidence remains a
persistence error.

[`identity-v1.md`](identity-v1.md) defines the canonical digest and each
comparison dimension.

The versioned machine-readable contracts are
[`cli-result-v1.schema.json`](../schemas/cli-result-v1.schema.json) and
[`run-evidence-v1.schema.json`](../schemas/run-evidence-v1.schema.json). A
schema-valid document still needs engine validation for cross-record equality,
canonical identity computation, path containment, secret redaction, and
referenced artifact availability.

The engine persists each completed trial atomically before fixture cleanup.
An interrupted or failed run keeps completed trials plus an explicit partial
attempt or diagnostic record. Failed persistence is an internal error and
cannot be presented as a successful assessment.
