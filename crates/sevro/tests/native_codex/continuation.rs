use super::*;

#[path = "continuation_evidence.rs"]
mod evidence;

#[test]
fn resumes_original_thread_and_grades_second_response() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("project/case.json"),
        serde_json::to_vec(&json!({
            "id":"native-continuation", "prompt":"Wait.", "followUpPrompt":"Continue.",
            "fixture":{"files":{"README.md":"fixture\n"}},
            "checks":[{"id":"final-ready","grader":"sevro.output",
                "configuration":{"expectExact":"follow-up ready"}}],
            "requiredEvidence":["sevro.codex.continuation"]
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        fixture.root.join("binary/codex-wrapper"),
        continuation_script(&fixture),
    )
    .unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"]["status"], "completed");
    assert_eq!(result["task"]["verdict"], "passed");
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = &evidence["trials"][0];
    assert_eq!(trial["usage"]["inputTokens"].as_f64(), Some(17.0));
    assert_eq!(trial["usage"]["outputTokens"].as_f64(), Some(6.0));
    assert_eq!(trial["usage"]["costUsd"], Value::Null);
    assert_eq!(trial["usage"]["complete"], true);
    assert_eq!(
        fs::read_to_string(artifact_path(&trial["rawResult"]["path"])).unwrap(),
        "follow-up ready"
    );
    let observations = trial["observations"].as_array().unwrap();
    let continuation = observations
        .iter()
        .find(|item| item["id"] == "sevro.codex.continuation")
        .unwrap();
    assert_eq!(
        continuation,
        &json!({"id":"sevro.codex.continuation","source":"sevro.host.codex",
            "completeness":"complete","data":{"method":"same_thread_resume",
                "threadId":"thread-1","nativeAfterOrdinal":0,
                "preFollowUpWorktreeUnchanged":true}})
    );
    let artifacts = trial["artifactRefs"].as_array().unwrap();
    assert_eq!(artifacts.len(), 2);
    for (id, hash, message, input, output) in [
        (
            "sevro.codex.events",
            "f2eb4006bf9c12c9eed26cd8ae14f11becbaaa53face28eb1e0fecd2f04f9df8",
            "ready",
            12,
            4,
        ),
        (
            "sevro.codex.follow-up-events",
            "742b2933e9e6ac43828aa74e54087787bf2f0f568591ac206260c4fe2bcf9094",
            "follow-up ready",
            5,
            2,
        ),
    ] {
        let artifact = artifacts.iter().find(|item| item["id"] == id).unwrap();
        assert_eq!(artifact["sha256"], hash);
        let bytes = fs::read_to_string(artifact_path(&artifact["path"])).unwrap();
        let events: Vec<Value> = bytes
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(events[0]["thread_id"], "thread-1");
        assert_eq!(events[1]["item"]["text"], message);
        assert_eq!(
            events[2]["usage"],
            json!({"input_tokens":input,"output_tokens":output})
        );
    }
    for (name, expected) in [
        ("initial-prompt", "Wait."),
        ("resume-prompt", "Continue."),
        ("launches", "initial\nresume\n"),
    ] {
        assert_eq!(
            fs::read_to_string(fixture.root.join("binary").join(name)).unwrap(),
            expected
        );
    }
    let initial = fs::read_to_string(fixture.root.join("binary/initial-argv")).unwrap();
    let resumed = fs::read_to_string(fixture.root.join("binary/resume-argv")).unwrap();
    assert!(initial.starts_with("exec\n--json\n"));
    assert!(!initial.lines().any(|argument| argument == "--ephemeral"));
    assert!(resumed.starts_with("exec\nresume\n--json\n"));
    assert!(resumed.ends_with("thread-1\n-\n"));
    assert!(!resumed.lines().any(|argument| argument == "-C"));
    assert_state_removed(&fixture);
    let workspace = observations
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert!(!Path::new(workspace["data"]["candidate"].as_str().unwrap()).exists());
    assert_eq!(
        fs::read_to_string(fixture.root.join("project/auth.json")).unwrap(),
        "FAKE_NATIVE_TEST_CREDENTIAL\n"
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("FAKE_NATIVE_TEST_CREDENTIAL"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("FAKE_NATIVE_TEST_CREDENTIAL"));
    assert!(!evidence.to_string().contains("FAKE_NATIVE_TEST_CREDENTIAL"));
}

#[test]
fn rejects_failed_follow_up_after_successful_first_turn() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("project/case.json"),
        serde_json::to_vec(&json!({
            "id":"native-continuation", "prompt":"Wait.", "followUpPrompt":"Continue.",
            "fixture":{"files":{"README.md":"fixture\n"}},
            "checks":[{"id":"final-ready","grader":"sevro.output",
                "configuration":{"expectExact":"follow-up ready"}}],
            "requiredEvidence":["sevro.codex.continuation"]
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        fixture.root.join("binary/codex-wrapper"),
        format!(
            "{}\nif [ \"$phase\" = resume ]; then exit 7; fi\nexit 0\n",
            continuation_script(&fixture)
        ),
    )
    .unwrap();
    let output = fixture.invoke();
    assert_failed_turn(&output);
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = &evidence["trials"][0];
    assert_eq!(trial["rawResult"]["sha256"], Value::Null);
    assert!(
        !trial["observations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == "sevro.codex.continuation")
    );
    for (name, expected) in [
        ("initial-prompt", "Wait."),
        ("resume-prompt", "Continue."),
        ("launches", "initial\nresume\n"),
    ] {
        assert_eq!(
            fs::read_to_string(fixture.root.join("binary").join(name)).unwrap(),
            expected
        );
    }
    let initial = fs::read_to_string(fixture.root.join("binary/initial-argv")).unwrap();
    let resumed = fs::read_to_string(fixture.root.join("binary/resume-argv")).unwrap();
    assert!(initial.starts_with("exec\n--json\n"));
    assert!(resumed.starts_with("exec\nresume\n--json\n"));
    assert!(resumed.ends_with("thread-1\n-\n"));
    assert_state_removed(&fixture);
    assert_eq!(
        fs::read_to_string(fixture.root.join("project/auth.json")).unwrap(),
        "FAKE_NATIVE_TEST_CREDENTIAL\n"
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("FAKE_NATIVE_TEST_CREDENTIAL"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("FAKE_NATIVE_TEST_CREDENTIAL"));
    assert!(!evidence.to_string().contains("FAKE_NATIVE_TEST_CREDENTIAL"));
}

#[test]
fn rejects_completed_follow_up_from_different_thread() {
    let fixture = prepared_continuation();
    let script = continuation_script(&fixture).replace(
        "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}'",
        &r#"thread=thread-1
if [ "$phase" = resume ]; then thread=foreign-thread; fi
printf '%s %s\n' "$phase" "$thread" >> @THREADS@
printf '{"type":"thread.started","thread_id":"%s"}\n' "$thread""#
            .replace(
                "@THREADS@",
                &quote(&fixture.root.join("binary/thread-observations")),
            ),
    );
    fs::write(fixture.root.join("binary/codex-wrapper"), script).unwrap();
    let output = fixture.invoke();
    assert_failed_turn(&output);
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = &evidence["trials"][0];
    assert_eq!(trial["rawResult"]["sha256"], Value::Null);
    assert!(
        !trial["observations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == "sevro.codex.continuation")
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("binary/thread-observations")).unwrap(),
        "initial thread-1\nresume foreign-thread\n"
    );
    assert_both_turns(&fixture);
    assert_state_removed(&fixture);
}

#[test]
fn times_out_follow_up_and_stops_owned_descendant() {
    let fixture = prepared_continuation();
    install_stalled_follow_up(&fixture);
    let output = fixture.invoke_with(&["--codex-timeout-ms", "2000"]);
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"failed"}));
    assert_eq!(
        result["diagnostic"],
        json!({"code":"sevro.host.failed","message":"Codex run timed out after 2 s"})
    );
    assert_follow_up_process_failure(&fixture, &output, "timeout");
}

#[test]
fn terminates_follow_up_and_owned_descendant_after_resume_starts() {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    let fixture = prepared_continuation();
    install_stalled_follow_up(&fixture);
    let marker = fixture.root.join("binary/descendant");
    let ready = || fs::read_to_string(&marker).is_ok_and(|pid| !pid.trim().is_empty());
    let mut child = fixture
        .command()
        .args(["--codex-timeout-ms", "2000"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() && Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        ready(),
        "resumed owned descendant must be ready before SIGTERM"
    );
    kill(
        Pid::from_raw(i32::try_from(child.id()).unwrap()),
        Signal::SIGTERM,
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(143),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"cancelled"}));
    assert_eq!(
        result["diagnostic"],
        json!({"code":"sevro.run.cancelled","message":"run cancelled"})
    );
    assert_follow_up_process_failure(&fixture, &output, "cancelled");
}

fn install_stalled_follow_up(fixture: &Fixture) {
    let event = "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}'";
    let stall = r#"if [ "$phase" = resume ]; then
  printf 'PRIVATE_FOLLOW_UP_STDERR\n' >&2
  /bin/sleep 30 &
  descendant=$!
  printf '%s\n' "$descendant" > @PID@
  wait "$descendant"
  exit 0
fi
"#
    .replace("@PID@", &quote(&fixture.root.join("binary/descendant")));
    let script = continuation_script(fixture).replace(event, &(stall + event));
    fs::write(fixture.root.join("binary/codex-wrapper"), script).unwrap();
}

fn assert_follow_up_process_failure(fixture: &Fixture, output: &Output, reason: &str) {
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = &evidence["trials"][0];
    assert_eq!(trial["rawResult"]["path"], Value::Null);
    assert_eq!(trial["rawResult"]["sha256"], Value::Null);
    assert_eq!(
        trial["usage"],
        json!({"inputTokens":null,"outputTokens":null,"costUsd":null,"complete":false})
    );
    let artifacts = trial["artifactRefs"].as_array().unwrap();
    assert_eq!(artifacts.len(), 2);
    let receipt = artifacts
        .iter()
        .find(|item| item["id"] == "codex.process")
        .unwrap();
    let process = read_json(&artifact_path(&receipt["path"]));
    for (field, expected) in [
        ("phase", json!("execution")),
        ("reason", json!(reason)),
        ("timeoutMs", json!(2000)),
        ("code", json!(137)),
        ("signal", json!("SIGKILL")),
        ("stderrTruncated", json!(false)),
    ] {
        assert_eq!(process[field], expected, "{field}");
    }
    assert!(process["durationMs"].as_f64().unwrap() >= 0.0);
    let stderr = artifacts
        .iter()
        .find(|item| item["id"] == "codex.stderr")
        .unwrap();
    assert_eq!(
        stderr["sha256"],
        "05a2f5241e3ef66c65a1663d9eb9c1895af9f046cef1db00df25d7fe59c087dd"
    );
    assert_eq!(
        fs::read(artifact_path(&stderr["path"])).unwrap(),
        b"PRIVATE_FOLLOW_UP_STDERR\n"
    );
    for artifact in artifacts {
        assert_eq!(
            fs::metadata(artifact_path(&artifact["path"]))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let observations = trial["observations"].as_array().unwrap();
    assert!(
        !observations
            .iter()
            .any(|item| item["id"] == "sevro.codex.continuation")
    );
    let workspace = observations
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    let retained = Path::new(workspace["data"]["candidate"].as_str().unwrap());
    assert!(retained.is_dir());
    fs::remove_dir_all(retained).unwrap();
    assert_both_turns(fixture);
    assert_state_removed(fixture);
    let descendant = fs::read_to_string(fixture.root.join("binary/descendant")).unwrap();
    let observed = Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", descendant.trim()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&observed.stdout);
    assert!(
        state.trim().is_empty() || state.trim().starts_with('Z'),
        "owned descendant survived: {state}"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("project/auth.json")).unwrap(),
        "FAKE_NATIVE_TEST_CREDENTIAL\n"
    );
    for public in [
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        evidence.to_string(),
    ] {
        assert!(!public.contains("PRIVATE_FOLLOW_UP_STDERR"));
        assert!(!public.contains("FAKE_NATIVE_TEST_CREDENTIAL"));
    }
}

fn prepared_continuation() -> Fixture {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("project/case.json"),
        serde_json::to_vec(&json!({
            "id":"native-continuation", "prompt":"Wait.", "followUpPrompt":"Continue.",
            "fixture":{"files":{"README.md":"fixture\n"}},
            "checks":[{"id":"final-ready","grader":"sevro.output",
                "configuration":{"expectExact":"follow-up ready"}}],
            "requiredEvidence":["sevro.codex.continuation"]
        }))
        .unwrap(),
    )
    .unwrap();
    fixture
}

fn assert_both_turns(fixture: &Fixture) {
    for (name, expected) in [
        ("initial-prompt", "Wait."),
        ("resume-prompt", "Continue."),
        ("launches", "initial\nresume\n"),
    ] {
        assert_eq!(
            fs::read_to_string(fixture.root.join("binary").join(name)).unwrap(),
            expected
        );
    }
    let resumed = fs::read_to_string(fixture.root.join("binary/resume-argv")).unwrap();
    assert!(resumed.starts_with("exec\nresume\n--json\n"));
    assert!(resumed.ends_with("thread-1\n-\n"));
}

fn continuation_script(fixture: &Fixture) -> String {
    r#"#!/bin/sh
if [ "$1" = --version ]; then printf 'synthetic-native-continuation\n'; exit 0; fi
if [ "$1" = sandbox ]; then shift; exec @CODEX@ sandbox "$@"; fi
if [ "$1" != exec ]; then exit 99; fi
if [ -n "${SEVRO_NATIVE_PRIVATE_SENTINEL-}" ]; then exit 98; fi
if [ "$(/bin/cat "$CODEX_HOME/auth.json")" != FAKE_NATIVE_TEST_CREDENTIAL ]; then exit 97; fi
phase=initial
if [ "$2" = resume ]; then phase=resume; fi
printf '%s\n' "$@" > @BINARY@/"$phase-argv"
prompt=$(/bin/cat)
printf '%s' "$prompt" > @BINARY@/"$phase-prompt"
profile=$(/usr/bin/sed -n 's/^default_permissions = "\(.*\)"/\1/p' "$CODEX_HOME/config.toml")
@CODEX@ sandbox -P "$profile" -C "$PWD" /bin/sh -c '
  test "$(/bin/cat README.md)" = "fixture" || exit 91
  for protected in "$@"; do
    if /bin/cat "$protected" >/dev/null 2>&1; then exit 90; fi
  done
' continuation-boundary-probe @AUTH@ "$CODEX_HOME/auth.json" "$CODEX_HOME/config.toml" || exit 96
printf '%s\n' "$CODEX_HOME" "$HOME" "$TMPDIR" > @BINARY@/native-state-paths
model=
effort=
permissions=
approval=
previous=
thread=
for argument in "$@"; do
  if [ "$previous" = -m ]; then model=$argument; fi
  case "$argument" in
    model_reasoning_effort=*) effort=$argument ;;
    default_permissions=*) permissions=$argument ;;
    approval_policy=*) approval=$argument ;;
    thread-1) thread=$argument ;;
    --ephemeral) exit 95 ;;
  esac
  previous=$argument
done
proof=$(printf '%s\n' "$CODEX_HOME" "$HOME" "$TMPDIR" "$PWD" "$profile" "$model" "$effort" "$permissions" "$approval")
if [ "$phase" = initial ]; then
  test "$prompt" = 'Wait.' || exit 94
  test ! -e "$CODEX_HOME/session-proof" || exit 93
  printf '%s' "$proof" > "$CODEX_HOME/session-proof"
  /bin/mkdir -p "$CODEX_HOME/sessions/2026/10/16"
  printf '%s\n' '{"ordinal":0,"payload":{"type":"session_meta"}}' > "$CODEX_HOME/sessions/2026/10/16/rollout-thread-1.jsonl"
  message=ready
  usage='{"input_tokens":12,"output_tokens":4}'
else
  test "$prompt" = 'Continue.' || exit 94
  test "$thread" = thread-1 || exit 93
  test "$(/bin/cat "$CODEX_HOME/session-proof")" = "$proof" || exit 92
  printf '%s\n' '{"ordinal":1,"payload":{"type":"session_meta"}}' >> "$CODEX_HOME/sessions/2026/10/16/rollout-thread-1.jsonl"
  message='follow-up ready'
  usage='{"input_tokens":5,"output_tokens":2}'
fi
printf '%s\n' "$phase" >> @BINARY@/launches
printf '%s\n' '{"type":"thread.started","thread_id":"thread-1"}'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\n' "$message"
printf '{"type":"turn.completed","usage":%s}\n' "$usage"
"#
    .replace("@CODEX@", &quote(&installed_codex()))
    .replace("@AUTH@", &quote(&fixture.root.join("project/auth.json")))
    .replace("@BINARY@", &quote(&fixture.root.join("binary")))
}
