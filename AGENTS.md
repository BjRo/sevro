# Repository guidance

For ordinary Sevro questions or explicit guide invocation, read
`.agents/skills/sevro-guide/SKILL.md` before answering. Relevant follow-ups use
the same guide and freshly inspected sources. Unrelated questions and requests
to implement, install, run evaluations, or diagnose a live environment do not
select the guide. The explicitly invoked guide remains read-only.

Before changing source code, tests, tooling, examples, or schemas,
read `CONTRIBUTING.md` and `docs/typescript-quality.md`.
Before preparing a commit, pull request, or release, read `CONTRIBUTING.md`.
For implementation PRs, use GitHub CI for full acceptance validation; a local
Docker reproduction is optional and is not a publication prerequisite.
After authorized publication, own CI monitoring and repairs until required checks
pass for the exact published commit; opening a PR does not complete delivery.
Before changing the repository guide or its evaluation fixtures and grading,
read `docs/guide-evaluation.md`.

Before changing public behavior, read `docs/contracts.md` and the applicable
linked contract. Before changing documentation or guide files, read
`docs/documentation-quality.md` and `docs/specs/repository-guide.md`.
Before changing licensing or branding, read `LICENSE`, `docs/licensing.md`,
and `docs/assets/README.md`; maintainer decisions govern changes to those terms.
For development checks and release responsibilities, read `CONTRIBUTING.md`.
For releases, follow `docs/releases.md`: reuse successful source CI and do not
rerun tests locally or in CI unless explicitly requested. Submit every release
commit through a PR; never push release commits directly to `main`. Darrow
dependency updates and compatibility checks are separate work.

Do not add `Co-authored-by` or AI attribution trailers. Never change commit
authorship metadata without explicit instruction. Do not publish, push, tag,
or operate a tracker merely because implementation was requested.

Prefer lean-ctx tools or CLI for reads/searches/shell commands when available;
their absence does not block the documented checks. When using `gh`, use a host
execution mode that can access the macOS keyring; do not change host permissions
or treat a sandbox authentication failure as proof that a token is invalid.

`AGENTS.md` is canonical; `CLAUDE.md` imports it. The guide's Claude mount is
a checked mirror of `.agents/skills/sevro-guide/SKILL.md`. Edit the canonical
body and run `bun run guide:sync`; `bun run check:docs` rejects drift.
