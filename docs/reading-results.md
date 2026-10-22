# Read results and evidence

Read all three states before calling an evaluation successful:

| Example                    | Execution | Grading       | Task         |
| -------------------------- | --------- | ------------- | ------------ |
| Declared checks satisfied  | completed | completed     | passed       |
| A check violated           | completed | completed     | failed       |
| Prompt without checks      | completed | not_requested | not_assessed |
| Successful dry preparation | not_run   | not_requested | not_assessed |

Exit `0` includes successful prompt-only/dry runs. It does not alone prove a
passing assessment. [Results v1](results-v1.md) defines errors, interruption,
aggregation, and exit-code precedence.

`--json` writes one versioned result to stdout; diagnostics use stderr.
`evidencePath` names retained run evidence, or is `null` for pre-run failures.
Completed trial evidence is saved under `--results-root` before cleanup.
Do not assume a run-directory name or publish private host artifacts.

Human output lists each trial, failed/unavailable check
reasons, measured candidate duration, unknown/known usage and retained paths.
Preparation/candidate/grading/evidence progress appears on stderr. Stage completion
means the attempt ended; read the three result states to determine its outcome.
See the [evaluation workflow](evaluation-workflow.md) for the complete progression.

## Interpret skill exposure

In retained Codex `sevro.host.skill-activations` observations, read
`data.skillExposures` alongside `data.collectionStatus`. A skill may have `full`
or `partial` exposure even when collection is incomplete. `none` means no
exposure was detected within a complete collection's scope; `unknown` means
collection gaps prevent that conclusion. `ambiguous` means identical bodies
could not identify a named skill. Missing fields in older evidence remain
unknown.

Full exposure establishes that a tool caller received the complete prepared
body, not that the model followed it. Partial exposure establishes only
recognizable fragments. Cases that accept partial exposure must say so in
their extension policy. The separate `sevro.host.skill-exposure-claims`
observation supports positive exposure checks without treating gaps as absence
or first selection. [Native host evidence](native-hosts.md#skill-activation-evidence)
defines the fields and limits; Claude's native skill-tool evidence has a
different scope. Task verdicts and existing activation requirements retain their
current meaning.

## Summarize runs

```sh
sevro report --json --result-file /absolute/path/sevro-result.json
```

`sevro report --latest` uses the most recently retained CLI result in
`<cwd>/.sevro/results`. Add
`--results-root ./other-results` to select another root. Dry/failed runs may be
latest; a pre-run error does not replace it. CLI `--result-file` also accepts
cwd-relative paths. Missing result or referenced evidence is an error, never
a fabricated row.

The command assumes [Sevro is on `PATH`](installing.md#make-the-command-available).
For a contributor checkout, use `bun src/cli.ts` in place of `sevro`.
[Report v1](report-v1.md) defines fields and limits. Missing cost, usage, or
duration is unknown, not zero. Advisory recommendations remain independent
of the task verdict.

## Prune retained results

Run `sevro prune` to permanently delete older retained evidence. With no options,
it keeps the newest **10 results** under `<cwd>/.sevro/results`. Each completed
attempt counts separately, including repeated evaluations, dry runs, failures,
and interrupted runs that retained a CLI result.

```sh
sevro prune
sevro prune --results-root ./other-results --keep 5
sevro prune --older-than 30d
sevro prune --latest
```

Choose at most one explicit policy. `--keep` accepts a positive safe integer;
`--latest` is equivalent to `--keep 1`. `--older-than` accepts a positive integer
followed by `ms`, `s`, `m`, `h`, `d`, or `w` (milliseconds through weeks). It
deletes results strictly older than that duration at invocation. Age and newest
ordering use each retained `result.json` file's modification time; copying or
editing that file can change its retention age. Equal timestamps sort by
absolute result-directory path, ascending. Relative roots resolve from the
invoking directory.

Pruning finds retained result directories inside the selected root, including
nested `attempts` trees, validates results and their colocated run evidence, and
removes each selected result's entire directory. Directories without a retained
`result.json` are not themselves deleted. Active and unrecognized ownership states
are excluded from the retention count. Descendant directory links are not
followed; linked result, evidence, ownership and lock files are refused. The
selected root itself may be a directory alias. Invalid policies or unreadable,
malformed, inconsistent or unsafe retained inputs return exit `64` with a
diagnostic. Validation completes before any result deletion or latest update.

Pruning and CLI result publication serialize access to the root. Before deleting
evidence, pruning atomically points `latest.json` at the newest remaining
completed result, or removes the index if none remain. `sevro report --latest`
and explicit reports for surviving results keep working; reports naming deleted
results fail. An empty or missing results root is a successful no-op. Ownership
coordination metadata, partial attempts without CLI results, temporary fixtures,
and a separate `--run-state-root` remain outside evidence pruning.

### Remove native transcript bundles

Use `--native-transcripts` to permanently remove captured native bundles while
keeping every result, recorded hash, observation, and other artifact:

```sh
sevro prune --native-transcripts
sevro prune --native-transcripts --older-than 30d
sevro prune --native-transcripts --keep 5
sevro report --latest
```

Without a policy, this mode removes bundles from all completed results. With
`--keep 5`, it preserves the newest five results' bundles and removes bundles
from older results. `--latest` preserves the newest result's bundles;
`--older-than` removes bundles only from results older than the given duration.
Age, ordering, root selection, active-run protection, and input validation follow
the rules above. The mode includes candidate, semantic, and advisory bundles.

`result.json`, `run.json`, trial evidence, and `latest.json` stay unchanged.
Before removing bytes, pruning atomically saves a private
`native-transcripts-pruned.json` receipt beside `run.json`. Keep that receipt
with the evidence: reports require it to distinguish intentional pruning from
missing evidence. Reports show retained and pruned bundle counts while preserving
the original verdicts and measurements. Pruned native bytes cannot be decoded
or recovered from hashes. Repeating the command safely resumes interrupted
deletions; ordinary whole-result pruning still works afterward.

## Compare carefully

[Identity v1](identity-v1.md) binds inputs, evaluator content, host/model/effort,
conditions, and fixtures. Matching labels alone do not establish matched
conditions. Historical missing fields stay unknown unless provenance establishes
them. Read [schemas](../schemas/) with the human contracts: schema validity alone
cannot establish every cross-record identity, containment, or artifact reference.
