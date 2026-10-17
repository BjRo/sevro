use super::{RepositoryFixture, boundaries::failure, git};
use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::{Pid, getpgid};
use serde_json::{Value, json};
use std::fs;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

fn invoke(
    fixture: &RepositoryFixture,
    declaration: Value,
    setup: Value,
    capabilities: Value,
) -> Output {
    fixture.extension(
        declaration,
        json!({
            "artifacts":[],"requestedInstrumentation":[],"extensionData":{},"fixtureSetup":setup
        }),
        capabilities,
    );
    fixture.invoke_source(&[
        "--extension-command-file",
        "setup-command.json",
        "--extension-source-file",
        "setup-extension.mjs",
        "--case-id",
        "repository-setup",
    ])
}

#[test]
fn rejects_invalid_setup_declarations_before_host_execution() {
    for (scenario, message) in [
        ("relative-command", "invalid fixture setup command"),
        ("nul-argument", "invalid fixture setup command"),
        ("oversize-command", "invalid fixture setup command"),
        ("reserved-environment", "invalid fixture setup environment"),
        ("lowercase-environment", "invalid fixture setup environment"),
        ("invalid-name", "invalid fixture setup environment"),
        ("nul-value", "invalid fixture setup environment"),
        ("unknown-placeholder", "invalid fixture setup environment"),
        ("too-many-environment", "invalid fixture setup environment"),
        ("oversize-environment", "invalid fixture setup environment"),
        ("inline-fixture", "fixture setup requires a Git fixture"),
        (
            "unnegotiated",
            "fixture setup capability was not negotiated",
        ),
    ] {
        let fixture = RepositoryFixture::new();
        let mut declaration = json!({"kind":"repository","sourceRef":"fixture-repo"});
        let mut setup = json!({"command":["/bin/sh","-c","exit 0"],"environment":{}});
        let mut capabilities = json!(["sevro.fixture.setup"]);
        match scenario {
            "relative-command" => setup["command"][0] = json!("sh"),
            "nul-argument" => setup["command"][2] = json!("exit 0\0"),
            "oversize-command" => setup["command"][2] = json!("x".repeat(65536)),
            "reserved-environment" => setup["environment"] = json!({"PATH":"/tmp"}),
            "lowercase-environment" => setup["environment"] = json!({"lowercase":"value"}),
            "invalid-name" => setup["environment"] = json!({"A-B":"value"}),
            "nul-value" => setup["environment"] = json!({"A":"value\0"}),
            "unknown-placeholder" => setup["environment"] = json!({"A":"{{unknown}}"}),
            "too-many-environment" => {
                setup["environment"] = Value::Object(
                    (0..33)
                        .map(|index| (format!("A{index}"), json!("value")))
                        .collect(),
                )
            }
            "oversize-environment" => setup["environment"] = json!({"A":"x".repeat(16384)}),
            "inline-fixture" => declaration = json!({"kind":"inline","files":{}}),
            "unnegotiated" => capabilities = json!([]),
            _ => unreachable!(),
        }
        let output = invoke(&fixture, declaration, setup, capabilities);
        assert_eq!(
            output.status.code(),
            Some(64),
            "{scenario}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result, failure(64, message), "{scenario}");
        assert!(
            !fixture.root.join("native-invocations").exists(),
            "{scenario}"
        );
        assert_eq!(
            fs::read_to_string(fixture.source.join("README.md")).unwrap(),
            "repository fixture\n"
        );
        assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    }
}

#[test]
fn preserves_literal_setup_environment_values() {
    let fixture = RepositoryFixture::new();
    let output = invoke(
        &fixture,
        json!({"kind":"repository","sourceRef":"fixture-repo"}),
        json!({"command":["/bin/sh","-c","[ \"$A0_B\" = 'literal $HOME' ]"],"environment":{"A0_B":"literal $HOME"}}),
        json!(["sevro.fixture.setup"]),
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"not_run"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    assert!(std::path::Path::new(result["evidencePath"].as_str().unwrap()).is_file());
    assert!(!fixture.root.join("native-invocations").exists());
}

#[test]
fn cancels_setup_descendants_and_retains_the_admitted_trial() {
    for (signal, exit) in [(Signal::SIGINT, 130), (Signal::SIGTERM, 143)] {
        let fixture = RepositoryFixture::new();
        fixture.setup_extension(r#"(sleep 2; printf late > "$PROJECT_ROOT/setup-late") & child=$!; printf '%s\n' "$$" "$child" "$HOME" "$PWD" > "$PROJECT_ROOT/setup-started"; wait "$child""#);
        let mut child = fixture
            .command(&[
                "--extension-command-file",
                "setup-command.json",
                "--extension-source-file",
                "setup-extension.mjs",
                "--case-id",
                "repository-setup",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let ready = loop {
            if let Ok(value) = fs::read_to_string(fixture.root.join("setup-started"))
                && value.lines().count() == 4
            {
                break value;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("setup fixture did not start");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let fields: Vec<&str> = ready.lines().collect();
        let setup_pid = Pid::from_raw(fields[0].parse().unwrap());
        kill(Pid::from_raw(child.id() as i32), signal).unwrap();
        let output = child.wait_with_output().unwrap();
        std::thread::sleep(Duration::from_millis(2200));
        let descendant_survived = fixture.root.join("setup-late").exists();
        // Always stop this test's known process group, including an expected red.
        let _ = killpg(setup_pid, Signal::SIGKILL);
        assert_eq!(
            output.status.code(),
            Some(exit),
            "{signal:?}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["execution"], json!({"status":"cancelled"}));
        assert_eq!(result["grading"], json!({"status":"not_requested"}));
        assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
        assert_eq!(
            result["diagnostic"],
            json!({"code":"sevro.run.cancelled","message":"run cancelled"})
        );
        let evidence: Value =
            serde_json::from_slice(&fs::read(result["evidencePath"].as_str().unwrap()).unwrap())
                .unwrap();
        assert_eq!(evidence["result"], result);
        let summary = &result["cases"][0]["trials"][0];
        assert_eq!(summary["execution"], json!({"status":"cancelled"}));
        let retained_trial: Value =
            serde_json::from_slice(&fs::read(summary["artifactPath"].as_str().unwrap()).unwrap())
                .unwrap();
        assert_eq!(retained_trial["result"], *summary);
        let trial = &evidence["trials"][0];
        assert_eq!(trial["executionMode"], "dry");
        assert_eq!(trial["candidateDurationMs"], Value::Null);
        assert_eq!(trial["rawResult"]["path"], Value::Null);
        assert_eq!(trial["observationCompleteness"], "unavailable");
        let workspace = trial["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "sevro.observation.workspaces")
            .unwrap()["data"]["candidate"]
            .as_str()
            .unwrap();
        assert_eq!(workspace, fields[3]);
        assert_eq!(
            fs::read_to_string(std::path::Path::new(workspace).join("README.md")).unwrap(),
            "repository fixture\n"
        );
        assert!(
            !std::path::Path::new(fields[2]).exists(),
            "private setup home survived {signal:?}"
        );
        assert!(!descendant_survived, "setup descendant survived {signal:?}");
        assert!(!fixture.root.join("native-invocations").exists());
        assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
        fs::remove_dir_all(workspace).unwrap();
    }
}

#[test]
fn times_out_setup_after_two_minutes_and_terminates_its_descendant() {
    let fixture = RepositoryFixture::new();
    fixture.setup_extension(
        r#"set -eu
printf '%s\n' "$$" > "$PROJECT_ROOT/setup-owner"
/bin/sh -c 'printf "%s\n" "$$" > "$PROJECT_ROOT/descendant-ready"; while [ ! -e "$PROJECT_ROOT/release-descendant" ]; do sleep 0.1; done; printf late > "$PROJECT_ROOT/descendant-late"' &
descendant=$!
while [ ! -s "$PROJECT_ROOT/descendant-ready" ]; do sleep 0.01; done
printf '%s\n' "$$" "$descendant" "$HOME" "$PWD" > "$PROJECT_ROOT/setup-started"
wait "$descendant"
"#,
    );
    let started = Instant::now();
    let process = fixture
        .command(&[
            "--extension-command-file",
            "setup-command.json",
            "--extension-source-file",
            "setup-extension.mjs",
            "--case-id",
            "repository-setup",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .unwrap();
    let mut owned = DeadlineProcesses {
        process: Some(process),
        root: fixture.root.clone(),
        workspace: None,
    };
    let ready = loop {
        if let Ok(value) = fs::read_to_string(fixture.root.join("setup-started"))
            && value.lines().count() == 4
        {
            break value;
        }
        assert!(
            owned
                .process
                .as_mut()
                .unwrap()
                .try_wait()
                .unwrap()
                .is_none(),
            "CLI exited before setup readiness"
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "setup and descendant did not become ready within ten seconds"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let fields: Vec<&str> = ready.lines().collect();
    let setup_pid = Pid::from_raw(fields[0].parse().unwrap());
    let descendant_pid = Pid::from_raw(fields[1].parse().unwrap());
    owned.workspace = Some(PathBuf::from(fields[3]));
    assert_eq!(
        fs::read_to_string(fixture.root.join("descendant-ready"))
            .unwrap()
            .trim(),
        fields[1]
    );
    kill(setup_pid, None).unwrap();
    kill(descendant_pid, None).unwrap();
    assert_eq!(getpgid(Some(descendant_pid)).unwrap(), setup_pid);
    let ready_at = Instant::now();

    loop {
        if owned
            .process
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_some()
        {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(150),
            "external 150-second watchdog expired before Sevro's setup deadline"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = owned.process.take().unwrap().wait_with_output().unwrap();
    assert!(started.elapsed() >= Duration::from_secs(120));
    assert!(ready_at.elapsed() >= Duration::from_secs(119));
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result, failure(70, "fixture setup timed out"));

    fs::write(fixture.root.join("release-descendant"), "release\n").unwrap();
    let cleanup_deadline = Instant::now() + Duration::from_secs(2);
    let descendant_state = loop {
        let status = Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", fields[1]])
            .output()
            .unwrap();
        let state = String::from_utf8(status.stdout).unwrap();
        if state.trim().is_empty()
            || state.trim().starts_with('Z')
            || Instant::now() >= cleanup_deadline
        {
            break state;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(
        descendant_state.trim().is_empty() || descendant_state.trim().starts_with('Z'),
        "owned setup descendant still running: {descendant_state}"
    );
    assert!(!fixture.root.join("descendant-late").exists());
    assert!(
        !Path::new(fields[2]).exists(),
        "private setup HOME survived"
    );
    assert!(!fixture.root.join("native-invocations").exists());
    assert!(!fixture.root.join(".sevro/results/latest.json").exists());
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "repository fixture\n"
    );
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert_eq!(
        git(&fixture.source, &["rev-parse", "HEAD"]),
        "f4d351b20b90e67f9e9092777856c0135110b023"
    );
    assert_eq!(
        fs::read_to_string(Path::new(fields[3]).join("README.md"))
            .expect("timed-out setup workspace must remain available for diagnosis"),
        "repository fixture\n"
    );
}

struct DeadlineProcesses {
    process: Option<Child>,
    root: PathBuf,
    workspace: Option<PathBuf>,
}

impl Drop for DeadlineProcesses {
    fn drop(&mut self) {
        // Stop only processes created by this test, including on a behavioral red.
        for (file, group) in [("setup-owner", true), ("descendant-ready", false)] {
            if let Ok(text) = fs::read_to_string(self.root.join(file))
                && let Ok(pid) = text.trim().parse()
            {
                let pid = Pid::from_raw(pid);
                if group {
                    let _ = killpg(pid, Signal::SIGKILL);
                } else {
                    let _ = kill(pid, Signal::SIGKILL);
                }
            }
        }
        if let Some(process) = &mut self.process {
            let _ = killpg(Pid::from_raw(process.id() as i32), Signal::SIGKILL);
            let _ = process.kill();
            let _ = process.wait();
        }
        if let Some(workspace) = &self.workspace {
            let _ = fs::remove_dir_all(workspace);
        }
    }
}
