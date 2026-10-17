use super::*;

#[test]
fn ignores_empty_git_mount_placeholder_in_temporary_root() {
    let fixture = Fixture::new();
    let stream = format!("{THREAD}{MESSAGE}{COMPLETED}");
    fixture.transcript(stream.as_bytes(), 0);
    let metadata = fixture.root.join(".git");
    fs::create_dir(&metadata).unwrap();

    // The unchanged TypeScript CLI is the independent public oracle for the
    // Linux sandbox's empty mount placeholder at the actual temporary root.
    let mut candidate = fixture.command();
    candidate.env("TMPDIR", &fixture.root);
    let mut reference = Command::new("bun");
    reference
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/cli.ts"))
        .args(candidate.get_args())
        .current_dir(candidate.get_current_dir().unwrap());
    for (name, value) in candidate.get_envs() {
        reference.env(name, value.unwrap());
    }

    for (implementation, mut command) in [("TypeScript", reference), ("Rust", candidate)] {
        let output = command.output().unwrap();
        assert_completed(&fixture, implementation, &output, &stream);
        assert_eq!(fs::read_dir(&metadata).unwrap().count(), 0);
        assert_eq!(
            fs::read_to_string(fixture.root.join("project/auth.json")).unwrap(),
            "FAKE_NATIVE_TEST_CREDENTIAL\n"
        );
        assert_state_removed(&fixture);
        fs::remove_file(fixture.root.join("binary/native-state-paths")).unwrap();
        eprintln!("{implementation}: empty temporary Git placeholder native execution completed");
    }
}

fn assert_completed(fixture: &Fixture, implementation: &str, output: &Output, stream: &str) {
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = &evidence["trials"][0];
    let workspaces = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    let workspace = Path::new(workspaces["data"]["candidate"].as_str().unwrap());
    let workspace_removed = !workspace.exists();
    if !workspace_removed {
        // This path belongs to this invocation's actual retained trial. Clean
        // it before asserting so the intentional regression failure leaks none.
        fs::remove_dir_all(workspace).unwrap();
    }
    assert_eq!(
        output.status.code(),
        Some(0),
        "{implementation}: {} {}",
        String::from_utf8_lossy(&output.stdout[..output.stdout.len().min(4096)]),
        String::from_utf8_lossy(&output.stderr[..output.stderr.len().min(4096)])
    );
    assert_eq!(result["execution"]["status"], "completed");
    assert!(
        workspace_removed,
        "{implementation} left a successful workspace"
    );
    assert_eq!(
        fs::read_to_string(artifact_path(&trial["rawResult"]["path"])).unwrap(),
        "ready"
    );
    assert_eq!(trial["usage"]["inputTokens"].as_f64(), Some(12.0));
    assert_eq!(trial["usage"]["outputTokens"].as_f64(), Some(4.0));
    assert_eq!(trial["usage"]["complete"], true);
    let events = trial["artifactRefs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.codex.events")
        .unwrap();
    assert_eq!(
        fs::read_to_string(artifact_path(&events["path"])).unwrap(),
        stream
    );
    assert!(fixture.root.join("binary/native-state-paths").is_file());
    for bytes in [&output.stdout, &output.stderr] {
        assert!(!String::from_utf8_lossy(bytes).contains("FAKE_NATIVE_TEST_CREDENTIAL"));
    }
    assert!(!evidence.to_string().contains("FAKE_NATIVE_TEST_CREDENTIAL"));
}
