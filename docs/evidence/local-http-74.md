# Local HTTP isolation validation for #74

Observed on 2026-10-14, macOS arm64, Bun 1.3.13, Node 24.13.0 and Codex CLI
0.162.1. This record addresses [issue #74](https://github.com/BjRo/sevro/issues/74).
The supported operator interface is the runtime
[local HTTP option](../runtime-v1.md#local-http-test-servers).

## Host boundary

The installed `codex sandbox` command ran the same wildcard Node HTTP listener
and loopback client under four generated permission profiles:

| Configuration                                         | Observed result                        |
| ----------------------------------------------------- | -------------------------------------- |
| Command networking disabled                           | `listen()` fails with `EPERM`          |
| Disabled networking with `allow_local_binding = true` | `listen()` fails with `EPERM`          |
| Enabled managed proxy with local binding              | HTTP round trip succeeds               |
| Enabled networking without managed proxy              | HTTP round trip and public TCP succeed |

With the managed proxy and local binding, a direct TCP connection to
`1.1.1.1:443` instead fails with `EPERM`; its unproxied control connects. The
regression fixture uses the documentation-only `192.0.2.1` address and requires
an explicit denial rather than treating a timeout as evidence. The macOS shell
boundary separately permits binding and loopback traffic while denying other
outbound IP traffic. Source/authentication/configuration denials remain part of
the candidate's real native preflight.

The implementation does not use an outer macOS sandbox around Codex: the
native Codex sandbox cannot nest inside `sandbox-exec`. Codex's managed proxy
and its native local-binding rules establish that boundary. This selection can
reach existing loopback services and does not establish per-trial network
privacy on macOS. Native DNS permissions remain Codex-owned.

## Original upstream outcomes

Both fresh evaluations used Darrow's `fix/pr257-validation` checkout at
`1e6759c4349567f897a167a588b3714095889e86` with its existing unpublished fixture
repairs, the Sevro source override, and a replacement runtime profile containing
`network.localHttp: true`. Candidate route: `gpt-6.1-sol/medium`, Codex
`app-server`, passive, N=1, jobs=1, threshold=1, timeout 1,200,000 ms. Semantic
route: `gpt-6-luna/medium`; these cases use shell graders. No Darrow case or
integration test was removed or edited for these runs.

| Case                               | Hidden contract | Configured upstream check                                                                  |
| ---------------------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| `orchestration-oss-express-links`  | Passed, exit 0  | `npx mocha --reporter dot test/res.links.js`: exit 0                                       |
| `orchestration-oss-requests-proxy` | Passed, exit 0  | `python -m pytest -q tests/test_requests.py -k 'proxy or send' --disable-warnings`: exit 0 |

The native Express candidate also ran
`node node_modules/mocha/bin/_mocha --reporter dot test/res.links.js`: **8
passing**, exit 0. Its `npx` invocation attempted the public npm registry and
was denied by the native proxy; `npm test` exited 255 without test output. The
direct Mocha run and shell-grader outcome remain distinct from those failures.

The two exact commands quoted in #74 were additionally rerun through Sevro's
isolated shell grader against the original retained rc.11 candidates:

```sh
node node_modules/mocha/bin/_mocha --reporter dot test/res.links.js
.git/fixture-python/bin/python -m pytest tests/test_requests.py -q -k '(session or redirect or proxy or mixed_case or ALTERNATIVE or prepared or requests_are_updated_each_time) and not proxy_error'
```

Express: **8 passing**, exit 0. Requests: **77 passed, 2 failed, 229 deselected**,
exit 1, with no socket-binding setup errors. Both Requests failures ran their
local servers: `test_pyopenssl_redirect` encounters an expired pytest-httpbin
certificate; `test_redirecting_to_bad_url` receives an HTTP 500 from the newer
Werkzeug fixture instead of the expected invalid-URL redirect. The fresh native
candidate reproduced both against the original `HEAD:requests/sessions.py`.
Neither failure was waived in this exact-command rerun. A supplemental native
selection excluding them passed 126 tests; it does not replace the full result.

Fresh run IDs are `acba33c5-974c-4ab5-ba6f-5d9e947560dc` (Express) and
`a3868fae-bca0-4e29-a995-09d749bbe367` (Requests). Local retained evidence is
under Darrow's `evals/results/sevro-74-orchestration-oss-{express-links,requests-proxy}`;
the exact-command outputs are in `/private/tmp/sevro-74-original-upstream`.
Raw native evidence remains local. These model runs used the implementation
snapshot rooted at Sevro `f66e6667f28c956c41aae096bd11581f81c18a40`, build digest
`a4b11528f46daafa541ff672aad815a1183ca0615543eb587ae79e268680566b`, before final
helper cleanup and documentation. Final-source integration and CI evidence
must be assessed separately.

## Regression development

Observed test-first slices, in order:

1. Red — `lean-ctx -c 'bun test tests/runtime-cli.test.ts -t "CLI snapshots local HTTP"'`:
   the new runtime field is refused with exit 64.
   Green — `lean-ctx -c 'bun test tests/runtime-cli.test.ts -t "CLI snapshots local HTTP"'`:
   1 passed, including retained policy and changed evaluation identity.
2. Red — `lean-ctx -c 'bun test tests/shell-grader.test.ts -t "shell local HTTP"'`:
   the real listener reports `bind-error:EPERM`, exit 1.
   Green — `lean-ctx -c 'bun test tests/shell-grader.test.ts -t "shell local HTTP"'`:
   1 passed, with real HTTP round trip and outbound TCP denial.
3. Red — `lean-ctx -c 'bun test tests/runtime-host.test.ts -t "Codex candidate local HTTP"'`:
   the unchanged native command policy returns `unavailable` for the socket probe.
   Green — `lean-ctx -c 'bun test tests/runtime-host.test.ts -t "Codex candidate local HTTP"'`:
   1 passed through the installed Codex sandbox.

The affected six-file integration selection passed **296 tests**, skipped three
platform-specific tests, and failed none. Additional semantic/advisory native
probes passed and confirm the opt-in leaves those roles disabled.
`bun run check:typescript --fast` passed. Full acceptance is owned by the exact
published commit's GitHub `TypeScript quality` gate; these local observations
do not establish Ubuntu acceptance or replace that gate.
