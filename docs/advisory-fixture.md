# Advisory review fixture

`buildBlindAdvisoryFixture(candidateWorkspace, { baseRevision, excludedPaths })`
creates a temporary Git workspace for a separate quality reviewer. The caller
supplies the candidate workspace and its `HEAD` revision from before the host
ran. The helper starts with that revision, replaces the original Git history
with one synthetic baseline commit, then applies committed, staged, unstaged,
and non-ignored untracked candidate changes. The returned directory is owned
by the caller, which must remove it after review.

Root `.agents`, `.claude`, `.codex`, and `.git` paths are withheld from both the
baseline and the change. `excludedPaths` withholds any additional evaluator
paths. The review workspace has no remote. The helper rejects escaping or
broken symlinks and limits Git output, untracked file count, and untracked
bytes. A failed build removes its temporary directory.

`advisoryPrompt` passes the task and deterministic check facts to a separate
review host. `parseAdvisoryAssessment` accepts one bounded JSON response with a
pass or fail recommendation, overall score, four dimension scores, strengths,
weaknesses, and a summary. The engine invokes this route when given an
`advisoryHost` and a Git fixture. It records the route, response, assessment,
and usage in trial evidence. A reviewer failure or recommendation never
changes the task verdict. The development CLI does not yet expose this route.
