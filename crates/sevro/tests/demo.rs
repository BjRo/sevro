use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct DemoDirectory(PathBuf);

impl DemoDirectory {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("sevro-rust-demo-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir(root.join("caller")).unwrap();
        fs::create_dir(root.join("temporary")).unwrap();
        fs::copy(env!("CARGO_BIN_EXE_sevro"), root.join("sevro")).unwrap();
        Self(root)
    }

    fn run(&self, arguments: &[&str]) -> Output {
        Command::new(self.0.join("sevro"))
            .arg("demo")
            .args(arguments)
            .current_dir(self.0.join("caller"))
            .env("TMPDIR", self.0.join("temporary"))
            .output()
            .unwrap()
    }
}

impl Drop for DemoDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn read_json(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn demo_runs_packaged_case_and_adapter_without_inheriting_caller_policy() {
    let directory = DemoDirectory::new();
    let caller = directory.0.join("caller");
    fs::write(caller.join("sevro.json"), "invalid caller runtime policy").unwrap();
    fs::create_dir(caller.join(".codex")).unwrap();
    fs::write(
        caller.join(".codex/config.toml"),
        "invalid = [ caller codex policy",
    )
    .unwrap();
    symlink("missing-target", caller.join("unrelated-link")).unwrap();

    let output = directory.run(&["--json"]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout).lines().count(), 1);
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["format"], "sevro.cli-result.v1");
    assert_eq!(result["execution"]["status"], "completed");
    assert_eq!(result["grading"]["status"], "completed");
    assert_eq!(result["task"]["verdict"], "passed");
    assert_eq!(result["exitCode"], 0);
    assert_eq!(result["cases"][0]["caseId"], "basic-graded");
    assert_eq!(
        result["cases"][0]["trials"][0]["checks"],
        json!([{
            "id":"ready", "grader":"sevro.regex", "status":"passed", "detail":"ok",
            "evidenceRefs":["sevro.observation.final-message"]
        }])
    );
    let evidence_path = Path::new(result["evidencePath"].as_str().unwrap());
    assert!(evidence_path.starts_with(caller.join(".sevro/results")));
    let evidence = read_json(evidence_path);
    assert_eq!(evidence["result"], result);
    assert_eq!(read_json(caller.join(".sevro/results/latest.json")), result);
    assert_eq!(
        evidence["routes"],
        json!([{"role":"candidate", "host":"sevro.host.example", "model":"deterministic-example", "effort":"none"}])
    );
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["projectDigest"],
        "c4758129528fcfd80824a58e21f9d2cfe92fb00e0120120c8eecb8cf9b8b9eaf"
    );
    let resolved = &evidence["configuration"]["resolved"];
    assert_eq!(resolved["projectRoot"], resolved["configRoot"]);
    assert!(resolved["runtimeConfigFile"].is_null());
    let project = Path::new(resolved["projectRoot"].as_str().unwrap());
    assert!(project.starts_with(directory.0.join("temporary")));
    assert!(!project.exists());
    let raw = url::Url::parse(evidence["trials"][0]["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read_to_string(raw).unwrap(), "ready");
    let workspace = evidence["trials"][0]["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|observation| observation["id"] == "sevro.observation.workspaces")
        .unwrap()["data"]["candidate"]
        .as_str()
        .unwrap();
    assert!(!Path::new(workspace).exists());
    assert_eq!(
        fs::read_to_string(caller.join("sevro.json")).unwrap(),
        "invalid caller runtime policy"
    );
    assert_eq!(
        fs::read_to_string(caller.join(".codex/config.toml")).unwrap(),
        "invalid = [ caller codex policy"
    );
    assert_eq!(
        fs::read_link(caller.join("unrelated-link")).unwrap(),
        Path::new("missing-target")
    );
    assert!(
        fs::read_dir(directory.0.join("temporary"))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("sevro-demo-"))
    );
}

#[test]
fn demo_human_output_reports_the_assessment_and_retained_evidence() {
    let directory = DemoDirectory::new();
    let output = directory.run(&[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.starts_with("execution=completed grading=completed task=passed\n"));
    assert!(stdout.contains(
        "trial case=basic-graded trial=1 execution=completed grading=completed task=passed\n"
    ));
    assert!(stdout.contains("case=basic-graded candidate duration="));
    assert!(stdout.contains(" candidate tokens=unknown/unknown cost=unknown\n"));
    let path = |prefix: &str| {
        PathBuf::from(
            stdout
                .lines()
                .find_map(|line| line.strip_prefix(prefix))
                .unwrap(),
        )
    };
    let result_file = path("result=");
    let evidence_file = path("evidence=");
    let results = directory.0.join("caller/.sevro/results");
    assert!(result_file.starts_with(&results));
    assert!(evidence_file.starts_with(&results));
    let result = read_json(result_file);
    let evidence = read_json(evidence_file);
    assert_eq!(evidence["result"], result);
    assert_eq!(read_json(results.join("latest.json")), result);
    assert_eq!(result["task"]["verdict"], "passed");
    assert!(
        !Path::new(
            evidence["configuration"]["resolved"]["projectRoot"]
                .as_str()
                .unwrap()
        )
        .exists()
    );
}

#[test]
fn demo_rejects_unsupported_options_before_allocating_inputs() {
    let directory = DemoDirectory::new();
    let output = directory.run(&["--json", "--host", "codex"]);
    assert_eq!(output.status.code(), Some(64));
    assert_eq!(String::from_utf8_lossy(&output.stdout).lines().count(), 1);
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({
            "format":"sevro.cli-result.v1", "runId":null,
            "execution":{"status":"not_run"}, "grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"}, "exitCode":64, "evidencePath":null,
            "cases":[], "diagnostic":{
                "code":"sevro.invocation.invalid",
                "message":"demo accepts only --json; run sevro demo --help"
            }
        })
    );
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "sevro: demo accepts only --json; run sevro demo --help\nCorrect the named option or input and retry. Run sevro run --help for examples and required options.\n"
    );
    assert_eq!(
        fs::read_dir(directory.0.join("temporary")).unwrap().count(),
        0
    );
    assert_eq!(fs::read_dir(directory.0.join("caller")).unwrap().count(), 0);
}

#[test]
fn demo_reports_unusable_temporary_directory_as_one_runner_failure() {
    let directory = DemoDirectory::new();
    let missing = directory.0.join("absent-temp");
    let output = Command::new(directory.0.join("sevro"))
        .args(["demo", "--json"])
        .current_dir(directory.0.join("caller"))
        .env("TMPDIR", &missing)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(70));
    assert_eq!(String::from_utf8_lossy(&output.stdout).lines().count(), 1);
    let message = format!(
        "demo temporary project could not be created under {}; set TMPDIR to a writable directory",
        missing.display()
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({
            "format":"sevro.cli-result.v1", "runId":null,
            "execution":{"status":"not_run"}, "grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"}, "exitCode":70, "evidencePath":null,
            "cases":[], "diagnostic":{"code":"sevro.runner.error", "message":message}
        })
    );
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        format!(
            "sevro: {message}\nCheck the reported path and ensure --results-root and --run-state-root are writable directories, then retry.\n"
        )
    );
    assert!(!missing.exists());
    assert_eq!(fs::read_dir(directory.0.join("caller")).unwrap().count(), 0);
}

#[test]
fn demo_removes_its_inputs_when_run_storage_preparation_fails() {
    let directory = DemoDirectory::new();
    let caller = directory.0.join("caller");
    fs::create_dir(caller.join(".sevro")).unwrap();
    let results = caller.join(".sevro/results");
    fs::write(&results, "caller-owned-results-file").unwrap();
    let output = directory.run(&["--json"]);
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout).lines().count(), 1);
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["format"], "sevro.cli-result.v1");
    assert!(result["runId"].is_null());
    assert_eq!(result["execution"]["status"], "not_run");
    assert_eq!(result["grading"]["status"], "not_requested");
    assert_eq!(result["task"]["verdict"], "not_assessed");
    assert_eq!(result["exitCode"], 70);
    assert!(result["evidencePath"].is_null());
    assert_eq!(result["cases"], json!([]));
    assert_eq!(result["diagnostic"]["code"], "sevro.runner.error");
    let message = result["diagnostic"]["message"].as_str().unwrap();
    assert!(!message.is_empty());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains(&format!("sevro: {message}\n")));
    let settings: Value = serde_json::from_str(
        stderr
            .lines()
            .find_map(|line| line.strip_prefix("sevro: effective settings "))
            .unwrap(),
    )
    .unwrap();
    for field in ["projectRoot", "caseFile", "adapterModule"] {
        let path = Path::new(settings[field].as_str().unwrap());
        assert!(path.starts_with(directory.0.join("temporary")));
        assert!(
            !path.exists(),
            "owned demo input was retained: {}",
            path.display()
        );
    }
    assert_eq!(
        fs::read_to_string(results).unwrap(),
        "caller-owned-results-file"
    );
    assert_eq!(fs::read_dir(caller.join(".sevro")).unwrap().count(), 1);
    assert!(
        fs::read_dir(directory.0.join("temporary"))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("sevro-demo-"))
    );
}
