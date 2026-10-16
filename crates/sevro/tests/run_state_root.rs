use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const CASE: &str = r#"{
  "id":"state-root", "prompt":"Return ready.",
  "fixture":{"files":{"marker":"original"}},
  "checks":[{"id":"answer","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
  "requiredEvidence":[]
}"#;

const ADAPTER: &str = r#"
import { writeFile } from 'node:fs/promises';
export default { id:'test.state-root', model:'synthetic', effort:'none',
  async run({workspace, condition}) {
    await writeFile(new URL('./workspace.txt', import.meta.url), workspace);
    return {finalMessage:'ready', complete:true, actualCondition:condition,
      artifacts:[{id:'test.trace', bytes:new Uint8Array([1,2,3])}]};
  }
};
"#;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("sevro-rust-state-root-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::write(root.join("case.json"), CASE).unwrap();
        fs::write(root.join("adapter.ts"), ADAPTER).unwrap();
        Self { root }
    }

    fn command(&self) -> Command {
        self.command_with_state(true)
    }

    fn command_with_state(&self, selected: bool) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_sevro"));
        command
            .current_dir(&self.root)
            .args(["run", "--json"])
            .arg("--case-file")
            .arg(self.root.join("case.json"))
            .arg("--adapter-module")
            .arg(self.root.join("adapter.ts"))
            .arg("--project-root")
            .arg(&self.root)
            .arg("--results-root")
            .arg(self.root.join("results"));
        if selected {
            command.arg("--run-state-root").arg(self.root.join("state"));
        }
        command
            .arg("--runner-build-digest")
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64))
            .args(["--trials", "1", "--jobs", "1"]);
        command
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(workspace) = fs::read_to_string(self.root.join("workspace.txt")) {
            let _ = fs::remove_dir_all(workspace);
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn entries(path: &Path) -> BTreeSet<String> {
    fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect()
}

#[test]
fn retains_evidence_and_ownership_under_independent_roots() {
    let fixture = Fixture::new();
    let output = fixture.command().output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 1, "{stdout}");
    let result: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(result["exitCode"], 0);
    let run_id = result["runId"].as_str().unwrap();
    let results_root = fixture.root.join("results");
    let state_root = fixture.root.join("state");
    let results = results_root.join(run_id);
    let state = state_root.join(run_id);
    let evidence_path = results.join("run.json");
    let trial_path = results.join("trial-1.json");
    let checkpoint_path = state.join("checkpoint.json");
    let active_path = state_root.join("active").join(format!("{run_id}.json"));
    assert_eq!(result["evidencePath"], json!(evidence_path));
    assert_eq!(
        result["cases"][0]["trials"][0]["artifactPath"],
        json!(trial_path)
    );
    assert_eq!(read_json(&results.join("result.json")), result);
    assert_eq!(read_json(&results_root.join("latest.json")), result);
    let evidence = read_json(&evidence_path);
    assert_eq!(evidence["result"], result);
    assert_eq!(
        evidence["configuration"]["resolved"]["resultsRoot"],
        json!(results_root)
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["runStateRoot"],
        json!(state_root)
    );
    let trial = &evidence["trials"][0];
    assert_eq!(read_json(&trial_path)["evidence"], *trial);
    let raw = url::Url::parse(trial["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(raw.parent(), Some(results.as_path()));
    assert_eq!(fs::read(raw).unwrap(), b"ready");
    let artifact = trial["artifactRefs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "test.trace")
        .unwrap();
    let artifact_path = url::Url::parse(artifact["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(artifact_path.parent(), Some(results.as_path()));
    assert_eq!(fs::read(artifact_path).unwrap(), [1, 2, 3]);
    let completed = json!([{"trial":1,"artifactPath":trial_path}]);
    let checkpoint = read_json(&checkpoint_path);
    assert_eq!(checkpoint["runId"], run_id);
    assert_eq!(checkpoint["completedTrials"], completed);
    let active = read_json(&active_path);
    assert_eq!(active["status"], "complete");
    assert_eq!(active["checkpointPath"], json!(checkpoint_path));
    assert_eq!(active["evidenceDirectory"], json!(state));
    assert_eq!(active["artifactPath"], json!(evidence_path));
    assert_eq!(active["completedTrials"], completed);
    let digest = evidence["evaluationIdentity"]["digest"].as_str().unwrap();
    let claim = read_json(&state_root.join("owners").join(format!("{digest}.json")));
    assert_eq!(claim["status"], "complete");
    assert_eq!(claim["attemptId"], run_id);
    assert_eq!(claim["activeRunPath"], json!(active_path));
    assert_eq!(claim["evidenceDirectory"], json!(state));
    assert_eq!(claim["artifactPath"], json!(evidence_path));
    assert!(
        fs::read(
            state_root
                .join("locks")
                .join(format!("{digest}.json.sqlite"))
        )
        .unwrap()
        .starts_with(b"SQLite format 3\0")
    );
    assert_eq!(
        entries(&results_root),
        BTreeSet::from([run_id.into(), "latest.json".into()])
    );
    assert_eq!(
        entries(&state_root),
        BTreeSet::from([
            run_id.into(),
            "active".into(),
            "owners".into(),
            "locks".into()
        ])
    );
    assert_eq!(entries(&state), BTreeSet::from(["checkpoint.json".into()]));
    assert!(!Path::new(&fs::read_to_string(fixture.root.join("workspace.txt")).unwrap()).exists());
}

#[test]
fn defaults_run_state_to_the_selected_results_root() {
    let fixture = Fixture::new();
    let output = fixture.command_with_state(false).output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let root = fixture.root.join("results");
    let directory = root.join(result["runId"].as_str().unwrap());
    assert!(directory.join("checkpoint.json").is_file());
    assert!(directory.join("run.json").is_file());
    let evidence = read_json(&directory.join("run.json"));
    assert_eq!(
        evidence["configuration"]["resolved"]["runStateRoot"],
        json!(root)
    );
    assert!(!fixture.root.join("state").exists());
    assert!(root.join("active").is_dir());
    assert!(root.join("owners").is_dir());
    assert!(root.join("locks").is_dir());
}

#[test]
fn rejects_an_empty_state_root_before_admission() {
    let fixture = Fixture::new();
    let output = fixture
        .command()
        .args(["--run-state-root", ""])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"]["status"], "not_run");
    assert_eq!(result["runId"], Value::Null);
    assert!(!fixture.root.join("workspace.txt").exists());
    assert!(!fixture.root.join("results").exists());
    assert!(!fixture.root.join("state").exists());
}

#[test]
fn saved_state_root_resolves_against_the_manifest_directory() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.root.join("settings")).unwrap();
    let manifest = fixture.root.join("settings/evaluation.json");
    fs::write(
        &manifest,
        json!({
            "format":"sevro.run.v1", "settings":{"run-state-root":"saved-state"}
        })
        .to_string(),
    )
    .unwrap();
    let result = result(
        fixture
            .command_with_state(false)
            .arg("--run-manifest-file")
            .arg(&manifest)
            .output()
            .unwrap(),
        0,
    );
    let state = fixture.root.join("settings/saved-state");
    let run_id = result["runId"].as_str().unwrap();
    assert!(state.join(run_id).join("checkpoint.json").is_file());
    assert!(state.join("owners").is_dir());
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    assert_eq!(
        evidence["configuration"]["resolved"]["runStateRoot"],
        json!(state)
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["runManifestFile"],
        json!(manifest)
    );
    assert!(!fixture.root.join("saved-state").exists());
    assert!(
        !fixture
            .root
            .join("results")
            .join(run_id)
            .join("checkpoint.json")
            .exists()
    );
}

#[test]
fn selected_state_contents_do_not_change_project_or_evaluation_identity() {
    let fixture = Fixture::new();
    let project = fixture.root.join("project");
    fs::create_dir(&project).unwrap();
    fs::write(project.join("README.md"), "alpha\n").unwrap();
    let invoke = || {
        let output = Command::new(env!("CARGO_BIN_EXE_sevro"))
            .current_dir(&fixture.root)
            .args(["run", "--json", "--case-file"])
            .arg(fixture.root.join("case.json"))
            .arg("--adapter-module")
            .arg(fixture.root.join("adapter.ts"))
            .arg("--project-root")
            .arg(&project)
            .arg("--results-root")
            .arg(project.join("results"))
            .arg("--run-state-root")
            .arg(project.join("state"))
            .arg("--runner-build-digest")
            .arg("a".repeat(64))
            .args(["--trials", "1", "--jobs", "1"])
            .output()
            .unwrap();
        let result = result(output, 0);
        read_json(Path::new(result["evidencePath"].as_str().unwrap()))
    };
    let first = invoke();
    fs::write(project.join("state/private-marker"), "state changed\n").unwrap();
    let second = invoke();
    assert_eq!(
        first["evaluationIdentity"]["dimensions"]["projectDigest"],
        second["evaluationIdentity"]["dimensions"]["projectDigest"]
    );
    assert_eq!(first["evaluationIdentity"], second["evaluationIdentity"]);
    fs::write(project.join("README.md"), "beta\n").unwrap();
    let changed = invoke();
    assert_ne!(
        second["evaluationIdentity"]["dimensions"]["projectDigest"],
        changed["evaluationIdentity"]["dimensions"]["projectDigest"]
    );
}

#[test]
fn explicit_state_root_replaces_the_saved_manifest_selection() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.root.join("settings")).unwrap();
    let manifest = fixture.root.join("settings/evaluation.json");
    fs::write(
        &manifest,
        json!({
            "format":"sevro.run.v1", "settings":{"run-state-root":"saved-state"}
        })
        .to_string(),
    )
    .unwrap();
    let result = result(
        fixture
            .command()
            .arg("--run-manifest-file")
            .arg(&manifest)
            .output()
            .unwrap(),
        0,
    );
    let state = fixture.root.join("state");
    assert!(
        state
            .join(result["runId"].as_str().unwrap())
            .join("checkpoint.json")
            .is_file()
    );
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    assert_eq!(
        evidence["configuration"]["resolved"]["runStateRoot"],
        json!(state)
    );
    assert!(!fixture.root.join("settings/saved-state").exists());
}

struct HeldRun {
    child: Option<Child>,
    release: PathBuf,
}

impl HeldRun {
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
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn refuses_a_live_owner_in_selected_state_and_retries_after_finalization() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("adapter.ts"),
        r#"
import { access, appendFile, writeFile } from 'node:fs/promises';
export default { id:'test.state-root.owner', model:'synthetic', effort:'none',
  async run({workspace, condition}) {
    await appendFile(new URL('./calls', import.meta.url), workspace + '\n');
    await writeFile(new URL('./workspace.txt', import.meta.url), workspace);
    if (process.env.SEVRO_TEST_STATE_ROOT_HOLD === 'yes') {
      const deadline = Date.now() + 15000;
      while (!(await access(new URL('./release', import.meta.url)).then(() => true, () => false))) {
        if (Date.now() > deadline) throw new Error('release timed out');
        await Bun.sleep(10);
      }
    }
    return {finalMessage:'ready', complete:true, actualCondition:condition};
  }
};
"#,
    )
    .unwrap();
    let mut first = HeldRun {
        child: Some(
            fixture
                .command()
                .env("SEVRO_TEST_STATE_ROOT_HOLD", "yes")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        ),
        release: fixture.root.join("release"),
    };
    let deadline = Instant::now() + Duration::from_secs(8);
    while !fixture.root.join("workspace.txt").exists() {
        assert!(Instant::now() < deadline, "owner readiness timed out");
        assert!(
            first.child.as_mut().unwrap().try_wait().unwrap().is_none(),
            "owner exited before readiness"
        );
        thread::sleep(Duration::from_millis(10));
    }
    let active_path = fs::read_dir(fixture.root.join("state/active"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let active = read_json(&active_path);
    assert_eq!(active["status"], "active");
    let refused = result(
        fixture
            .command()
            .env_remove("SEVRO_TEST_STATE_ROOT_HOLD")
            .output()
            .unwrap(),
        70,
    );
    assert!(
        refused["diagnostic"]["message"]
            .as_str()
            .unwrap()
            .contains("equivalent Sevro run is active")
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("calls"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert_eq!(
        entries(&fixture.root.join("results")),
        BTreeSet::from([active["runId"].as_str().unwrap().into()])
    );
    assert_eq!(
        entries(&fixture.root.join("state")),
        BTreeSet::from([
            active["runId"].as_str().unwrap().into(),
            "active".into(),
            "owners".into(),
            "locks".into()
        ])
    );
    let completed = result(first.finish(), 0);
    assert_eq!(completed["runId"], active["runId"]);
    let prior_bytes = fs::read(&active_path).unwrap();
    assert_eq!(read_json(&active_path)["status"], "complete");
    let next = result(
        fixture
            .command()
            .env_remove("SEVRO_TEST_STATE_ROOT_HOLD")
            .output()
            .unwrap(),
        0,
    );
    assert_ne!(next["runId"], completed["runId"]);
    assert_eq!(fs::read(&active_path).unwrap(), prior_bytes);
    assert_eq!(
        fs::read_to_string(fixture.root.join("calls"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

#[test]
fn admission_failure_removes_both_attempts_and_preserves_blocking_state_file() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.root.join("state")).unwrap();
    fs::write(
        fixture.root.join("state/owners"),
        "preserved blocking file\n",
    )
    .unwrap();
    result(fixture.command().output().unwrap(), 70);
    assert!(!fixture.root.join("workspace.txt").exists());
    assert!(entries(&fixture.root.join("results")).is_empty());
    assert_eq!(
        entries(&fixture.root.join("state")),
        BTreeSet::from(["locks".into(), "owners".into()])
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("state/owners")).unwrap(),
        "preserved blocking file\n"
    );
}

const NATIVE_WRAPPER: &str = r#"#!/bin/sh
if [ "$1" = --version ]; then printf 'state-root-native-oracle\n'; exit 0; fi
if [ "$1" = sandbox ]; then shift; exec @CODEX@ sandbox "$@"; fi
if [ "$1" != exec ]; then exit 99; fi
/bin/cat >/dev/null
printf '%s' "$PWD" > @WORKSPACE@
profile=$(/usr/bin/sed -n 's/^default_permissions = "\(.*\)"/\1/p' "$CODEX_HOME/config.toml")
@CODEX@ sandbox -P "$profile" -C "$PWD" /bin/sh -c '
  test "$(/bin/cat marker)" = original || exit 93
  printf allowed > local-write || exit 92
  if /bin/cat "$1" >/dev/null 2>&1; then exit 91; fi
  if (printf changed >> "$1") 2>/dev/null; then exit 90; fi
' state-root-probe @SECRET@
status=$?
printf '%s\n' "$status" > @STATUS@
if [ "$status" -ne 0 ]; then exit "$status"; fi
printf '%s\n' '{"type":"thread.started","thread_id":"state-root-thread"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
"#;

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\"'\"'"))
}

#[test]
fn native_candidate_cannot_read_or_write_the_independent_state_root() {
    assert_native_state_is_private("state");
}

#[test]
fn native_state_nested_under_executable_read_root_stays_private() {
    assert_native_state_is_private("binary/state");
}

fn assert_native_state_is_private(state_path: &str) {
    let fixture = Fixture::new();
    for name in ["project", "binary", state_path, "temporary"] {
        fs::create_dir(fixture.root.join(name)).unwrap();
    }
    fs::write(
        fixture.root.join("project/auth.json"),
        "SYNTHETIC_STATE_ROOT_AUTH\n",
    )
    .unwrap();
    fs::set_permissions(
        fixture.root.join("project/auth.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let secret = fixture.root.join(state_path).join("private-marker");
    fs::write(&secret, "private state\n").unwrap();
    let codex = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|directory| directory.join("codex"))
        .find(|path| path.is_file())
        .expect("native state-root integration requires the installed Codex CLI");
    let codex = fs::canonicalize(codex).unwrap();
    let binary = fixture.root.join("binary/codex-wrapper");
    fs::write(
        &binary,
        NATIVE_WRAPPER
            .replace("@CODEX@", &quote(&codex))
            .replace("@SECRET@", &quote(&secret))
            .replace(
                "@STATUS@",
                &quote(&fixture.root.join("binary/probe-status")),
            )
            .replace("@WORKSPACE@", &quote(&fixture.root.join("workspace.txt"))),
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    #[cfg(target_os = "linux")]
    std::os::unix::fs::symlink(&codex, fixture.root.join("binary/codex-linux-sandbox")).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_sevro"))
        .current_dir(fixture.root.join("project"))
        .env("TMPDIR", fixture.root.join("temporary"))
        .args(["run", "--json", "--case-file"])
        .arg(fixture.root.join("case.json"))
        .arg("--project-root")
        .arg(fixture.root.join("project"))
        .arg("--results-root")
        .arg(fixture.root.join("results"))
        .arg("--run-state-root")
        .arg(fixture.root.join(state_path))
        .args(["--host", "codex", "--codex-bin"])
        .arg(binary)
        .arg("--codex-auth-file")
        .arg(fixture.root.join("project/auth.json"))
        .args([
            "--model",
            "synthetic",
            "--effort",
            "low",
            "--runner-build-digest",
        ])
        .arg("a".repeat(64))
        .arg("--project-digest")
        .arg("b".repeat(64))
        .args(["--trials", "1", "--jobs", "1"])
        .output()
        .unwrap();
    let probe = fs::read_to_string(fixture.root.join("binary/probe-status")).unwrap();
    assert_eq!(
        probe,
        "0\n",
        "native sandbox exposed selected state; {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result = result(output, 0);
    assert_eq!(result["task"]["verdict"], "passed");
    assert_eq!(fs::read_to_string(secret).unwrap(), "private state\n");
}
