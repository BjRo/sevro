# Runtime startup measurements for issue 30

The matched synthetic native-host benchmark reduced candidate setup plus the
controlled participant from 14.37–14.92 seconds to 6.20–6.66 seconds. The response-only
grading host call, including its separate native startup, fell from 13.49–15.03
seconds to 5.45–5.65 seconds. These are runner-boundary measurements with synthetic
model responses, not measurements of API latency or live model quality.

## Reproduction and conditions

Run the same maintained [benchmark harness](../../../scripts/benchmark-runtime-startup.ts)
against an unchanged checkout of `c205482b25d4d52a395c70434f2b392f6acfb279` and this
candidate, sequentially on one machine:

```sh
bun scripts/benchmark-runtime-startup.ts /absolute/baseline /tmp/before.json
bun scripts/benchmark-runtime-startup.ts /absolute/candidate /tmp/after.json
```

The retained [before](before.json) and [after](after.json) observations used
macOS arm64, Bun 1.3.13, Codex CLI 0.162.1, the same synthetic plugin/response case,
`synthetic-candidate` and `synthetic-semantic` model labels, and `low` effort.
There were three candidate/semantic repetitions in each process, with a 32 MiB,
2,049-entry public dependency tree. Every role received a fresh private home and
native plugin installation. The first candidate used a cold verified-snapshot
cache; repetitions two and three reused the policy. OS filesystem caches were
uncontrolled and are not described as cold. Baseline ran before candidate;
order effects and three repetitions limit generalization.

The harness wraps the same production functions and process boundaries without
changing their arguments or timeout. Only external model output is replaced by a
fixed event stream. The native plugin installer and `codex sandbox` remain real.
This fixture does not claim live skill invocation; separate native integration
coverage and consumer smoke own that evidence. Timings overlap: runtime and
sandbox phases are inside candidate/grading-host totals, and plugin commands are
inside plugin installation. Do not sum both levels. The `grading` measurement surrounds the semantic host
call with its response-only policy; it excludes engine fixture preparation,
verdict parsing, and extension bookkeeping.

## Observed timings

All values below are milliseconds, in repetition order.

| Boundary                                     | Before                   | After                 |
| -------------------------------------------- | ------------------------ | --------------------- |
| Configuration fingerprint (once)             | 262                      | 299                   |
| Candidate runtime preparation                | 1,969 / 1,357 / 1,273    | 721 / 431 / 443       |
| Candidate hook dependency preparation        | 1,226 / 1,465 / 1,235    | No invocation         |
| Fresh native plugin installation             | 385 / 141 / 143          | 188 / 141 / 143       |
| Candidate sandbox probes, summed per role    | 10,938 / 11,032 / 11,622 | 5,490 / 5,404 / 5,448 |
| Controlled participant process               | 27 / 29 / 39             | 27 / 27 / 24          |
| Candidate total                              | 14,925 / 14,369 / 14,666 | 6,659 / 6,199 / 6,257 |
| Semantic runtime preparation                 | 1,174 / 1,236 / 2,262    | Under 1 each          |
| Semantic hook dependency preparation         | 1,105 / 1,087 / 1,363    | No invocation         |
| Semantic sandbox probes, summed per role     | 10,855 / 10,803 / 11,032 | 5,548 / 5,360 / 5,365 |
| Controlled semantic response process         | 28 / 44 / 27             | 29 / 28 / 28          |
| Grading host total, including native startup | 13,495 / 13,534 / 15,030 | 5,647 / 5,454 / 5,460 |

The probe count fell from two to one per fresh role. Candidate dependency
materialization reuses immutable verified bytes after its first capture, and
response-only grading no longer materializes implicit candidate dependencies.
Configuration hashing remains necessary for identity. Fresh-install warm timings
were essentially unchanged; no plugin-install speedup is claimed. Participant
and semantic outputs are synthetic controls, so no API/model saving is claimed.

## Startup deadline diagnosis

A separate authenticated Darrow baseline using Codex 0.162.1 and `gpt-6-luna`
with medium effort failed before participant execution: the first sandbox probe
hit its 10-second deadline at 10,004.8 ms. A seedless control retained the same
tool declarations and also timed out at 10,004.2 ms. With only the diagnostic
probe deadline increased to 60 seconds, both original full-policy probes passed
at 10,649.1 and 10,690.4 ms. Participant execution was deliberately withheld in
that diagnostic. A minimal-policy control without tool grants or seeds passed
at 5,372.8 and 5,681.1 ms.

Raw diagnostic records are retained for the [original timeout](baseline-timeout.jsonl),
[seedless timeout](seedless-timeout.jsonl), [full policy with diagnostic deadline](full-policy-diagnostic.jsonl),
and [minimal policy](minimal-policy-diagnostic.jsonl). The maintained
[diagnostic preload](../../../scripts/diagnose-codex-startup.ts) records bounded
phase timing/errors and withholds app-server participant execution. To reproduce
against an explicit checkout, set `SEVRO_DIAGNOSTIC_SOURCE_ROOT` and
`SEVRO_DIAGNOSTIC_PHASE_FILE`, then use a CLI wrapper running:

```sh
bun --preload /absolute/candidate/scripts/diagnose-codex-startup.ts /absolute/baseline/src/cli.ts "$@" --runner-checkout-root /absolute/baseline
```

Point Darrow's `SEVRO_PACKAGE_BIN` at that wrapper and run:

```sh
bun evals/runner/run.ts --harness codex --owner-evaluation passive --skill create-commit --case create-commit-conventional-format --model gpt-6-luna --effort medium --trials 1 --jobs 1 --threshold 1 --results-root /absolute/outside-project-results --output /absolute/selection.json
```

For the deadline control, additionally set `SEVRO_DIAGNOSTIC_TIMEOUT_MS=60000`.
For runtime controls, append `-- --runtime-config-file /absolute/runtime.json`:
seedless keeps the original policy except `runtime.seedDirectories=[]`; minimal
keeps only `format`, `nativeTranscripts: true`, and `hooks.nativeGoal: true`.
The original diagnostic used the same wrappers with fixed paths; the retained
preload makes those paths explicit through environment variables.

These one-off controls locate the failure in native sandbox startup and show
that dependency copying is not necessary for the timeout. Declared tool grants
increase observed startup on this machine. They do not establish the exact
native CLI mechanism or a general policy-size scaling law. The product now uses
a bounded 60-second preflight; the measured saving comes from eliminating the
second invocation and repeated preparation, not from increasing that deadline.
The unavailable baseline participant, activation, and grading evidence remain
unavailable rather than being assigned successful outcomes.

## Snapshot and copy-on-write assessment

The production snapshot owns verified bytes only in runner memory, keyed by the
policy's seed descriptor. Candidate, peer, checker, and hook writable files never
alias it. First capture must match the configured digest; later source changes
do not change that snapshot. Regression coverage changes candidate files and the
operator source between trials and verifies that the next trial still receives
the original bytes. Executable modes, internal-link dereferencing, empty
directories, source protection, offline environment, and role separation remain
checked.

The benchmark also exercised `COPYFILE_FICLONE_FORCE` on a 32 MiB file. It
succeeded in about one millisecond in both runs, and changing the destination
left the source length unchanged. This establishes local copy-on-write support,
not portable availability or an immutable directory snapshot. The current
in-memory snapshot deliberately avoids a persistent cache path and its cleanup,
source-mutation, and cross-process trust requirements. Native clone reuse is not
implemented; ordinary materialization works on filesystems without cloning.
Retained policies retain their verified bytes until garbage collection, up to
the existing per-seed bounds. This memory tradeoff should be measured separately
for substantially larger dependency sets.

## Native installation reuse assessment

Every actual native installation in both benchmark runs produced configuration
containing its private home and fixture workspace paths, as retained in the
`installation-assets` observations. Native install receipts bind an
`installedPath` inside that particular home's plugin cache; production verifies
it before accepting explicit invocation. Authorized hook wrappers also bind the
private runtime, sandbox profile, and execution receipt directory.

A separate [native cache-only reuse experiment](plugin-template-assessment.json)
installed a local synthetic plugin into a fresh credential-free home. The native
registration wrote `source_type = "local"` and the original absolute marketplace
path; the receipt contained the original private `installedPath`. After copying
only `plugins/cache` into a second fresh home, `codex plugin list --json` returned
empty `installed` and `available` arrays. To reproduce, use fresh `HOME` and
`CODEX_HOME`, run `codex plugin marketplace add /absolute/market --json` and
`codex plugin add probe@sevro-assessment --json`, copy `plugins/cache` to another
fresh home, and list there. Paths in the raw record use `<assessment>` for the
throwaway root; no credential file was present.

An entire installed-home template therefore cannot be replayed into a new trial
without rewriting and reverifying those identities, isolating credentials and
configuration, and obtaining evidence for the new installed paths. Reusing
just package files would still require native registration and receipt checks.
For the measured fixture, warm fresh installation costs about 140 ms versus
roughly 5.4 seconds for one sandbox startup. No template reuse is implemented.
Fresh authentication/configuration, native registration and plugin installation,
receipt validation, hook projection, the combined preflight, and native
invocation evidence remain per-request work. Fresh-install integration coverage
is retained.

## Authenticated consumer smoke

The [bounded consumer summary](consumer-smoke.json) records Darrow revision
`34606ad9e1952b7f4e9c56befa446c18e1a2eb5d`, with no tracked consumer edits. The
candidate's explicit `tdd-explicit-invocation` case passed execution, shell and
semantic grading, and complete native explicit-invocation activation. Candidate
and semantic routes used Codex 0.162.1, `gpt-6-luna`, medium effort, one trial,
one job, and threshold one:

```sh
SEVRO_CHECKOUT=/absolute/candidate bun evals/runner/run.ts --harness codex --owner-evaluation passive --skill tdd --case tdd-explicit-invocation --model gpt-6-luna --effort medium --semantic-check-model gpt-6-luna --semantic-check-effort medium --trials 1 --jobs 1 --threshold 1 --results-root /absolute/outside-project-results --output /absolute/selection.json
```

The earlier implicit `create-commit-conventional-format` smoke completed
execution and grading on the candidate, including its three shell checks, but
failed the expected HEAD-change assertion. Its fixture mounted the backend under
`.agents` without plugin manifests required by the launcher; the participant
refused the commit. Activation stayed unavailable. The unchanged baseline had
failed that case before participant execution at sandbox preflight. These
outcomes are retained honestly; neither the fixture failure nor the later
single-trial success establishes a matched live latency comparison or repeated
model reliability. Private native transcripts and credentials remain outside Git.
