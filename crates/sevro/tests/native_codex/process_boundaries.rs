use super::*;

#[test]
fn ignores_non_agent_items_and_non_text_messages() {
    for (item, expected) in [
        (
            "{\"type\":\"command_execution\",\"text\":\"wrong\"}",
            Some("ready"),
        ),
        ("null", Some("ready")),
        ("{\"type\":\"agent_message\",\"text\":17}", None),
    ] {
        let fixture = Fixture::new();
        let following = if expected.is_some() { MESSAGE } else { "" };
        let stream = format!(
            "{THREAD}{{\"type\":\"item.completed\",\"item\":{item}}}\n{following}{COMPLETED}"
        );
        fixture.transcript(stream.as_bytes(), 0);
        let output = fixture.invoke();
        assert_eq!(output.status.code(), Some(0));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
        let raw = &evidence["trials"][0]["rawResult"]["path"];
        match expected {
            Some(text) => assert_eq!(fs::read_to_string(artifact_path(raw)).unwrap(), text),
            None => assert_eq!(raw, &Value::Null),
        }
        assert_state_removed(&fixture);
    }
}

#[test]
fn rejects_invalid_utf8_transcript() {
    let fixture = Fixture::new();
    fixture.transcript(b"\xff\n", 0);
    assert_failed_turn(&fixture.invoke());
    assert_state_removed(&fixture);
}

#[test]
fn rejects_oversized_stdout_and_stops_owned_descendant() {
    let fixture = Fixture::new();
    fixture.transcript(&vec![b'x'; 8 * 1024 * 1024 + 1], 0);
    let binary = fixture.root.join("binary/codex-wrapper");
    let marker = fixture.root.join("binary/descendant");
    let script = fs::read_to_string(&binary).unwrap().replace(
        &format!(
            "/bin/cat {}\nexit 0",
            quote(&fixture.root.join("binary/transcript"))
        ),
        &format!(
            "/bin/sleep 30 &\nprintf '%s\\n' \"$!\" > {}\n/bin/cat {}\nwait",
            quote(&marker),
            quote(&fixture.root.join("binary/transcript"))
        ),
    );
    fs::write(binary, script).unwrap();
    assert_failed_turn(&fixture.invoke());
    assert_state_removed(&fixture);
    let descendant = fs::read_to_string(marker).unwrap();
    let status = Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", descendant.trim()])
        .output()
        .unwrap();
    let state = String::from_utf8(status.stdout).unwrap();
    assert!(
        state.trim().is_empty() || state.trim().starts_with('Z'),
        "owned descendant survived stdout overflow: {state}"
    );
}

#[test]
fn drains_inherited_stdout_and_stderr_after_native_parent_exit() {
    for late in ["stdout", "stderr"] {
        let fixture = Fixture::new();
        let stream = format!("{THREAD}{MESSAGE}{COMPLETED}");
        fixture.transcript(stream.as_bytes(), 0);
        let binary = fixture.root.join("binary/codex-wrapper");
        let payload = quote(&fixture.root.join("binary/transcript"));
        let tail = if late == "stdout" {
            format!("(/bin/sleep 0.1; /bin/cat {payload}) &\nexit 0")
        } else {
            format!(
                "/bin/cat {payload}\n(/bin/sleep 0.1; printf private-late-stderr >&2) >/dev/null &\nexit 0"
            )
        };
        let script = fs::read_to_string(&binary)
            .unwrap()
            .replace(&format!("/bin/cat {payload}\nexit 0"), &tail);
        fs::write(binary, script).unwrap();
        let output = fixture.invoke();
        assert_eq!(
            output.status.code(),
            Some(0),
            "{late}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
        let trial = &evidence["trials"][0];
        assert_eq!(
            fs::read(artifact_path(&trial["rawResult"]["path"])).unwrap(),
            b"ready"
        );
        assert_eq!(
            fs::read(artifact_path(&trial["artifactRefs"][0]["path"])).unwrap(),
            stream.as_bytes()
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private-late-stderr"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("private-late-stderr"));
        assert_state_removed(&fixture);
    }
}

#[test]
fn retains_bounded_stderr_from_failed_preflight() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("binary/stderr"), vec![b's'; 65537]).unwrap();
    fs::write(fixture.root.join("binary/codex-wrapper"), format!("#!/bin/sh\nif [ \"$1\" = sandbox ]; then /bin/cat {} >&2; exit 70; fi\ntouch {}; exit 99\n", quote(&fixture.root.join("binary/stderr")), quote(&fixture.root.join("binary/model-started")))).unwrap();
    let output = fixture.invoke();
    assert_eq!(output.status.code(), Some(2));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = &evidence["trials"][0];
    let artifacts = trial["artifactRefs"].as_array().unwrap();
    let process = read_json(&artifact_path(
        &artifacts
            .iter()
            .find(|item| item["id"] == "codex.process")
            .unwrap()["path"],
    ));
    assert_eq!(process["stderrTruncated"], true);
    assert_eq!(process["code"], 70);
    let path = artifact_path(
        &artifacts
            .iter()
            .find(|item| item["id"] == "codex.stderr")
            .unwrap()["path"],
    );
    assert_eq!(fs::read(&path).unwrap(), vec![b's'; 65536]);
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(!fixture.root.join("binary/model-started").exists());
    cleanup_failed_workspace(trial);
}

fn cleanup_failed_workspace(trial: &Value) {
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

#[test]
fn classifies_executable_preflight_failure_without_starting_turn() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("binary/codex-wrapper"), format!("#!/bin/sh\nif [ \"$1\" = --version ]; then exit 1; fi\nif [ \"$1\" = sandbox ]; then shift; exec {} sandbox \"$@\"; fi\ntouch {}; exit 99\n", quote(&installed_codex()), quote(&fixture.root.join("binary/model-started")))).unwrap();
    let output = fixture.invoke();
    assert_eq!(output.status.code(), Some(2));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result["diagnostic"]["message"],
        "Codex executable preflight failed"
    );
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = &evidence["trials"][0];
    let artifacts = trial["artifactRefs"].as_array().unwrap();
    let process = read_json(&artifact_path(
        &artifacts
            .iter()
            .find(|item| item["id"] == "codex.process")
            .unwrap()["path"],
    ));
    assert_eq!(process["phase"], "executable-preflight");
    assert_eq!(process["code"], 71);
    assert_eq!(process["reason"], "exit");
    assert!(!fixture.root.join("binary/model-started").exists());
    cleanup_failed_workspace(trial);
}

#[test]
fn records_native_launch_failure() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("binary/codex-wrapper"),
        "#!/missing-sevro-test-interpreter\n",
    )
    .unwrap();
    assert_failed_turn(&fixture.invoke());
}

#[test]
fn protects_relocated_standalone_executable_beside_native_binary() {
    let fixture = Fixture::new();
    let installed = fixture.root.join("binary/sevro");
    fs::copy(env!("CARGO_BIN_EXE_sevro"), &installed).unwrap();
    let wrapper = fixture.root.join("binary/codex-wrapper");
    let script = fs::read_to_string(&wrapper)
        .unwrap()
        .replace(
            "\"$peer/private-input\" || exit 92",
            &format!("\"$peer/private-input\" {} || exit 92", quote(&installed)),
        )
        .replace(
            "then exit 89; fi",
            "then printf '%s' \"$protected\" > protected-readable; exit 89; fi",
        );
    fs::write(wrapper, script).unwrap();
    let output = fixture.command_with(&installed).output().unwrap();
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let workspace = evidence["trials"][0]["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    let readable =
        Path::new(workspace["data"]["candidate"].as_str().unwrap()).join("protected-readable");
    assert!(
        !readable.exists(),
        "sandbox read protected assessment artifact: {}",
        fs::read_to_string(&readable).unwrap_or_default()
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read(artifact_path(&evidence["trials"][0]["rawResult"]["path"])).unwrap(),
        b"ready"
    );
    assert_state_removed(&fixture);
    assert!(
        installed.is_file(),
        "installed assessment artifact must remain available to the runner"
    );
}

#[test]
fn applies_deadline_after_native_parent_exits_with_descendant_holding_pipes() {
    let fixture = Fixture::new();
    fixture.transcript(b"", 0);
    let binary = fixture.root.join("binary/codex-wrapper");
    let marker = fixture.root.join("binary/descendant");
    let script = fs::read_to_string(&binary).unwrap().replace(
        &format!("/bin/cat {}\nexit 0", quote(&fixture.root.join("binary/transcript"))),
        &format!("printf 'PRIVATE_HELD_PIPE_STDERR\\n' >&2\n/bin/sleep 30 &\nprintf '%s\\n' \"$!\" > {}\nexit 0", quote(&marker)),
    );
    fs::write(binary, script).unwrap();
    let output = fixture.invoke_with(&["--codex-timeout-ms", "200"]);
    assert_eq!(output.status.code(), Some(2));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result["diagnostic"]["message"],
        "Codex run timed out after 0.2 s"
    );
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
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
        ("reason", json!("timeout")),
        ("timeoutMs", json!(200)),
        ("code", json!(0)),
        ("signal", Value::Null),
    ] {
        assert_eq!(process[field], expected, "{field}");
    }
    let stderr = artifacts
        .iter()
        .find(|item| item["id"] == "codex.stderr")
        .unwrap();
    assert_eq!(
        fs::read(artifact_path(&stderr["path"])).unwrap(),
        b"PRIVATE_HELD_PIPE_STDERR\n"
    );
    let descendant = fs::read_to_string(marker).unwrap();
    let status = Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", descendant.trim()])
        .output()
        .unwrap();
    let state = String::from_utf8(status.stdout).unwrap();
    assert!(
        state.trim().is_empty() || state.trim().starts_with('Z'),
        "owned pipe-holding descendant survived: {state}"
    );
    assert_state_removed(&fixture);
    cleanup_failed_workspace(trial);
}

#[test]
fn permits_absent_optional_host_configuration_root() {
    let fixture = Fixture::new();
    let output = fixture
        .command()
        .env("CODEX_HOME", fixture.root.join("absent-config"))
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_state_removed(&fixture);
}

#[cfg(target_os = "macos")]
#[test]
fn validates_existing_native_namespace_at_macos_temporary_root() {
    for kind in ["private", "shared", "symlink", "file"] {
        let fixture = Fixture::new();
        let namespace = fixture.root.join("temporary/sevro-native-private");
        match kind {
            "file" => fs::write(&namespace, "not a directory").unwrap(),
            "symlink" => {
                let target = fixture.root.join("symlink-target");
                fs::create_dir(&target).unwrap();
                fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
                std::os::unix::fs::symlink(target, &namespace).unwrap();
            }
            _ => {
                fs::create_dir(&namespace).unwrap();
                fs::set_permissions(
                    &namespace,
                    fs::Permissions::from_mode(if kind == "private" { 0o700 } else { 0o755 }),
                )
                .unwrap();
            }
        }
        if kind == "private" {
            let output = fixture.invoke();
            assert_eq!(
                output.status.code(),
                Some(0),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_state_removed(&fixture);
            assert_eq!(
                fs::metadata(namespace).unwrap().permissions().mode() & 0o777,
                0o700
            );
        } else {
            require_no_native_launch(&fixture);
            assert_failed_turn(&fixture.invoke());
            assert!(!fixture.root.join("binary/launched").exists(), "{kind}");
        }
    }
}
