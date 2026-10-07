# Public quality-gate regression trace

The acceptance seam is the ticket's `bun run check:typescript` command. These
probes exercised actual instrumentation, report parsing and process validation;
they did not replace the Bun integration suite. The first missing gate returned
`Script not found "check:typescript"`, which was the intended initial missing
behavior. The final coverage thresholds remain independently mandatory.

| Focused command suffix after `bun test tests/typescript-quality.test.ts`               | Observed red                                                                            | Observed green                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial complete file                                                                  | Missing public gate script instead of the branch refusal                                | 1 pass, 3 assertions; 5/5 statements and 1/2 branches refused with `Below 95%: branches`                                                                          |
| `--test-name-pattern 'refuses absent process reports'`                                 | Gate not configured                                                                     | 1 pass, 2 assertions; `Missing coverage reports`                                                                                                                  |
| `--test-name-pattern 'refuses unregistered source files'`                              | Gate not configured                                                                     | 1 pass, 2 assertions; `Unregistered source: stray.ts`                                                                                                             |
| `--test-name-pattern 'validates process completion and report integrity'`              | Unsupported probe, missing expected diagnostics                                         | 1 pass, 9 assertions; unimported zero counts, missing child/branch data, stale/incompatible records, ordinary incomplete child and undeclared forced kill refused |
| `--test-name-pattern 'preserves original TypeScript counter and stack locations'`      | Unsupported probe                                                                       | 1 pass, 2 assertions; original TypeScript line 6 in actual Bun stack and instrumented counters                                                                    |
| `--test-name-pattern 'refuses stale or observed compiler-counter exemptions'`          | Unsupported probe                                                                       | 1 pass, 4 assertions; 351 hash/location-bound proofs, stale proof and observed allegedly impossible outcome refused                                               |
| `--test-name-pattern 'audits all stored reports before choosing completion'`           | Unregistered completion and stale discarded checkpoint diagnostics absent               | 1 pass, 3 assertions                                                                                                                                              |
| `--test-name-pattern 'audits all stored' --timeout 15000` (extended storage integrity) | Misnamed completion and unexpected report filename diagnostics absent                   | 1 pass, 5 assertions; both refused                                                                                                                                |
| `--test-name-pattern 'unregistered source' --timeout 15000` (extension inventory)      | `stray.tsx` reached compiler-configuration failure rather than source-inventory refusal | 4 pass, 8 assertions for `.ts`, `.tsx`, `.mts`, `.cts`                                                                                                            |

The expanded root-authorized proposal used
`bun test tests/typescript-quality.test.ts --test-name-pattern 'refuses stale or observed' --timeout 15000`:
red printed the old 351-only contract; green passed one test with eight assertions
for 705 guard outcomes, 731 deduplicated branch outcomes and 134 statements,
including refusal of stale, missing or observed proof data.

`bun test tests/typescript-quality.test.ts --test-name-pattern 'proves only conservative' --timeout 15000`
first failed because the public compiler-flow probe was unsupported, then passed
one test with 12 assertions. Additional model counterexamples used
`bun run check:typescript --probe compiler-flow`: the labeled-block case observed
`Compiler proof unsafely accepted labeled-block` and exit 1 before the repair;
the same command then exited 0, declining non-loop labels and imprecise
unknown-value short-circuit expressions alongside all earlier decline controls.

Some initial instrumentation scaffolding was prepared while development
dependencies were installing, before the first public red/green slice finished.
The table records actual public observations rather than claiming a different
implementation chronology. Static refactors and normative schema fixtures were
checked with focused lint/type/schema/integration commands; fixture-oracle
mistakes were corrected without classifying them as product regression reds.

Tests generated by fast-check pin seed 20261007 and print the replay path on
failure. Runtime bug regressions found during standards and behavioral coverage
work have separate red/green records owned by their source implementors.

Full coverage reports retain the complete denominator. A sparse diagnostic
passing its selected tests still exits 1 when it misses either 95% threshold;
that is a useful measurement and never final acceptance evidence.
