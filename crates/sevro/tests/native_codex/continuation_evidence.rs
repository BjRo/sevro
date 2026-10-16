use super::*;

#[test]
fn marks_unreadable_workspace_continuation_partial() {
    let fixture = prepared_continuation();
    install_initial_mutation(
        &fixture,
        "printf 'PRIVATE_WORKSPACE_CONTENT\\n' > unreadable.txt\n  /bin/chmod 000 unreadable.txt",
    );
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["grading"], json!({"status":"unavailable"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    let trial = assert_completed_turns(&fixture, &output);
    let observations = trial["observations"].as_array().unwrap();
    let continuation = observations
        .iter()
        .find(|item| item["id"] == "sevro.codex.continuation")
        .unwrap();
    assert_eq!(
        continuation,
        &json!({"id":"sevro.codex.continuation","source":"sevro.host.codex",
        "completeness":"partial","data":{"method":"same_thread_resume","threadId":"thread-1",
            "nativeAfterOrdinal":0,"preFollowUpWorktreeUnchanged":null}})
    );
    let workspace = observations
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    let retained = Path::new(workspace["data"]["candidate"].as_str().unwrap());
    assert!(retained.is_dir());
    assert_eq!(
        fs::metadata(retained.join("unreadable.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0
    );
    assert!(fs::read(retained.join("unreadable.txt")).is_err());
    fs::remove_dir_all(retained).unwrap();
}

#[test]
fn keeps_continuation_complete_when_session_file_is_missing() {
    let fixture = prepared_continuation();
    install_initial_mutation(
        &fixture,
        "/bin/rm \"$CODEX_HOME/sessions/2026/10/16/rollout-thread-1.jsonl\"",
    );
    assert_unknown_session_ordinal(&fixture, &fixture.invoke());
}

#[test]
fn discards_session_ordinal_after_malformed_tail() {
    let fixture = prepared_continuation();
    install_initial_mutation(
        &fixture,
        "printf 'PRIVATE_SESSION_CONTENT-not-json\\n' >> \"$CODEX_HOME/sessions/2026/10/16/rollout-thread-1.jsonl\"",
    );
    assert_unknown_session_ordinal(&fixture, &fixture.invoke());
}

#[test]
fn discards_session_ordinal_when_ordinals_repeat() {
    let fixture = prepared_continuation();
    install_initial_mutation(
        &fixture,
        r#"printf '%s\n' '{"ordinal":0,"payload":{"type":"session_meta","note":"PRIVATE_SESSION_CONTENT"}}' >> "$CODEX_HOME/sessions/2026/10/16/rollout-thread-1.jsonl""#,
    );
    assert_unknown_session_ordinal(&fixture, &fixture.invoke());
}

#[test]
fn discards_session_ordinal_when_stream_exceeds_byte_limit() {
    let fixture = prepared_continuation();
    install_initial_mutation(
        &fixture,
        "printf '%8388609s' ' ' >> \"$CODEX_HOME/sessions/2026/10/16/rollout-thread-1.jsonl\"",
    );
    assert_unknown_session_ordinal(&fixture, &fixture.invoke());
}

#[test]
fn discards_session_ordinal_when_multiple_files_match_thread() {
    let fixture = prepared_continuation();
    install_initial_mutation(
        &fixture,
        "/bin/cp \"$CODEX_HOME/sessions/2026/10/16/rollout-thread-1.jsonl\" \"$CODEX_HOME/sessions/2026/10/16/duplicate-thread-1.jsonl\"",
    );
    assert_unknown_session_ordinal(&fixture, &fixture.invoke());
}

#[test]
fn discards_negative_session_ordinal() {
    let fixture = prepared_continuation();
    install_initial_mutation(
        &fixture,
        r#"printf '%s\n' '{"ordinal":-1,"payload":{"type":"session_meta"}}' > "$CODEX_HOME/sessions/2026/10/16/rollout-thread-1.jsonl""#,
    );
    assert_unknown_session_ordinal(&fixture, &fixture.invoke());
}

#[test]
fn discards_fractional_session_ordinal() {
    let fixture = prepared_continuation();
    install_initial_mutation(
        &fixture,
        r#"printf '%s\n' '{"ordinal":0.5,"payload":{"type":"session_meta"}}' > "$CODEX_HOME/sessions/2026/10/16/rollout-thread-1.jsonl""#,
    );
    assert_unknown_session_ordinal(&fixture, &fixture.invoke());
}

#[test]
fn discards_session_ordinal_above_safe_integer_limit() {
    let fixture = prepared_continuation();
    install_initial_mutation(
        &fixture,
        r#"printf '%s\n' '{"ordinal":9007199254740992,"payload":{"type":"session_meta"}}' > "$CODEX_HOME/sessions/2026/10/16/rollout-thread-1.jsonl""#,
    );
    assert_unknown_session_ordinal(&fixture, &fixture.invoke());
}

#[test]
fn records_changed_file_content_before_follow_up() {
    let fixture = prepared_continuation();
    let case_file = fixture.root.join("project/case.json");
    let mut definition = read_json(&case_file);
    definition["fixture"]["files"]["document.txt"] = json!("before\n");
    fs::write(case_file, serde_json::to_vec(&definition).unwrap()).unwrap();
    install_initial_mutation(
        &fixture,
        r#"test "$(/bin/cat document.txt)" = before || exit 91
  printf 'after\n' > document.txt
  test "$(/bin/cat document.txt)" = after || exit 91"#,
    );
    assert_workspace_comparison(&fixture, &fixture.invoke(), false);
}

#[test]
fn records_added_empty_directory_before_follow_up() {
    let fixture = prepared_continuation();
    install_initial_mutation(
        &fixture,
        "test ! -e empty-directory || exit 91\n  /bin/mkdir empty-directory\n  test -d empty-directory || exit 91",
    );
    assert_workspace_comparison(&fixture, &fixture.invoke(), false);
}

#[test]
fn records_changed_symlink_target_before_follow_up() {
    let fixture = prepared_continuation();
    let source = fixture.root.join("project/sources/example");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("README.md"), "fixture\n").unwrap();
    for name in ["first.txt", "second.txt"] {
        fs::write(source.join(name), "identical target content\n").unwrap();
    }
    std::os::unix::fs::symlink("first.txt", source.join("document")).unwrap();
    prepare_repository_case(&fixture, &source);
    install_initial_mutation(
        &fixture,
        r#"test "$(/usr/bin/readlink document)" = first.txt || exit 91
  /bin/rm document
  /bin/ln -s second.txt document
  test "$(/usr/bin/readlink document)" = second.txt || exit 91"#,
    );
    let output = fixture.invoke_with(&[
        "--case-source-root",
        "sources",
        "--case-source-map-file",
        "source-map.json",
    ]);
    assert_workspace_comparison(&fixture, &output, false);
    assert_eq!(
        fs::read_link(source.join("document")).unwrap(),
        Path::new("first.txt")
    );
    for name in ["first.txt", "second.txt"] {
        assert_eq!(
            fs::read_to_string(source.join(name)).unwrap(),
            "identical target content\n"
        );
    }
}

#[test]
fn records_changed_executable_bit_before_follow_up() {
    let fixture = prepared_continuation();
    let case_file = fixture.root.join("project/case.json");
    let mut definition = read_json(&case_file);
    definition["fixture"]["files"]["document.txt"] = json!("before\n");
    fs::write(case_file, serde_json::to_vec(&definition).unwrap()).unwrap();
    install_initial_mutation(
        &fixture,
        r#"test ! -x document.txt || exit 91
  /bin/chmod 700 document.txt
  test -x document.txt || exit 91
  test "$(/bin/cat document.txt)" = before || exit 91"#,
    );
    assert_workspace_comparison(&fixture, &fixture.invoke(), false);
}

#[test]
fn ignores_git_private_changes_before_follow_up() {
    let fixture = prepared_continuation();
    let source = fixture.root.join("project/sources/example");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("README.md"), "fixture\n").unwrap();
    prepare_repository_case(&fixture, &source);
    install_initial_mutation(
        &fixture,
        r#"test -d .git || exit 91
  printf 'PRIVATE_GIT_STATE\n' > .git/sevro-fingerprint-probe
  test "$(/bin/cat .git/sevro-fingerprint-probe)" = PRIVATE_GIT_STATE || exit 91"#,
    );
    let output = fixture.invoke_with(&[
        "--case-source-root",
        "sources",
        "--case-source-map-file",
        "source-map.json",
    ]);
    assert_workspace_comparison(&fixture, &output, true);
    assert!(!source.join(".git/sevro-fingerprint-probe").exists());
    assert_eq!(
        fs::read_to_string(source.join("README.md")).unwrap(),
        "fixture\n"
    );
}

fn prepare_repository_case(fixture: &Fixture, source: &Path) {
    fixture_git(source, &["init", "--quiet", "--initial-branch=main"]);
    fixture_git(source, &["add", "--all"]);
    fixture_git(
        source,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "Create fingerprint fixture",
        ],
    );
    let case_file = fixture.root.join("project/case.json");
    let mut definition = read_json(&case_file);
    definition["fixture"] = json!({"sourceRef":"fingerprint-repo"});
    fs::write(case_file, serde_json::to_vec(&definition).unwrap()).unwrap();
    fs::write(
        fixture.root.join("project/source-map.json"),
        serde_json::to_vec(&json!({
            "fingerprint-repo":url::Url::from_directory_path(source).unwrap().as_str()
        }))
        .unwrap(),
    )
    .unwrap();
}

fn assert_workspace_comparison(fixture: &Fixture, output: &Output, unchanged: bool) {
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["grading"], json!({"status":"completed"}));
    assert_eq!(result["task"], json!({"verdict":"passed"}));
    let trial = assert_completed_turns(fixture, output);
    let observations = trial["observations"].as_array().unwrap();
    let continuation = observations
        .iter()
        .find(|item| item["id"] == "sevro.codex.continuation")
        .unwrap();
    assert_eq!(
        continuation,
        &json!({"id":"sevro.codex.continuation","source":"sevro.host.codex",
        "completeness":"complete","data":{"method":"same_thread_resume","threadId":"thread-1",
            "nativeAfterOrdinal":0,"preFollowUpWorktreeUnchanged":unchanged}})
    );
    let workspace = observations
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert!(!Path::new(workspace["data"]["candidate"].as_str().unwrap()).exists());
}

fn assert_unknown_session_ordinal(fixture: &Fixture, output: &Output) {
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["grading"], json!({"status":"completed"}));
    assert_eq!(result["task"], json!({"verdict":"passed"}));
    let trial = assert_completed_turns(fixture, output);
    let observations = trial["observations"].as_array().unwrap();
    let continuation = observations
        .iter()
        .find(|item| item["id"] == "sevro.codex.continuation")
        .unwrap();
    assert_eq!(
        continuation,
        &json!({"id":"sevro.codex.continuation","source":"sevro.host.codex",
        "completeness":"complete","data":{"method":"same_thread_resume","threadId":"thread-1",
            "nativeAfterOrdinal":null,"preFollowUpWorktreeUnchanged":true}})
    );
    let workspace = observations
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert!(!Path::new(workspace["data"]["candidate"].as_str().unwrap()).exists());
}

fn install_initial_mutation(fixture: &Fixture, mutation: &str) {
    let script = continuation_script(fixture)
        .replace("  message=ready", &format!("  {mutation}\n  message=ready"));
    fs::write(fixture.root.join("binary/codex-wrapper"), script).unwrap();
}

fn assert_completed_turns(fixture: &Fixture, output: &Output) -> Value {
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"completed"}));
    assert_eq!(
        result["cases"][0]["trials"][0]["checks"],
        json!([{"id":"final-ready","grader":"sevro.output",
        "status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}])
    );
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
    let artifacts = trial["artifactRefs"].as_array().unwrap();
    assert_eq!(artifacts.len(), 2);
    for (id, hash) in [
        (
            "sevro.codex.events",
            "f2eb4006bf9c12c9eed26cd8ae14f11becbaaa53face28eb1e0fecd2f04f9df8",
        ),
        (
            "sevro.codex.follow-up-events",
            "742b2933e9e6ac43828aa74e54087787bf2f0f568591ac206260c4fe2bcf9094",
        ),
    ] {
        let artifact = artifacts.iter().find(|item| item["id"] == id).unwrap();
        assert_eq!(artifact["sha256"], hash);
        assert_eq!(
            fs::metadata(artifact_path(&artifact["path"]))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert_both_turns(fixture);
    assert_state_removed(fixture);
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
        assert!(!public.contains("PRIVATE_WORKSPACE_CONTENT"));
        assert!(!public.contains("PRIVATE_SESSION_CONTENT"));
        assert!(!public.contains("PRIVATE_GIT_STATE"));
    }
    trial.clone()
}
