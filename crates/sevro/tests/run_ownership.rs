use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("sevro-rust-owner-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir(root.join("calls")).unwrap();
        fs::write(root.join("case.json"), serde_json::to_vec(&json!({
            "id":"ownership", "prompt":"Return ready.",
            "fixture":{"files":{"marker":"original"}},
            "checks":[{"id":"answer","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
            "requiredEvidence":[]
        })).unwrap()).unwrap();
        fs::write(
            root.join("adapter.ts"),
            format!(
                r#"import {{ access, writeFile }} from 'node:fs/promises';
import {{ join }} from 'node:path';
const root = {};
export default {{ id: 'test.ownership', model: 'synthetic', effort: 'none',
  async run({{workspace, condition, signal}}) {{
    await writeFile(join(root, 'calls', String(process.pid)), workspace);
    if (process.env.SEVRO_TEST_CANDIDATE_FAILURE === 'yes') throw new Error('candidate failed');
    if (process.env.SEVRO_TEST_HOLD_OWNER === 'yes') {{
      await writeFile(join(root, 'ready'), 'ready');
      const deadline = Date.now() + 15000;
      while (!(await access(join(root, 'release')).then(() => true, () => false))) {{
        if (signal.aborted) throw new Error('cancelled');
        if (Date.now() > deadline) throw new Error('owner fixture release timed out');
        await Bun.sleep(10);
      }}
    }}
    return {{finalMessage:'ready', complete:true, actualCondition:condition}};
  }}
}};
"#,
                json!(root)
            ),
        )
        .unwrap();
        Self { root }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_sevro"));
        command
            .current_dir(&self.root)
            .args([
                "run",
                "--json",
                "--case-file",
                "case.json",
                "--adapter-module",
                "adapter.ts",
                "--results-root",
                "results",
                "--runner-build-digest",
            ])
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64))
            .args(["--jobs", "1"])
            .env_remove("SEVRO_TEST_HOLD_OWNER")
            .env_remove("SEVRO_TEST_CANDIDATE_FAILURE");
        command
    }

    fn hold_first(&self) -> HeldRun {
        HeldRun {
            child: Some(
                self.command()
                    .env("SEVRO_TEST_HOLD_OWNER", "yes")
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap(),
            ),
            release: self.root.join("release"),
        }
    }

    fn call_count(&self) -> usize {
        fs::read_dir(self.root.join("calls")).unwrap().count()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(calls) = fs::read_dir(self.root.join("calls")) {
            for call in calls.flatten() {
                if let Ok(workspace) = fs::read_to_string(call.path()) {
                    let _ = fs::remove_dir_all(workspace);
                }
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct HeldRun {
    child: Option<Child>,
    release: PathBuf,
}

impl HeldRun {
    fn wait_ready(&mut self, path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "first CLI did not reach adapter readiness"
            );
            assert!(
                self.child.as_mut().unwrap().try_wait().unwrap().is_none(),
                "first CLI exited before adapter readiness"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn finish(mut self) -> Output {
        fs::write(&self.release, "release").unwrap();
        self.child.take().unwrap().wait_with_output().unwrap()
    }
}

impl Drop for HeldRun {
    fn drop(&mut self) {
        let _ = fs::write(&self.release, "release");
        if let Some(child) = &mut self.child {
            let deadline = Instant::now() + Duration::from_secs(3);
            while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn result(output: Output, expected: i32) -> Value {
    assert_eq!(
        output.status.code(),
        Some(expected),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 1, "{stdout}");
    serde_json::from_str(&stdout).unwrap()
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn refuses_equivalent_live_run_until_finalization() {
    let fixture = Fixture::new();
    let mut first = fixture.hold_first();
    let first_pid = first.child.as_ref().unwrap().id();
    first.wait_ready(&fixture.root.join("ready"));

    let refused = result(fixture.command().output().unwrap(), 70);
    assert_eq!(refused["execution"], json!({"status":"not_run"}));
    assert_eq!(refused["grading"], json!({"status":"not_requested"}));
    assert_eq!(refused["task"], json!({"verdict":"not_assessed"}));
    assert_eq!(refused["runId"], Value::Null);
    assert_eq!(refused["evidencePath"], Value::Null);
    assert_eq!(refused["cases"], json!([]));
    assert_eq!(refused["diagnostic"]["code"], "sevro.runner.error");
    assert!(
        refused["diagnostic"]["message"]
            .as_str()
            .unwrap()
            .contains("equivalent Sevro run is active")
    );
    assert_eq!(fixture.call_count(), 1);

    let state = fixture.root.join("results");
    let active_paths: Vec<_> = fs::read_dir(state.join("active"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(
        active_paths.len(),
        1,
        "refused admission left an active attempt"
    );
    let active = read_json(&active_paths[0]);
    assert_eq!(active["format"], "sevro.active-run.v1");
    assert_eq!(active["status"], "active");
    assert_eq!(active["owner"]["pid"], first_pid);
    assert!(!active["owner"]["host"].as_str().unwrap().is_empty());
    assert!(!active["owner"]["startedAt"].as_str().unwrap().is_empty());
    assert_eq!(active["completedTrials"], json!([]));
    let digest = active["evaluationDigest"].as_str().unwrap();
    let claim_path = state.join("owners").join(format!("{digest}.json"));
    let claim = read_json(&claim_path);
    assert_eq!(claim["format"], "sevro.run-owner.v1");
    assert_eq!(claim["attemptId"], active["runId"]);
    assert_eq!(claim["owner"], active["owner"]);
    assert_eq!(
        fs::metadata(&claim_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let lock = state.join("locks").join(format!("{digest}.json.sqlite"));
    assert!(fs::read(lock).unwrap().starts_with(b"SQLite format 3\0"));
    let run_directories = fs::read_dir(&state)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok())
        .count();
    assert_eq!(
        run_directories, 1,
        "refused admission retained its allocated directory"
    );

    let completed = result(first.finish(), 0);
    assert_eq!(completed["task"]["verdict"], "passed");
    assert_eq!(completed["runId"], active["runId"]);
    let active_bytes = fs::read(&active_paths[0]).unwrap();
    let finalized: Value = serde_json::from_slice(&active_bytes).unwrap();
    assert_eq!(finalized["status"], "complete");
    assert_eq!(finalized["artifactPath"], completed["evidencePath"]);
    assert!(finalized["finalizedAt"].as_str().unwrap().ends_with('Z'));
    let completed_trials =
        json!([{"trial":1,"artifactPath":completed["cases"][0]["trials"][0]["artifactPath"]}]);
    assert_eq!(finalized["completedTrials"], completed_trials);
    let checkpoint = read_json(Path::new(finalized["checkpointPath"].as_str().unwrap()));
    assert_eq!(
        checkpoint,
        json!({"format":"sevro.run-checkpoint.v1","runId":completed["runId"],"completedTrials":completed_trials})
    );
    assert_eq!(
        read_json(Path::new(completed["evidencePath"].as_str().unwrap()))["result"],
        completed
    );
    assert_eq!(read_json(&claim_path)["status"], "complete");

    let next = result(fixture.command().output().unwrap(), 0);
    assert_ne!(next["runId"], completed["runId"]);
    assert_eq!(next["task"]["verdict"], "passed");
    assert_eq!(fixture.call_count(), 2);
    assert_eq!(fs::read(&active_paths[0]).unwrap(), active_bytes);
    assert_eq!(read_json(&claim_path)["attemptId"], next["runId"]);
}

#[test]
fn retries_after_checkpoint_failure_without_discarding_prior_evidence() {
    let fixture = Fixture::new();
    let mut first = fixture.hold_first();
    first.wait_ready(&fixture.root.join("ready"));
    let state = fixture.root.join("results");
    let claim_path = fs::read_dir(state.join("owners"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let claim = read_json(&claim_path);
    let active_path = Path::new(claim["activeRunPath"].as_str().unwrap());
    let active = read_json(active_path);
    let checkpoint = Path::new(active["checkpointPath"].as_str().unwrap());
    fs::remove_file(checkpoint).unwrap();
    fs::create_dir(checkpoint).unwrap();
    fs::write(checkpoint.join("caller-owned"), "keep checkpoint collision").unwrap();

    let failed = result(first.finish(), 70);
    assert_eq!(failed["execution"]["status"], "not_run");
    assert_eq!(failed["diagnostic"]["code"], "sevro.runner.error");
    assert_eq!(read_json(&claim_path), claim);
    assert_eq!(read_json(active_path), active);
    let prior_directory = Path::new(claim["evidenceDirectory"].as_str().unwrap());
    let trial_path = prior_directory.join("trial-1.json");
    let trial_bytes = fs::read(&trial_path).unwrap();
    let workspace = PathBuf::from(
        fs::read_to_string(
            fs::read_dir(fixture.root.join("calls"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path(),
        )
        .unwrap(),
    );
    let workspace_existed = workspace.exists();
    assert!(!prior_directory.join("run.json").exists());

    let retried = result(fixture.command().output().unwrap(), 0);
    assert_eq!(retried["task"]["verdict"], "passed");
    assert_ne!(retried["runId"], claim["attemptId"]);
    assert_eq!(fixture.call_count(), 2);
    let interrupted = read_json(active_path);
    assert!(interrupted["finalizedAt"].as_str().unwrap().ends_with('Z'));
    let mut expected_active = active.clone();
    expected_active["status"] = json!("interrupted");
    expected_active["finalizedAt"] = interrupted["finalizedAt"].clone();
    assert_eq!(interrupted, expected_active);
    let mut expected_provenance = claim.clone();
    expected_provenance["status"] = json!("interrupted");
    expected_provenance["finalizedAt"] = interrupted["finalizedAt"].clone();
    assert_eq!(
        read_json(&prior_directory.join("run-owner.json")),
        expected_provenance
    );
    assert_eq!(fs::read(&trial_path).unwrap(), trial_bytes);
    assert_eq!(workspace.exists(), workspace_existed);
    assert_eq!(
        fs::read(checkpoint.join("caller-owned")).unwrap(),
        b"keep checkpoint collision"
    );
    assert_eq!(fs::read_dir(checkpoint).unwrap().count(), 1);
    assert_eq!(read_json(&claim_path)["attemptId"], retried["runId"]);
    assert_eq!(read_json(&claim_path)["status"], "complete");
}

#[test]
fn cleans_persisted_passing_workspace_when_checkpoint_fails() {
    let fixture = Fixture::new();
    let mut first = fixture.hold_first();
    first.wait_ready(&fixture.root.join("ready"));
    let active_path = fs::read_dir(fixture.root.join("results/active"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let active = read_json(&active_path);
    let checkpoint = Path::new(active["checkpointPath"].as_str().unwrap());
    fs::remove_file(checkpoint).unwrap();
    fs::create_dir(checkpoint).unwrap();
    let workspace = PathBuf::from(
        fs::read_to_string(
            fs::read_dir(fixture.root.join("calls"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path(),
        )
        .unwrap(),
    );
    result(first.finish(), 70);
    let run_directory = Path::new(active["evidenceDirectory"].as_str().unwrap());
    assert_eq!(
        read_json(&run_directory.join("trial-1.json"))["result"]["task"]["verdict"],
        "passed"
    );
    assert_eq!(read_json(&active_path), active);
    assert!(
        !workspace.exists(),
        "persisted passing workspace was retained"
    );
    assert!(checkpoint.is_dir());
    assert!(!run_directory.join("run.json").exists());
}

#[test]
fn refuses_unknown_owner_without_replacing_evidence() {
    let fixture = Fixture::new();
    let mut first = fixture.hold_first();
    first.wait_ready(&fixture.root.join("ready"));
    let claim_path = fs::read_dir(fixture.root.join("results/owners"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let original = fs::read(&claim_path).unwrap();
    let claim: Value = serde_json::from_slice(&original).unwrap();
    let active_path = Path::new(claim["activeRunPath"].as_str().unwrap());
    let active_bytes = fs::read(active_path).unwrap();
    let active = read_json(active_path);
    let checkpoint = Path::new(active["checkpointPath"].as_str().unwrap());
    let checkpoint_bytes = fs::read(checkpoint).unwrap();
    let owner = &claim["owner"];
    for replacement in [
        Value::Null,
        json!({"pid":owner["pid"],"host":owner["host"],"startedAt":42}),
        json!({"pid":owner["pid"],"host":owner["host"],"startedAt":""}),
        json!({"pid":owner["pid"],"host":"another-host.example","startedAt":owner["startedAt"]}),
        json!({"pid":0,"host":owner["host"],"startedAt":owner["startedAt"]}),
        json!({"pid":-1,"host":owner["host"],"startedAt":owner["startedAt"]}),
        json!({"pid":1.5,"host":owner["host"],"startedAt":owner["startedAt"]}),
    ] {
        let mut changed = claim.clone();
        changed["owner"] = replacement;
        let changed_bytes = serde_json::to_vec(&changed).unwrap();
        fs::write(&claim_path, &changed_bytes).unwrap();
        let refused = result(fixture.command().output().unwrap(), 70);
        assert!(
            refused["diagnostic"]["message"]
                .as_str()
                .unwrap()
                .contains("ownership is unverifiable"),
            "{refused}"
        );
        assert_eq!(fs::read(&claim_path).unwrap(), changed_bytes);
        assert_eq!(fs::read(active_path).unwrap(), active_bytes);
        assert_eq!(fs::read(checkpoint).unwrap(), checkpoint_bytes);
        assert_eq!(fixture.call_count(), 1);
        assert!(!checkpoint.parent().unwrap().join("run-owner.json").exists());
    }
    fs::write(&claim_path, original).unwrap();
    result(first.finish(), 0);
}

#[test]
fn diagnostic_finalization_allows_retry_and_retains_unpersisted_workspace() {
    let fixture = Fixture::new();
    let mut first = fixture.hold_first();
    first.wait_ready(&fixture.root.join("ready"));
    let active_path = fs::read_dir(fixture.root.join("results/active"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let active = read_json(&active_path);
    let directory = Path::new(active["evidenceDirectory"].as_str().unwrap());
    fs::create_dir(directory.join("trial-1.json")).unwrap();
    result(first.finish(), 70);
    let finalized_bytes = fs::read(&active_path).unwrap();
    let finalized: Value = serde_json::from_slice(&finalized_bytes).unwrap();
    assert_eq!(finalized["status"], "diagnostic");
    assert_eq!(finalized["completedTrials"], json!([]));
    assert!(finalized["finalizedAt"].as_str().unwrap().ends_with('Z'));
    let checkpoint = Path::new(active["checkpointPath"].as_str().unwrap());
    let checkpoint_bytes = fs::read(checkpoint).unwrap();
    let workspace = PathBuf::from(
        fs::read_to_string(
            fs::read_dir(fixture.root.join("calls"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path(),
        )
        .unwrap(),
    );
    assert_eq!(fs::read(workspace.join("marker")).unwrap(), b"original");
    let next = result(fixture.command().output().unwrap(), 0);
    assert_ne!(next["runId"], active["runId"]);
    assert_eq!(fixture.call_count(), 2);
    assert_eq!(fs::read(&active_path).unwrap(), finalized_bytes);
    assert_eq!(fs::read(checkpoint).unwrap(), checkpoint_bytes);
    assert_eq!(fs::read(workspace.join("marker")).unwrap(), b"original");
    assert!(!directory.join("run-owner.json").exists());
}

#[test]
fn interrupted_finalization_allows_retry_and_retains_cancelled_workspace() {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;

    for (signal, exit_code) in [(Signal::SIGINT, 130), (Signal::SIGTERM, 143)] {
        let fixture = Fixture::new();
        let mut first = fixture.hold_first();
        first.wait_ready(&fixture.root.join("ready"));
        let pid = first.child.as_ref().unwrap().id();
        kill(Pid::from_raw(pid.try_into().unwrap()), signal).unwrap();
        let cancelled = result(
            first.child.take().unwrap().wait_with_output().unwrap(),
            exit_code,
        );
        assert_eq!(cancelled["execution"]["status"], "cancelled");
        let run_id = cancelled["runId"].as_str().unwrap();
        let active_path = fixture
            .root
            .join("results/active")
            .join(format!("{run_id}.json"));
        let active_bytes = fs::read(&active_path).unwrap();
        let active: Value = serde_json::from_slice(&active_bytes).unwrap();
        assert_eq!(active["status"], "interrupted");
        assert_eq!(active["completedTrials"].as_array().unwrap().len(), 1);
        assert!(active["finalizedAt"].as_str().unwrap().ends_with('Z'));
        let workspace = PathBuf::from(
            fs::read_to_string(
                fs::read_dir(fixture.root.join("calls"))
                    .unwrap()
                    .next()
                    .unwrap()
                    .unwrap()
                    .path(),
            )
            .unwrap(),
        );
        assert_eq!(fs::read(workspace.join("marker")).unwrap(), b"original");
        let next = result(fixture.command().output().unwrap(), 0);
        assert_ne!(next["runId"], cancelled["runId"]);
        assert_eq!(fixture.call_count(), 2);
        assert_eq!(fs::read(active_path).unwrap(), active_bytes);
        assert_eq!(fs::read(workspace.join("marker")).unwrap(), b"original");
    }
}

#[test]
fn completed_candidate_failure_allows_retry_and_retains_failed_workspace() {
    let fixture = Fixture::new();
    let failed = result(
        fixture
            .command()
            .env("SEVRO_TEST_CANDIDATE_FAILURE", "yes")
            .output()
            .unwrap(),
        2,
    );
    assert_eq!(failed["execution"]["status"], "failed");
    let run_id = failed["runId"].as_str().unwrap();
    let active_path = fixture
        .root
        .join("results/active")
        .join(format!("{run_id}.json"));
    let active_bytes = fs::read(&active_path).unwrap();
    let active: Value = serde_json::from_slice(&active_bytes).unwrap();
    assert_eq!(active["status"], "complete");
    assert_eq!(active["completedTrials"].as_array().unwrap().len(), 1);
    let workspace = PathBuf::from(
        fs::read_to_string(
            fs::read_dir(fixture.root.join("calls"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path(),
        )
        .unwrap(),
    );
    assert_eq!(fs::read(workspace.join("marker")).unwrap(), b"original");
    let next = result(fixture.command().output().unwrap(), 0);
    assert_ne!(next["runId"], failed["runId"]);
    assert_eq!(fixture.call_count(), 2);
    assert_eq!(fs::read(active_path).unwrap(), active_bytes);
    assert_eq!(fs::read(workspace.join("marker")).unwrap(), b"original");
}

#[test]
fn reclaims_changed_start_with_missing_or_null_active_record() {
    for missing in [true, false] {
        let fixture = Fixture::new();
        let mut first = fixture.hold_first();
        first.wait_ready(&fixture.root.join("ready"));
        let claim_path = fs::read_dir(fixture.root.join("results/owners"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let mut claim = read_json(&claim_path);
        claim["owner"]["startedAt"] = json!("different process start");
        claim["retainedExtension"] = json!({"opaque":[1,"preserve"]});
        fs::write(&claim_path, serde_json::to_vec(&claim).unwrap()).unwrap();
        let active_path = Path::new(claim["activeRunPath"].as_str().unwrap());
        let active = read_json(active_path);
        let checkpoint = Path::new(active["checkpointPath"].as_str().unwrap());
        let checkpoint_bytes = fs::read(checkpoint).unwrap();
        if missing {
            fs::remove_file(active_path).unwrap();
        } else {
            fs::write(active_path, "null").unwrap();
        }
        let next = result(fixture.command().output().unwrap(), 0);
        assert_ne!(next["runId"], claim["attemptId"]);
        let interrupted = read_json(active_path);
        let finalized_at = &interrupted["finalizedAt"];
        assert!(finalized_at.as_str().unwrap().ends_with('Z'));
        let mut expected = if missing {
            json!({"format":"sevro.active-run.v1","runId":claim["attemptId"],
                "artifactPath":claim["artifactPath"],"evidenceDirectory":claim["evidenceDirectory"],
                "completedTrials":[]})
        } else {
            json!({})
        };
        expected["status"] = json!("interrupted");
        expected["finalizedAt"] = finalized_at.clone();
        assert_eq!(interrupted, expected);
        let provenance_path =
            Path::new(claim["evidenceDirectory"].as_str().unwrap()).join("run-owner.json");
        let mut provenance = claim.clone();
        provenance["status"] = json!("interrupted");
        provenance["finalizedAt"] = finalized_at.clone();
        assert_eq!(read_json(&provenance_path), provenance);
        assert_eq!(fs::read(checkpoint).unwrap(), checkpoint_bytes);
        result(first.finish(), 70);
        assert_eq!(read_json(active_path), interrupted);
        assert_eq!(read_json(&claim_path)["attemptId"], next["runId"]);
    }
}

#[test]
fn refuses_malformed_active_evidence_without_replacing_prior_claim() {
    let fixture = Fixture::new();
    let mut first = fixture.hold_first();
    first.wait_ready(&fixture.root.join("ready"));
    let claim_path = fs::read_dir(fixture.root.join("results/owners"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let original_claim = fs::read(&claim_path).unwrap();
    let mut claim: Value = serde_json::from_slice(&original_claim).unwrap();
    claim["owner"]["startedAt"] = json!("different process start");
    let claim_bytes = serde_json::to_vec(&claim).unwrap();
    fs::write(&claim_path, &claim_bytes).unwrap();
    let active_path = Path::new(claim["activeRunPath"].as_str().unwrap());
    let original_active = fs::read(active_path).unwrap();
    let active: Value = serde_json::from_slice(&original_active).unwrap();
    let checkpoint = Path::new(active["checkpointPath"].as_str().unwrap());
    let checkpoint_bytes = fs::read(checkpoint).unwrap();
    let damaged = b"{broken retained evidence";
    fs::write(active_path, damaged).unwrap();
    result(fixture.command().output().unwrap(), 70);
    assert_eq!(fixture.call_count(), 1);
    assert_eq!(fs::read(&claim_path).unwrap(), claim_bytes);
    assert_eq!(fs::read(active_path).unwrap(), damaged);
    assert_eq!(fs::read(checkpoint).unwrap(), checkpoint_bytes);
    let directory = Path::new(claim["evidenceDirectory"].as_str().unwrap());
    assert_eq!(
        read_json(&directory.join("run-owner.json"))["status"],
        "interrupted"
    );
    let directories = fs::read_dir(fixture.root.join("results"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok())
        .count();
    assert_eq!(directories, 1, "refusal leaked a new attempt directory");
    fs::write(&claim_path, original_claim).unwrap();
    fs::write(active_path, original_active).unwrap();
    result(first.finish(), 0);
}
