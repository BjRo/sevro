use serde_json::{Value, json};
use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use uuid::Uuid;

#[path = "native_codex/process_boundaries.rs"]
mod process_boundaries;

#[path = "native_codex/path_metadata.rs"]
mod path_metadata;

#[path = "native_codex/continuation.rs"]
mod continuation;

#[path = "native_codex/runtime.rs"]
mod runtime;

#[path = "native_codex/parallel_peers.rs"]
mod parallel_peers;

#[cfg(target_os = "linux")]
#[path = "native_codex/temporary_metadata.rs"]
mod temporary_metadata;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("sevro-rust-native-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        for name in ["project", "binary", "temporary"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        fs::write(
            root.join("project/auth.json"),
            "FAKE_NATIVE_TEST_CREDENTIAL\n",
        )
        .unwrap();
        fs::set_permissions(
            root.join("project/auth.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        fs::write(
            root.join("project/case.json"),
            serde_json::to_vec(&json!({
                "id":"native-ready", "prompt":"Return ready.",
                "fixture":{"files":{"README.md":"prepared fixture\n"}},
                "checks":[], "requiredEvidence":[]
            }))
            .unwrap(),
        )
        .unwrap();
        let codex = installed_codex();
        let script = native_script(&codex, &root);
        fs::write(root.join("binary/codex-wrapper"), script).unwrap();
        fs::set_permissions(
            root.join("binary/codex-wrapper"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        if cfg!(target_os = "linux") {
            std::os::unix::fs::symlink(&codex, root.join("binary/codex-linux-sandbox")).unwrap();
        }
        Self { root }
    }

    fn invoke(&self) -> Output {
        self.invoke_with(&[])
    }

    fn transcript(&self, bytes: &[u8], code: i32) {
        fs::write(self.root.join("binary/transcript"), bytes).unwrap();
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = --version ]; then echo synthetic; exit 0; fi\nif [ \"$1\" = sandbox ]; then shift; exec {} sandbox \"$@\"; fi\nif [ \"$1\" != exec ]; then exit 99; fi\nprintf '%s\\n' \"$CODEX_HOME\" \"$HOME\" \"$TMPDIR\" > {}\n/bin/cat >/dev/null\n/bin/cat {}\nexit {code}\n",
            quote(&installed_codex()),
            quote(&self.root.join("binary/native-state-paths")),
            quote(&self.root.join("binary/transcript")),
        );
        fs::write(self.root.join("binary/codex-wrapper"), script).unwrap();
    }

    fn invoke_with(&self, arguments: &[&str]) -> Output {
        self.command().args(arguments).output().unwrap()
    }

    fn command(&self) -> Command {
        self.command_with(Path::new(env!("CARGO_BIN_EXE_sevro")))
    }

    fn command_with(&self, executable: &Path) -> Command {
        let mut command = Command::new(executable);
        command
            .current_dir(self.root.join("project"))
            .env("TMPDIR", self.root.join("temporary"))
            .env("SEVRO_NATIVE_PRIVATE_SENTINEL", "must-not-reach-native")
            .env("SEVRO_DEBUG_NATIVE_DIAGNOSTICS", "1")
            .args([
                "run",
                "--json",
                "--case-file",
                "case.json",
                "--host",
                "codex",
                "--codex-bin",
            ])
            .arg(self.root.join("binary/codex-wrapper"))
            .args([
                "--codex-auth-file",
                "auth.json",
                "--model",
                "synthetic-native",
                "--effort",
                "low",
                "--runner-build-digest",
            ])
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64));
        command
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if std::thread::panicking() {
            report_native_failure(&self.root);
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn report_native_failure(root: &Path) {
    // Only inspect known synthetic receipts, never auth/config files or raw responses.
    for marker in [
        "native-state-paths",
        "initial-argv",
        "resume-argv",
        "launches",
        "descendant",
        "model-started",
        "launched",
    ] {
        eprintln!(
            "native fixture marker {marker}: present={}",
            root.join("binary").join(marker).exists()
        );
    }
    for phase in ["initial", "resume"] {
        let path = root.join("binary").join(format!("{phase}-sandbox-status"));
        match native_probe_status(&path) {
            Some(code) => {
                eprintln!("native fixture {phase} sandbox status: {code}");
                if code != 0 {
                    let path = root.join("binary").join(format!("{phase}-sandbox-stderr"));
                    let mut bytes = Vec::new();
                    match fs::File::open(path)
                        .and_then(|file| file.take(4097).read_to_end(&mut bytes))
                    {
                        Ok(_) => eprintln!(
                            "native fixture {phase} sandbox stderr (first 4096 bytes, truncated={}): {:?}",
                            bytes.len() > 4096,
                            String::from_utf8_lossy(&bytes[..bytes.len().min(4096)])
                        ),
                        Err(error) => {
                            eprintln!("native fixture {phase} sandbox stderr: {}", error.kind());
                        }
                    }
                }
            }
            None => eprintln!("native fixture {phase} sandbox status: unavailable"),
        }
    }
    let Ok(runs) = fs::read_dir(root.join("project/.sevro/results")) else {
        eprintln!("native fixture results directory unavailable");
        return;
    };
    for run in runs
        .flatten()
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_dir())
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| Uuid::parse_str(name).is_ok())
        })
        .take(4)
    {
        for artifact in ["codex.process", "codex.stderr"] {
            let path = run.path().join(format!("trial-1-host-{artifact}.bin"));
            let mut bytes = Vec::new();
            let read =
                fs::File::open(path).and_then(|file| file.take(4097).read_to_end(&mut bytes));
            match read {
                Ok(_) => eprintln!(
                    "native fixture {artifact} (first 4096 bytes, truncated={}): {:?}",
                    bytes.len() > 4096,
                    String::from_utf8_lossy(&bytes[..bytes.len().min(4096)])
                ),
                Err(error) => eprintln!("native fixture {artifact}: {}", error.kind()),
            }
        }
    }
}

// Temporary CI diagnosis: accept only one bounded decimal shell exit status.
fn native_probe_status(path: &Path) -> Option<u8> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(5)
        .read_to_end(&mut bytes)
        .ok()?;
    let digits = bytes.strip_suffix(b"\n")?;
    if digits.is_empty() || digits.len() > 3 || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(digits).ok()?.parse().ok()
}

fn installed_codex() -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").expect("PATH is required"))
        .map(|directory| directory.join("codex"))
        .find(|path| path.is_file())
        .expect("native Codex integration requires the installed Codex CLI; run bun scripts/setup-ci-codex.ts")
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\"'\"'"))
}

fn native_script(codex: &Path, root: &Path) -> String {
    r#"#!/bin/sh
if [ "$1" = --version ]; then printf 'synthetic-native-oracle\n'; exit 0; fi
if [ "$1" = sandbox ]; then shift; exec @CODEX@ sandbox "$@"; fi
if [ "$1" != exec ]; then exit 99; fi
if [ -n "${SEVRO_NATIVE_PRIVATE_SENTINEL-}" ]; then exit 97; fi
if [ -z "$CODEX_HOME" ] || [ -z "$HOME" ] || [ -z "$TMPDIR" ]; then exit 96; fi
if [ "$(/bin/cat "$CODEX_HOME/auth.json")" != FAKE_NATIVE_TEST_CREDENTIAL ]; then exit 95; fi
if [ "$(/bin/cat)" != 'Return ready.' ]; then exit 94; fi
printf '%s\n' "$CODEX_HOME" "$HOME" "$TMPDIR" > @STATE_PATHS@
profile=$(/usr/bin/sed -n 's/^default_permissions = "\(.*\)"/\1/p' "$CODEX_HOME/config.toml")
peer="$(/usr/bin/dirname "$PWD")/oracle-peer-$(/usr/bin/basename "$PWD")"
/bin/mkdir "$peer" || exit 93
printf 'peer private input' > "$peer/private-input"
trap '/bin/rm -rf "$peer"' EXIT
@CODEX@ sandbox -P "$profile" -C "$PWD" /bin/sh -c '
  test "$(/bin/cat README.md)" = "prepared fixture" || exit 91
  printf candidate-write > candidate-write.txt || exit 90
  for protected in "$@"; do
    if /bin/cat "$protected" >/dev/null 2>&1; then exit 89; fi
  done
' native-boundary-probe @AUTH@ "$CODEX_HOME/auth.json" "$CODEX_HOME/config.toml" "$peer/private-input" || exit 92
printf '%s\n' '{"type":"thread.started","thread_id":"native-oracle-thread"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":4}}'
"#
    .replace("@CODEX@", &quote(codex))
    .replace("@AUTH@", &quote(&root.join("project/auth.json")))
    .replace("@STATE_PATHS@", &quote(&root.join("binary/native-state-paths")))
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn artifact_path(value: &Value) -> PathBuf {
    url::Url::parse(value.as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap()
}

const THREAD: &str = "{\"type\":\"thread.started\",\"thread_id\":\"native-oracle-thread\"}\n";
const MESSAGE: &str =
    "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"ready\"}}\n";
const COMPLETED: &str =
    "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":12,\"output_tokens\":4}}\n";

#[test]
fn accepts_integer_valued_json_usage() {
    let fixture = Fixture::new();
    let stream = format!(
        "{THREAD}{MESSAGE}{}",
        COMPLETED.replace(":12", ":12.0").replace(":4", ":4.0")
    );
    fixture.transcript(stream.as_bytes(), 0);
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let usage = &evidence["trials"][0]["usage"];
    assert_eq!(usage["inputTokens"].as_f64(), Some(12.0));
    assert_eq!(usage["outputTokens"].as_f64(), Some(4.0));
    assert_eq!(usage["complete"], true);
}

fn assert_state_removed(fixture: &Fixture) {
    for path in fs::read_to_string(fixture.root.join("binary/native-state-paths"))
        .unwrap()
        .lines()
    {
        assert!(
            !Path::new(path).exists(),
            "native private state survived: {path}"
        );
    }
}

fn assert_failed_turn(output: &Output) {
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"]["status"], "failed");
    assert_eq!(
        result["diagnostic"],
        json!({"code":"sevro.host.failed","message":"host execution did not complete"})
    );
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = &evidence["trials"][0];
    assert_eq!(trial["rawResult"]["path"], Value::Null);
    assert_eq!(trial["artifactRefs"], json!([]));
    assert_eq!(
        trial["usage"],
        json!({"inputTokens":null,"outputTokens":null,"costUsd":null,"complete":false})
    );
    let workspaces = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    let retained = Path::new(workspaces["data"]["candidate"].as_str().unwrap());
    assert!(retained.is_dir(), "failed fixture must remain inspectable");
    fs::remove_dir_all(retained).unwrap();
}

#[test]
fn rejects_invalid_or_incomplete_native_transcripts() {
    for (name, stream, code) in [
        ("invalid JSON", "not json\n".into(), 0),
        ("invalid event", "[]\n".into(), 0),
        (
            "duplicate thread",
            format!("{THREAD}{THREAD}{MESSAGE}{COMPLETED}"),
            0,
        ),
        (
            "empty thread",
            format!("{}{COMPLETED}", THREAD.replace("native-oracle-thread", "")),
            0,
        ),
        ("missing thread", MESSAGE.into(), 0),
        (
            "completion before thread",
            format!("{COMPLETED}{THREAD}"),
            0,
        ),
        (
            "duplicate completion",
            format!("{THREAD}{COMPLETED}{COMPLETED}"),
            0,
        ),
        (
            "failed before completion",
            format!("{THREAD}{{\"type\":\"turn.failed\"}}\n{COMPLETED}"),
            0,
        ),
        (
            "failed after completion",
            format!("{THREAD}{MESSAGE}{COMPLETED}{{\"type\":\"turn.failed\"}}\n"),
            0,
        ),
        ("incomplete turn", format!("{THREAD}{MESSAGE}"), 0),
        ("failed process", format!("{THREAD}{MESSAGE}{COMPLETED}"), 7),
    ] {
        let fixture = Fixture::new();
        fixture.transcript(stream.as_bytes(), code);
        let output = fixture.invoke();
        assert_failed_turn(&output);
        assert_state_removed(&fixture);
        assert!(
            !String::from_utf8_lossy(&output.stderr).contains("native-oracle-thread"),
            "{name}"
        );
    }
}

#[test]
fn keeps_unknown_usage_unknown_for_completed_native_turns() {
    for usage in [
        "null",
        "{}",
        "{\"input_tokens\":-1,\"output_tokens\":4}",
        "{\"input_tokens\":1.5,\"output_tokens\":4}",
        "{\"input_tokens\":9007199254740992,\"output_tokens\":4}",
        "{\"input_tokens\":\"12\",\"output_tokens\":4}",
    ] {
        let fixture = Fixture::new();
        let stream =
            format!("{THREAD}{MESSAGE}{{\"type\":\"turn.completed\",\"usage\":{usage}}}\n");
        fixture.transcript(stream.as_bytes(), 0);
        let output = fixture.invoke();
        assert_eq!(output.status.code(), Some(0), "{usage}");
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
        let trial = &evidence["trials"][0];
        assert_eq!(
            trial["usage"],
            json!({"inputTokens":null,"outputTokens":null,"costUsd":null,"complete":false})
        );
        assert_eq!(
            fs::read(artifact_path(&trial["rawResult"]["path"])).unwrap(),
            b"ready"
        );
        assert_state_removed(&fixture);
    }
}

#[test]
fn ignores_unknown_events_and_messages_after_turn_completion() {
    for (stream, expected) in [
        (
            format!("\n{THREAD}{{\"type\":\"future.event\"}}\n{MESSAGE}{COMPLETED}\n"),
            Some("ready"),
        ),
        (format!("{THREAD}{COMPLETED}"), None),
        (format!("{THREAD}{COMPLETED}{MESSAGE}"), None),
    ] {
        let fixture = Fixture::new();
        fixture.transcript(stream.as_bytes(), 0);
        let output = fixture.invoke();
        assert_eq!(output.status.code(), Some(0));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
        let trial = &evidence["trials"][0];
        match expected {
            Some(message) => assert_eq!(
                fs::read_to_string(artifact_path(&trial["rawResult"]["path"])).unwrap(),
                message
            ),
            None => assert_eq!(trial["rawResult"]["path"], Value::Null),
        }
        assert_eq!(trial["usage"]["complete"], true);
        let events = trial["artifactRefs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "sevro.codex.events")
            .unwrap();
        assert_eq!(
            fs::read(artifact_path(&events["path"])).unwrap(),
            stream.as_bytes()
        );
        assert_state_removed(&fixture);
    }
}

#[test]
fn rejects_unreadable_or_oversized_auth_before_launching_native_process() {
    for kind in ["missing", "directory", "oversized"] {
        let fixture = Fixture::new();
        let auth = fixture.root.join("project/auth.json");
        fs::remove_file(&auth).unwrap();
        match kind {
            "directory" => fs::create_dir(&auth).unwrap(),
            "oversized" => fs::write(&auth, vec![b'x'; 1024 * 1024 + 1]).unwrap(),
            _ => {}
        }
        fs::write(
            fixture.root.join("binary/codex-wrapper"),
            format!(
                "#!/bin/sh\ntouch {}\nexit 98\n",
                quote(&fixture.root.join("binary/launched"))
            ),
        )
        .unwrap();
        assert_failed_turn(&fixture.invoke());
        assert!(!fixture.root.join("binary/launched").exists(), "{kind}");
        #[cfg(target_os = "macos")]
        assert_eq!(
            fs::read_dir(fixture.root.join("temporary/sevro-native-private"))
                .unwrap()
                .count(),
            0,
            "{kind}"
        );
    }
}

fn require_no_native_launch(fixture: &Fixture) {
    fs::write(
        fixture.root.join("binary/codex-wrapper"),
        format!(
            "#!/bin/sh\ntouch {}\nexit 98\n",
            quote(&fixture.root.join("binary/launched"))
        ),
    )
    .unwrap();
}

#[test]
fn rejects_fixture_owned_codex_configuration_before_launch() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("project/case.json"),
        serde_json::to_vec(&json!({
            "id":"fixture-config", "prompt":"Return ready.",
            "fixture":{"files":{".codex/config.toml":"[features]\nhooks = true\n"}},
            "checks":[], "requiredEvidence":[]
        }))
        .unwrap(),
    )
    .unwrap();
    require_no_native_launch(&fixture);
    assert_failed_turn(&fixture.invoke());
    assert!(!fixture.root.join("binary/launched").exists());
}

#[test]
fn rejects_unsafe_optional_configuration_roots_before_launch() {
    for name in ["CODEX_HOME", "CLAUDE_CONFIG_DIR"] {
        let fixture = Fixture::new();
        require_no_native_launch(&fixture);
        let output = fixture
            .command()
            .env(name, "relative-private-config")
            .output()
            .unwrap();
        assert_failed_turn(&output);
        assert!(!fixture.root.join("binary/launched").exists());
    }
    let fixture = Fixture::new();
    let control_path = fixture.root.join("control\nprivate");
    fs::create_dir(&control_path).unwrap();
    require_no_native_launch(&fixture);
    let output = fixture
        .command()
        .env("CODEX_HOME", control_path)
        .output()
        .unwrap();
    assert_failed_turn(&output);
    assert!(!fixture.root.join("binary/launched").exists());
}

#[test]
fn rejects_executable_symlink_into_protected_project() {
    let fixture = Fixture::new();
    require_no_native_launch(&fixture);
    let binary = fixture.root.join("binary/codex-wrapper");
    let target = fixture.root.join("project/protected-executable");
    fs::rename(&binary, &target).unwrap();
    std::os::unix::fs::symlink(&target, &binary).unwrap();
    assert_failed_turn(&fixture.invoke());
    assert!(!fixture.root.join("binary/launched").exists());
}

fn fixture_git(project: &Path, arguments: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(project)
        .args([
            "-c",
            "user.name=Sevro fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn isolates_protected_linked_git_worktrees() {
    let fixture = Fixture::new();
    let project = fixture.root.join("project");
    fixture_git(&project, &["init", "--quiet"]);
    fs::write(project.join("README.md"), "public fixture source\n").unwrap();
    fixture_git(&project, &["add", "README.md"]);
    fixture_git(&project, &["commit", "--quiet", "-m", "fixture"]);
    let linked = fixture.root.join("linked-worktree");
    fixture_git(
        &project,
        &[
            "worktree",
            "add",
            "--quiet",
            "--detach",
            linked.to_str().unwrap(),
        ],
    );
    fs::write(
        linked.join("private-input"),
        "PRIVATE_LINKED_WORKTREE_SENTINEL\n",
    )
    .unwrap();
    let binary = fixture.root.join("binary/codex-wrapper");
    let script = fs::read_to_string(&binary).unwrap().replace(
        "\"$peer/private-input\" || exit 92",
        &format!(
            "\"$peer/private-input\" {} || exit 92",
            quote(&linked.join("private-input"))
        ),
    );
    fs::write(binary, script).unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    assert_eq!(
        fs::read(artifact_path(&evidence["trials"][0]["rawResult"]["path"])).unwrap(),
        b"ready"
    );
    assert_state_removed(&fixture);
    assert_eq!(
        fs::read_to_string(linked.join("private-input")).unwrap(),
        "PRIVATE_LINKED_WORKTREE_SENTINEL\n"
    );
}

#[test]
fn executes_isolated_codex_turn() {
    let fixture = Fixture::new();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"completed"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    assert_eq!(result["exitCode"], 0);
    let evidence_path = Path::new(result["evidencePath"].as_str().unwrap());
    let evidence = read_json(evidence_path);
    assert_eq!(evidence["result"], result);
    let trial = &evidence["trials"][0];
    assert_eq!(
        trial["condition"],
        json!({"requested":"passive","actual":"passive","appliedInstrumentation":[]})
    );
    assert_eq!(trial["usage"]["inputTokens"].as_f64(), Some(12.0));
    assert_eq!(trial["usage"]["outputTokens"].as_f64(), Some(4.0));
    assert_eq!(trial["usage"]["costUsd"], Value::Null);
    assert_eq!(trial["usage"]["complete"], true);
    assert_eq!(
        fs::read(artifact_path(&trial["rawResult"]["path"])).unwrap(),
        b"ready"
    );
    assert_eq!(
        trial["rawResult"]["sha256"],
        "b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6"
    );
    let artifact = &trial["artifactRefs"][0];
    assert_eq!(artifact["id"], "sevro.codex.events");
    assert_eq!(
        artifact["sha256"],
        "d3e1e18fe8be1491beb8746fa8fcc71d524f89128e7c42c5e6fc58ea94c2363d"
    );
    let events = fs::read_to_string(artifact_path(&artifact["path"])).unwrap();
    assert_eq!(events.lines().count(), 3);
    let workspaces = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|observation| observation["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert!(!Path::new(workspaces["data"]["candidate"].as_str().unwrap()).exists());
    let state_paths = fs::read_to_string(fixture.root.join("binary/native-state-paths")).unwrap();
    assert_eq!(state_paths.lines().count(), 3);
    for path in state_paths.lines() {
        assert!(
            !Path::new(path).exists(),
            "private native state survived: {path}"
        );
    }
    assert_eq!(
        fs::read_to_string(fixture.root.join("project/auth.json")).unwrap(),
        "FAKE_NATIVE_TEST_CREDENTIAL\n"
    );
    for public in [
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        evidence.to_string(),
    ] {
        assert!(!public.contains("FAKE_NATIVE_TEST_CREDENTIAL"));
    }
}

#[test]
fn retains_private_preflight_failure() {
    let fixture = Fixture::new();
    let script = format!(
        "#!/bin/sh\nif [ \"$1\" = sandbox ]; then\n  printf '%s\\n' \"$CODEX_HOME\" \"$HOME\" \"$TMPDIR\" > {}\n  printf 'PRIVATE_PREFLIGHT_STDERR\\n' >&2\n  exit 70\nfi\nif [ \"$1\" = exec ]; then touch {}; exit 99; fi\nexit 98\n",
        quote(&fixture.root.join("binary/native-state-paths")),
        quote(&fixture.root.join("binary/model-started")),
    );
    fs::write(fixture.root.join("binary/codex-wrapper"), script).unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"failed"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = &evidence["trials"][0];
    let artifacts = trial["artifactRefs"].as_array().unwrap();
    let receipt = artifacts
        .iter()
        .find(|artifact| artifact["id"] == "codex.process")
        .expect("failed native preflight must retain its bounded process receipt");
    let process = read_json(&artifact_path(&receipt["path"]));
    for (field, expected) in [
        ("phase", json!("isolation-preflight")),
        ("reason", json!("exit")),
        ("timeoutMs", json!(60000)),
        ("code", json!(70)),
        ("signal", Value::Null),
        ("stderrTruncated", json!(false)),
    ] {
        assert_eq!(process[field], expected, "{field}");
    }
    assert!(process["durationMs"].as_f64().unwrap() >= 0.0);
    let stderr = artifacts
        .iter()
        .find(|artifact| artifact["id"] == "codex.stderr")
        .unwrap();
    let stderr_path = artifact_path(&stderr["path"]);
    assert_eq!(
        fs::read(&stderr_path).unwrap(),
        b"PRIVATE_PREFLIGHT_STDERR\n"
    );
    assert_eq!(
        fs::metadata(stderr_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(trial["condition"]["actual"], "passive");
    assert_eq!(trial["rawResult"]["path"], Value::Null);
    assert!(!fixture.root.join("binary/model-started").exists());
    for path in fs::read_to_string(fixture.root.join("binary/native-state-paths"))
        .unwrap()
        .lines()
    {
        assert!(
            !Path::new(path).exists(),
            "private state survived preflight failure"
        );
    }
    for public in [
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        evidence.to_string(),
    ] {
        assert!(!public.contains("PRIVATE_PREFLIGHT_STDERR"));
    }
    let workspaces = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|observation| observation["id"] == "sevro.observation.workspaces")
        .unwrap();
    let retained = Path::new(workspaces["data"]["candidate"].as_str().unwrap());
    assert!(retained.is_dir(), "failed fixture must remain inspectable");
    fs::remove_dir_all(retained).unwrap();
}

#[test]
fn times_out_native_turn_and_owned_descendant() {
    let fixture = Fixture::new();
    let script = format!(
        "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'synthetic-timeout\\n'; exit 0; fi\nif [ \"$1\" = sandbox ]; then shift; exec {} sandbox \"$@\"; fi\nif [ \"$1\" != exec ]; then exit 99; fi\nprintf '%s\\n' \"$CODEX_HOME\" \"$HOME\" \"$TMPDIR\" > {}\nprintf 'PRIVATE_TIMEOUT_STDERR\\n' >&2\n/bin/sleep 30 &\ndescendant=$!\nprintf '%s\\n' \"$descendant\" > {}\nwait \"$descendant\"\n",
        quote(&installed_codex()),
        quote(&fixture.root.join("binary/native-state-paths")),
        quote(&fixture.root.join("binary/descendant")),
    );
    fs::write(fixture.root.join("binary/codex-wrapper"), script).unwrap();
    let output = fixture.invoke_with(&["--codex-timeout-ms", "200"]);
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"failed"}));
    assert_eq!(
        result["diagnostic"]["message"],
        "Codex run timed out after 0.2 s"
    );
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = &evidence["trials"][0];
    let artifacts = trial["artifactRefs"].as_array().unwrap();
    let receipt = artifacts
        .iter()
        .find(|artifact| artifact["id"] == "codex.process")
        .unwrap();
    let process = read_json(&artifact_path(&receipt["path"]));
    for (field, expected) in [
        ("phase", json!("execution")),
        ("reason", json!("timeout")),
        ("timeoutMs", json!(200)),
        ("code", json!(137)),
        ("signal", json!("SIGKILL")),
        ("stderrTruncated", json!(false)),
    ] {
        assert_eq!(process[field], expected, "{field}");
    }
    assert!(process["durationMs"].as_f64().unwrap() >= 200.0);
    let stderr = artifacts
        .iter()
        .find(|artifact| artifact["id"] == "codex.stderr")
        .unwrap();
    assert_eq!(
        fs::read(artifact_path(&stderr["path"])).unwrap(),
        b"PRIVATE_TIMEOUT_STDERR\n"
    );
    let descendant = fs::read_to_string(fixture.root.join("binary/descendant")).unwrap();
    let status = Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", descendant.trim()])
        .output()
        .unwrap();
    let state = String::from_utf8(status.stdout).unwrap();
    assert!(
        state.trim().is_empty() || state.trim().starts_with('Z'),
        "owned descendant still running: {state}"
    );
    for path in fs::read_to_string(fixture.root.join("binary/native-state-paths"))
        .unwrap()
        .lines()
    {
        assert!(
            !Path::new(path).exists(),
            "private native state survived timeout"
        );
    }
    assert!(!String::from_utf8_lossy(&output.stdout).contains("PRIVATE_TIMEOUT_STDERR"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("PRIVATE_TIMEOUT_STDERR"));
    let workspaces = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|observation| observation["id"] == "sevro.observation.workspaces")
        .unwrap();
    let retained = Path::new(workspaces["data"]["candidate"].as_str().unwrap());
    assert!(retained.is_dir());
    fs::remove_dir_all(retained).unwrap();
}

#[test]
fn cancels_native_turn_and_owned_descendant_on_invocation_signal() {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    for signal in [Signal::SIGINT, Signal::SIGTERM] {
        let fixture = Fixture::new();
        let marker = fixture.root.join("binary/descendant");
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = --version ]; then echo synthetic; exit 0; fi\nif [ \"$1\" = sandbox ]; then shift; exec {} sandbox \"$@\"; fi\nif [ \"$1\" != exec ]; then exit 99; fi\nprintf '%s\\n' \"$CODEX_HOME\" \"$HOME\" \"$TMPDIR\" > {}\nprintf 'PRIVATE_CANCELLED_STDERR\\n' >&2\n/bin/sleep 30 &\ndescendant=$!\nprintf '%s\\n' \"$descendant\" > {}\nwait \"$descendant\"\n",
            quote(&installed_codex()),
            quote(&fixture.root.join("binary/native-state-paths")),
            quote(&marker)
        );
        fs::write(fixture.root.join("binary/codex-wrapper"), script).unwrap();
        let mut child = fixture
            .command()
            .args(["--codex-timeout-ms", "2000"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.exists() && Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            marker.exists(),
            "native turn must be admitted before signal"
        );
        kill(Pid::from_raw(i32::try_from(child.id()).unwrap()), signal).unwrap();
        let output = child.wait_with_output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(128 + signal as i32),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["execution"]["status"], "cancelled");
        assert_eq!(
            result["diagnostic"],
            json!({"code":"sevro.run.cancelled","message":"run cancelled"})
        );
        let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
        assert_eq!(evidence["trials"].as_array().unwrap().len(), 1);
        let trial = &evidence["trials"][0];
        let artifacts = trial["artifactRefs"].as_array().unwrap();
        let process = read_json(&artifact_path(
            &artifacts
                .iter()
                .find(|item| item["id"] == "codex.process")
                .unwrap()["path"],
        ));
        for (field, expected) in [
            ("phase", json!("execution")),
            ("reason", json!("cancelled")),
            ("timeoutMs", json!(2000)),
            ("code", json!(137)),
            ("signal", json!("SIGKILL")),
            ("stderrTruncated", json!(false)),
        ] {
            assert_eq!(process[field], expected, "{signal}: {field}");
        }
        let stderr = artifacts
            .iter()
            .find(|item| item["id"] == "codex.stderr")
            .unwrap();
        assert_eq!(
            fs::read(artifact_path(&stderr["path"])).unwrap(),
            b"PRIVATE_CANCELLED_STDERR\n"
        );
        let descendant = fs::read_to_string(marker).unwrap();
        let status = Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", descendant.trim()])
            .output()
            .unwrap();
        let state = String::from_utf8(status.stdout).unwrap();
        assert!(
            state.trim().is_empty() || state.trim().starts_with('Z'),
            "owned descendant survived {signal}: {state}"
        );
        assert_state_removed(&fixture);
        assert!(!String::from_utf8_lossy(&output.stdout).contains("PRIVATE_CANCELLED_STDERR"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("PRIVATE_CANCELLED_STDERR"));
        let workspaces = trial["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "sevro.observation.workspaces")
            .unwrap();
        let retained = Path::new(workspaces["data"]["candidate"].as_str().unwrap());
        assert!(retained.is_dir());
        fs::remove_dir_all(retained).unwrap();
    }
}
