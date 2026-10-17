# Runtime configuration v1

Configure access to existing host tools, private writable caches, native goals,
and selected plugin hooks in `<project-root>/sevro.json`.

`--runtime-config-file /absolute/path/runtime.json` selects a replacement file.
Sevro reads exactly one file before execution, including dry runs. It does not
merge files, search parent directories, or read a candidate's copy. An absent
default file preserves the previous isolation defaults. An absent explicit
file, malformed configuration, unsupported field, or invalid selected input
fails with exit `64` before a candidate starts. Files must be regular,
non-symlink files of at most 64 KiB.

The [JSON schema](../schemas/runtime-v1.schema.json) has format
`sevro.runtime.v1`. All properties except `format` are optional.
Start with the smallest file:

```json
{ "format": "sevro.runtime.v1" }
```

Then add `environment.inherit: ["PATH"]` for installed tools. Follow the
[runnable runtime recipes](recipes.md#add-host-tool-access-one-capability-at-a-time)
to add Node, Python/UV, mise, goals and selected plugin hooks separately.
The following composed example is for a workflow that already needs all these
capabilities:

```json
{
  "format": "sevro.runtime.v1",
  "environment": {
    "inherit": ["PATH"],
    "set": {
      "UV_CACHE_DIR": "{{sevro.runtime}}/uv-cache",
      "DARROW_CACHE_DIR": "{{sevro.runtime}}/darrow-cache"
    }
  },
  "runtime": {
    "seedDirectories": [{ "source": "./public-uv-cache", "target": "uv-cache" }]
  },
  "hooks": {
    "nativeGoal": true,
    "plugins": ["darrow-review", "darrow-tdd"]
  }
}
```

Create the example's `public-uv-cache` directory beside the configuration, or
omit `runtime` when no prepared cache is needed. Selected plugin names must be
present in the case's prepared mounts; remove names that the case does not mount.
`DARROW_CACHE_DIR` is an ordinary explicit variable in this example, not a
Sevro-specific cache option.

## Environment and host tools

`environment.inherit` snapshots the named variables from the invoking process.
A named variable must exist. `environment.set` supplies explicit strings and
takes precedence over an inherited value. These values are retained in evidence:
declare only non-secret values. Credential names and runner-owned variables
such as `HOME`, temporary-directory variables, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
shell startup overrides, subprocess injection flags, and `UV_OFFLINE` are refused.

An inherited or explicit `PATH` must contain nonempty absolute entries. For an
inherited `PATH`, Sevro removes entries whose directory, installation prefix, or
symlinked tools overlap credential roots, including `~/.codex` and `~/.claude`.
This lets evaluations invoked from a Codex CLI session use ordinary host tools
without manually removing injected paths. Lexical paths and canonical targets
are checked, including absent credential paths. The remaining entries keep their
original order; the effective `PATH` is retained in runtime evidence. A `PATH`
with no remaining entries fails rather than selecting fallback tools.

An explicit `environment.set.PATH` remains authoritative and conflicting grants
fail, even when `PATH` is also inherited. Source and evaluator overlaps, invalid
entries, and unreadable unprotected directories remain errors for either form.
Missing unprotected entries are inert. Sevro grants read-only access to existing directories,
resolved symlinked tools, and bounded installation prefixes above `bin`.
An inaccessible individual symlink target is inert; an unreadable PATH directory
still fails configuration. Explicitly declared read roots must remain readable.
It does not widen a `bin` grant to the whole home, `/usr`, `/usr/local`, or
`/opt/homebrew`. Direct versioned mise paths can reuse their existing Node or
Python installations. A mise shim may also need explicitly declared mise data
and configuration; inheriting `PATH` does not change the shim's own discovery
rules. Fixture binaries keep precedence over declared host tools.

When `PATH` is declared, Sevro also queries available installation metadata
before execution. Homebrew's `--prefix` and `--cellar` identify its existing
`Cellar`, `opt`, and `etc` support trees on macOS and Linux. The whole Homebrew
prefix is not granted. On macOS, selected Apple tool shims (including Git,
Python, and compiler tools) use `xcode-select --print-path` to locate their
developer support tree. A declared `DEVELOPER_DIR` participates in that query;
an unrelated ambient override does not. Installation locations are not assumed.
Each query has a three-second deadline and an 8 KiB combined output limit.
Absent providers and the known no-active-Apple-installation result add no roots.
Other query failures, invalid metadata, or a missing declared developer override
fail before execution. Diagnostics identify the provider and operation without
retaining arbitrary command output.

Declare supporting directories outside `PATH` with `filesystem.readOnlyRoots`:

```json
{
  "format": "sevro.runtime.v1",
  "environment": { "inherit": ["PATH", "UV_PYTHON_INSTALL_DIR"] },
  "filesystem": { "readOnlyRoots": ["${UV_PYTHON_INSTALL_DIR}"] }
}
```

Set `UV_PYTHON_INSTALL_DIR` in the invoking environment before using this example.
Filesystem declarations resolve relative to the selected file. `~/` names the
operator's real home; `${NAME}` expands only a declared environment variable.
Existing directory paths and symlink targets are canonicalized. Reads under
the real home are allowed only through bounded runtime grants. Source and
configuration worktrees, evaluator inputs, credentials, results, run ownership
state, and peer fixtures remain protected. A conflicting or broad grant fails.
Managed workspaces share a private parent that protects sibling workspaces,
including those created after launch. Independently prepared workspaces require
explicit protection for other private inputs. Claude hosts require Claude Code
2.1.257 or later for managed-workspace isolation; see [checked versions](typescript-quality.md#environment-and-ci).

Use `filesystem.optionalReadOnlyRoots` for supporting directories that may not
be installed on every host, with the same path rules as `readOnlyRoots`:

```json
{
  "format": "sevro.runtime.v1",
  "filesystem": {
    "optionalReadOnlyRoots": [
      "../public-python-installations",
      "../public-tool-cache"
    ]
  }
}
```

With `sevro.json` at the repository root, these paths name sibling support
directories outside the protected repository. Keep them bounded to public tool
data; directories inside the repository remain protected even when absent.

Only absent directories are skipped. Invalid variables or paths, unreadable
directories, regular files, and protected overlaps remain errors. Required roots
still fail when absent. Effective roots retain both lexical directory paths and
canonical targets, and both are checked against protected inputs. Native aliases
inside granted support trees (for example, `opt/package` pointing into `Cellar`)
remain usable. Codex may canonicalize a standalone symlink-root permission under
protected home, denying its lexical lookup; declare the intended bounded parent
support tree and its target rather than relying on that standalone alias.

On Linux, Codex starts candidate commands from an empty filesystem with bounded
read mounts. Sevro keeps a normal home ancestor denied by that empty-root policy
rather than adding a native deny mount that would hide its read-only descendants.
Protected source and credential descendants remain explicitly denied, and no
home ancestor receives content access. If the operator's home lies inside a
minimal system read tree such as `/usr` or `/etc`, Sevro retains its explicit deny;
the native preflight may refuse that overlapping setup rather than expose home
contents.

## Local HTTP test servers

Sevro supports local HTTP servers in isolated Codex candidate
commands and `sevro.shell` graders through an explicit operator selection:

```json
{
  "format": "sevro.runtime.v1",
  "network": { "localHttp": true }
}
```

Add this property to the selected `sevro.json`, or select a replacement with
`--runtime-config-file`. Declare the existing Node/Python installations through
the environment and filesystem options above. The selection is snapshotted and
enters evaluation identity. Absent or `false` preserves existing permissions.
Hooks and semantic/advisory hosts keep their existing network permissions; this
option applies to Codex candidates and shell grading.

On macOS, shell isolation permits IP socket binding, loopback inbound traffic,
and outbound connections to loopback addresses. Wildcard listeners such as
Node's `server.listen(0)` work with loopback clients. Other outbound IP traffic
remains denied. On Linux, shell checks retain their private network namespace
with usable loopback and no external route.

Codex uses its managed command network proxy with `allow_local_binding = true`,
upstream proxy chaining disabled, and only `localhost`, `127.0.0.1`, and `::1`
allowlisted. Its native sandbox permits local binding and loopback traffic while
refusing direct outbound TCP. The native proxy may permit DNS queries; public
HTTP destinations are not allowlisted. The candidate can reach other services
on the available loopback interface, so choose this option for evaluations
that need that access. It does not provide a separate per-trial loopback service
namespace on macOS.

The supported host boundary is the native Codex sandbox and its experimental
`network_proxy` feature, documented in the [OpenAI permission reference](https://learn.chatgpt.com/docs/permissions).
Setting `allow_local_binding` while leaving command networking disabled still
denies `listen()` on macOS. Integration tests execute the installed native
Codex sandbox, a wildcard HTTP listener and loopback client, and an outbound TCP
denial probe. Host versions and actual upstream evaluation outcomes belong in
[validation evidence](evidence.md), rather than being inferred from a profile's
text. An unsupported host must not be interpreted as a passing behavior test.

## macOS ancestor metadata

Sevro's macOS outer sandbox for isolated shell checks and authorized command
hooks permits metadata reads on the exact ancestor paths of existing validated
grants. This includes declared read-only support trees, private writable
runtimes, and bounded transcript, candidate artifact, and managed workspace
access. The permissions are derived automatically from those grants; no
additional configuration is required. They let libc `realpath()` canonicalize
paths inside a permitted subtree.

Ancestor directory metadata, such as existence, type, ownership, permissions,
and timestamps, is visible. Directory listings, ancestor file contents, and
ungranted sibling metadata and contents remain denied under protected roots.
Writes remain limited by the existing writable grants; read-only grants stay
read-only. This metadata exception does not grant access to an ancestor subtree
or change network isolation.

## Private writable state

Codex candidate commands can write the isolated fixture's `.git` directory,
including its index, refs, objects, and task-owned admission locks. Sevro grants
that exact path explicitly because Codex's workspace permission otherwise keeps
Git metadata read-only. Real commits and publication to a fixture-local remote
need no additional runtime option. This grant does not authorize writes to
source repositories, grading inputs, host authentication or configuration, or
peer trials. Command network access remains disabled unless the operator selects
the [local HTTP option](#local-http-test-servers).
An existing fixture `.git` must be a physical directory. Symlinks and Git
directory pointer files are refused before launch because their metadata may
belong to a protected source repository rather than the isolated trial.

`runtime.seedDirectories` copies prepared public dependencies into a private
slot for each execution role. `source` uses the filesystem path rules above;
`target` is a single lowercase slot name, up to 64 characters, with letters,
digits, and hyphens. `home` and `tmp` are reserved. Targets must be unique.
An optional nonempty `roles` array selects any of `candidate`, `checks`, `hooks`,
`semantic`, and `advisory`. For example, `"roles": ["candidate", "checks", "hooks"]`
keeps dependency slots out of semantic and advisory runtimes. Without `roles`,
execution and artifact-grading roles retain the existing selection. Response-only
semantic grading omits implicit seeds; include `"semantic"` explicitly in `roles`
when that route needs dependencies. Artifact semantic grading and executable
shell checks keep their declared tools and default seed selection.

Each source tree is bounded to 16,384 entries and 512 MiB. Escaping symlinks,
directory cycles, dangling links, and special files are refused. File content
and modes are fingerprinted at configuration load. At first use, the runner
captures the complete bounded tree in private memory and verifies it against that
digest. Each selected role materializes separate files from those verified bytes;
later roles and trials sharing the same policy reuse the captured bytes. Source
changes before first capture fail. Source changes after capture do not change
that evaluation's dependencies. A new policy snapshot starts a new capture.
No mutable hardlinks or writable filesystem snapshot are shared. The memory
snapshot is eligible for collection when its policy seed is no longer reachable;
retaining large policies can retain up to the configured per-seed byte bounds.
Source caches are never a writable runtime. Use prepared public caches rather
than credential-bearing homes or evaluator directories.

`{{sevro.runtime}}` in an environment value resolves to that role's writable
root. Codex commands receive a `TMPPREFIX` inside their private `TMPDIR`,
so zsh here-documents use their existing private temporary storage while shared
host temporary directories remain denied. `TMPPREFIX` is runner-owned and cannot
be inherited or set through runtime configuration.
Sevro supplies private `HOME` and temporary storage and sets `UV_OFFLINE=1`
and `PYTHONDONTWRITEBYTECODE=1`. Fixture setup uses the candidate commands'
private `HOME`, so `$HOME` paths initialize the same state the candidate will
use. Its temporary directory stays disposable.
Candidate, hook, checker, semantic, and advisory
state are separate. With a runtime policy, native candidate, semantic, and
advisory roots live in a unique runner-owned host directory outside the Git
fixture. The root contains `home`, `tmp`, and declared seed slots; plugins can
use paths such as `~/.darrow/reviews` without creating repository-local review
state. Command runtime directories are separate from host authentication,
configuration, and live transcript sources. Checker and hook caches also live
outside candidate-controlled workspace state. Private roots survive native
continuation turns and children, then are removed with their owning trial or
host state after owned hooks terminate. Opted-in candidate artifact runtimes
remain alive through grading as described below. Runs with neither fixture setup
nor a selected runtime policy
retain their previous writable-state locations.

Claude refuses managed workspace or runtime namespaces overlapping its
implicit `/tmp/claude` or `/private/tmp/claude` write roots, including canonical
symlink targets. A conflicting `TMPDIR` placement fails before native launch;
choose a temporary base outside those cache trees.

The same declared tool environment reaches native candidates, isolated shell
checks, and native semantic/advisory hosts. Candidate plugin-hook authority is
not forwarded to grading hosts. Injected adapters receive the policy as request
data and remain trusted code responsible for their own execution boundary.

## Candidate artifact access

Use `runtime.artifactDirectories` to let graders read selected artifacts in the
candidate's private home after execution.

```json
{
  "format": "sevro.runtime.v1",
  "runtime": {
    "artifactDirectories": [{ "name": "reviews", "path": ".darrow/reviews" }]
  }
}
```

The example permits only the `~/.darrow/reviews` subtree, which may be initialized
by trusted fixture setup or created by the candidate.
Its original absolute path reaches isolated shell checks and native
semantic/advisory commands as `SEVRO_CANDIDATE_ARTIFACT_REVIEWS`. Graders keep
their own private `HOME`; use the supplied variable to read candidate evidence.
For each declared name, the variable is `SEVRO_CANDIDATE_ARTIFACT_` followed by
the name in uppercase. Artifact content is untrusted candidate evidence.

At most 16 directories may be declared. Names are unique, contain lowercase
letters, digits and underscores, start with a letter, and are at most 64
characters. Paths are relative to candidate home, are at most 4,096 characters,
and cannot contain empty, `.` or `..` components, backslashes or control
characters. Whole-home and absolute grants are refused. Each subtree is bounded
to 16,384 entries, including its root. Missing directories, symlinked ancestors,
descendant symlinks, hardlinks and special files make grading an error; missing
evidence cannot produce a pass.

Initialize an empty directory or seed prior Review state in the extension's
trusted `fixtureSetup` command before the candidate starts. For example:

```sh
mkdir -p "$HOME/.darrow/reviews"
printf '%s\n' '{"verdict":"passed"}' > "$HOME/.darrow/reviews/prior.json"
```

Setup and candidate commands share this private trial home, including when no
artifact grants or runtime file are selected. Graders keep their own homes and
receive only declared read-only artifact grants. To test missing reports or
absence of new artifacts, initialize the directory without writing a report;
an empty safe directory reaches ordinary task checks. Missing required reports
can then fail those checks, while negative cases can assert the directory is
empty. Sevro does not automatically create declared artifact directories: if
setup and candidate both leave one absent, or replace it with an unsafe path,
grading still errors. Setup state is temporary and is removed with its trial,
including setup failure, cancellation, and dry runs.

The grant permits reads and denies writes, creation, deletion and renaming.
Credentials, other home contents and peer role/trial state stay protected.
Ordinary `filesystem.readOnlyRoots` cannot select this private-state exception.
Artifact grants and native transcript access are independent opt-ins.

The trial allocates the retained runtime before fixture setup and
removes it after grading, advisory review and evidence persistence, including
failure and cancellation paths. Review state remains outside the Git fixture.
These artifacts are temporary; declaring access does not copy their bytes into
retained run evidence. Failed-fixture retention does not retain this runtime.
Standalone bundled-host calls retain their immediate cleanup behavior.

Trusted injected adapters receive a runner-owned `candidateRuntimeRoot` on the
candidate request and a named `candidateArtifactRoots` path map on grading
requests. Candidate adapters opting into this feature must put their private
runtime at the supplied root. The lifetime binding is process-local; bundled
hosts validate it before use. Grading adapters must preserve the read-only
boundary. The directory declarations enter runtime configuration identity;
per-trial absolute paths do not.

## Candidate Codex configuration and user skills

Set top-level `"codexState": true` to expose the bundled Codex candidate's actual
isolated configuration and user-skill state. This opt-in is independent of
`nativeTranscripts` and ordinary
candidate-home artifact declarations:

```json
{
  "format": "sevro.runtime.v1",
  "codexState": true
}
```

Candidate commands receive the real isolated `CODEX_HOME`. They may read its
`config.toml` and write non-system skills below `CODEX_HOME/skills`. The native
process's separate user-skill directory is available as
`SEVRO_CODEX_AGENT_SKILLS`; it names that process's `HOME/.agents/skills`.
Bundled `CODEX_HOME/skills/.system` skills remain read-only. Authentication,
other private siblings, evaluator inputs and peer requests remain denied.
Configuration remains read-only, and the preflight still checks credential denial.

A physical fixture-local `.codex` directory is accepted only with this opt-in.
Sevro marks the isolated project untrusted in its generated Codex configuration,
so project-local configuration, hooks and rules remain represented inputs rather
than effective host settings. The fixture is preserved. Diagnose the absolute
`CODEX_HOME/config.toml`, not the checkout's `.codex/config.toml`. The runner's
selected concurrency limit is written into the private config; an omitted limit
still means the native host default, not a fabricated configured capacity.
CLI model/effort and vetted-hook overrides keep their existing precedence; the
file alone does not establish every effective native default or child route.

After execution, isolated shell and native semantic/advisory graders receive
read-only bindings to these original candidate paths:

| Environment variable                            | Original candidate path                    |
| ----------------------------------------------- | ------------------------------------------ |
| `SEVRO_CANDIDATE_ARTIFACT_CODEX_CONFIG`         | Native `CODEX_HOME/config.toml` (one file) |
| `SEVRO_CANDIDATE_ARTIFACT_CODEX_SKILLS`         | Native `CODEX_HOME/skills`                 |
| `SEVRO_CANDIDATE_ARTIFACT_AGENT_SKILLS`         | Native process `HOME/.agents/skills`       |
| `SEVRO_CANDIDATE_ARTIFACT_COMMAND_AGENT_SKILLS` | Command `HOME/.agents/skills`              |
| `SEVRO_CANDIDATE_ARTIFACT_COMMAND_CODEX_SKILLS` | Command `HOME/.codex/skills`               |

Native and command homes are separate. The runner initializes these actual
skill locations before the candidate starts and retains their resulting state;
it does not create replacement empty directories for grading. Graders keep their
own homes and must use these bindings. To assert absence, require every selected
directory to exist, then search for `SKILL.md`, excluding only the native Codex
root's read-only `.system` subtree. Missing evidence is an error. Do not search
the grader's home or retired fixture state.

The five artifact names are reserved. Each binding belongs to one active trial
and one native request; reuse by another host request is refused. The same
canonical ancestor, entry-limit, symlink, hardlink and special-file checks as
ordinary artifacts apply. Configuration cannot be replaced by a directory grant.
The native home is retained through grading and removed with its trial, including
failure and cancellation paths. Standalone host calls clean up immediately.
These grants do not persist native files in run evidence; private absolute paths
do not enter identity, while the `codexState` selection does. Other candidate
hosts cannot supply this Codex evidence and fail grading when it is requested.

For the Darrow doctor and undefined-skill cases, select this configuration with
`--runtime-config-file`, preserve the doctor fixture's checkout value `99`, and
replace the retired-state absence check with the four skill-directory bindings
above. Keep the original repository, no-commit, activation and semantic checks.

## Goals and plugin hooks

`hooks.nativeGoal` enables Claude's native goal Stop-hook path while preserving
subscription/OAuth and API-key authentication. For a Codex CLI candidate it
selects `app-server` when no entrypoint was supplied. Explicit `exec` conflicts
with a native-goal policy. Programmatic Codex callers must construct an
`app-server` host. Native goal observations report actual host status; enabling
the policy does not itself prove that a goal was created or completed.

`hooks.plugins` authorizes all command hooks from the named prepared plugins.
Sevro validates and copies mounts, filters unselected hooks, and wraps selected
handlers in a credential-free macOS or Linux sandbox. Dependency runtime and
hook isolation preparation occur only when an authorized command handler is
encountered. No plugins, unselected hooks, or an authorized plugin without
command handlers require hook dependency hashing or copying. Configuration-load
fingerprinting still binds all declared seed contents to identity. Plugin
validation, unsupported execution refusals, and filtering still apply without
hook runtime preparation. It covers default hook files,
manifest path/inline declarations in both host formats, and Markdown skill or
agent frontmatter. Unsupported handler types and exec-form arguments fail
instead of being skipped. The wrapper denies network access and protected
roots and owns asynchronous hook cleanup. Native timeout/cancellation stops
owned hook descendants before private state is removed.

Prepared native plugin projections live outside the fixture in the current
host request's private native state. Curated hook read grants validate the
canonical projection layout, ownership, private state permissions, and binding
to that request. Only the selected plugin subtree is readable; it stays
read-only, and credentials, private siblings, and peer requests remain denied.
Ordinary filesystem declarations cannot select this exception. Codex validates
and filters installed plugins before enabling its runner-owned skill collector,
including requests without a runtime policy. Plugin command handlers still
require explicit hook authority. Projections are removed with their owning host
request.

Auxiliary `.mcp.json` and `.lsp.json` files and plugin mods are unsupported under
hook authority. Manifest MCP/LSP declarations are removed from curated mounts.

Plugin-only settings are required when goals or custom hooks are enabled;
`--claude-project-settings` conflicts with that policy. Keep repository-skill
cases on their explicit project-settings route with hooks disabled. Unrelated
user settings and hooks are not imported. Sevro does not use Claude's `--bare`
mode, which would change authentication and behavior.

## Native transcript access

Set top-level `"nativeTranscripts": true` to enable live, read-only access to
the current role's full native root and subagent transcript tree. Absent or
`false` leaves this access and capture disabled. The selection is snapshotted
with the runtime policy and enters configuration identity; temporary native
homes and transcript views do not enter that identity. Codex `exec` persists
sessions when enabled, including runs without continuation.

Commands discover their own tree through `SEVRO_NATIVE_TRANSCRIPT_ROOT`.
Codex commands also receive runner-owned `CODEX_HOME`; native
`CODEX_THREAD_ID` selects `sessions/**/rollout-*-<thread>.jsonl`. Read the latest
native `turn_context` for that session's `model` and `effort`. Claude shell
commands receive a credential-free `CLAUDE_CONFIG_DIR` view whose `projects/`
tree contains `projects/*/<CLAUDE_CODE_SESSION_ID>.jsonl` and subagent files.
The latest native assistant `message.model` records the observed model.
Claude supplies `CLAUDE_CODE_SESSION_ID` and `CLAUDE_EFFORT` itself; Sevro does
not replace these with the root's requested route. Requested CLI effort is
configuration, and is not proof of an effective child effort. Missing native
route evidence stays unknown.

Observed with Claude Code 2.1.284: a native Agent's Bash may receive the parent's
`CLAUDE_CODE_SESSION_ID` and no `CLAUDE_EFFORT`. In that situation the environment
pair selects the parent transcript. Analyze the child's native JSONL and
`.meta.json` sidecar to establish its own model/session association; the
parent's model is not the child's observed model, and missing effort remains
unknown. Sevro preserves these native values without synthesizing a child
context or copying the root's requested effort into the child.

Native hosts keep their credential-bearing homes. Claude's host writes through
a runner-created, canonical-bound `projects` link into the isolated source;
runner-owned Bash and zsh startup files supply the shell compatibility view.
These sources and startup files sit outside candidate-writable state. Commands
cannot modify transcripts or read credential/settings siblings, evaluator
inputs, or peer role/trial state. A fixed private namespace is protected before
commands start, including peers created later. Pre-existing namespaces must be
owned private directories; links and unsafe permissions fail. Ordinary
filesystem declarations cannot authorize access to this namespace.
Namespace read roots and seed sources, including declaration symlinks into it,
are refused before private trees are hashed or copied.
On Linux, Codex keeps this namespace hidden through its empty-root policy and
mounts only runner-owned session/helper trees and retained views. It avoids an
ancestor deny mount that would mask these narrower read-only grants. Ordinary
declarations cannot select this exception; parent content, credentials, and
present or future peer state receive no grants.

After candidate execution, isolated shell checks and semantic/advisory hosts
receive `SEVRO_CANDIDATE_TRANSCRIPTS`, a separate read-only retained view with
`index.json` and `codex/` or `claude/` native relative file paths. This does not
replace a grading host's own native home or live tree. Trusted injected adapters
receive the same view through request `candidateTranscriptRoot`. The temporary
view is removed after grading; stable retained artifact references remain in
run evidence. Extensions and external benchmarks consume the
[native transcript bundles](results-v1.md#native-transcript-bundles).

## Evidence and compatibility

`configuration.redacted.runtimePolicy` retains the selected environment,
canonical read roots, seed digests, and hook declaration. The engine snapshots
this input once; it participates in `configurationDigest` and evaluation
identity. Symbolic runtime placeholders remain symbolic in identity, while
execution uses per-role paths. This binds declared setup and seed contents;
it does not claim that every external installation file or OS dependency is
immutable.

The retained policy also records metadata providers, their selected executables
and effective support roots, plus skipped optional paths. These values and the
actual effective roots enter identity; private execution paths and external tool
file contents do not. The same discovery and skip evidence reaches
`sevro.host.runtime` observations.

Bundled hosts supply `sevro.host.runtime` with the applied policy digest, role,
environment names, read roots, and seed slots. `sevro.host.hooks` records source
and effective plugin digests plus observed executions and their exit codes.
An empty execution list does not prove hook activation. Partial lifecycle
evidence remains partial. Cases can require these observations; missing required
evidence cannot become a pass. Goal and hook success remain separate from the
task verdict.

`--toolchain-bin-dir` and `--claude-uv-cache-dir` are deprecated. They keep their
previous behavior with a warning when no runtime file is selected. Combining
them with a runtime file fails before execution. Migrate to `environment`,
`filesystem`, and private seed slots; removal is no earlier than `0.2.0`.
See the [CLI reference](development-cli.md), [native hosts](native-hosts.md),
and [identity contract](identity-v1.md).

Programmatic consumers can import `RuntimeConfiguration`, `RuntimePolicy`, and
`loadRuntimeConfiguration` from `src/engine.ts`, then pass the resolved policy
to `runEvaluation` or a bundled host request. They must provide the same
protected-source declarations required by their execution route.
`loadRuntimeConfiguration` accepts those canonical protected roots as its third
argument, so provider queries themselves cannot run from protected source trees.

Derived grading policies retain omitted seed sources in `seedReadDenyRoots`.
Bundled hosts and checkers deny those roots even when no dependency slot is
materialized. Trusted injected adapters must preserve these source denials when
applying the request policy. This is derived programmatic policy metadata, not
a selectable `sevro.json` field.
