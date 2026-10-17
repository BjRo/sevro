use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("sevro-rust-required-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::write(root.join("case.json"), serde_json::to_vec(&json!({
            "id":"required-evidence","prompt":"Return ready.",
            "fixture":{"files":{"README.md":"required evidence fixture\n"}},
            "checks":[{"id":"exact","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
            "requiredEvidence":["example.receipt"]
        })).unwrap()).unwrap();
        fs::write(root.join("adapter.ts"), "export default {id:'sevro.host.required',model:'synthetic',effort:'none',async run(){return {finalMessage:'ready',complete:true}}};\n").unwrap();
        Self { root }
    }

    fn invoke(&self) -> Output {
        Command::new(env!("CARGO_BIN_EXE_sevro"))
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
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(entries) = fs::read_dir(self.root.join("results")) {
            for entry in entries.flatten() {
                if let Ok(bytes) = fs::read(entry.path().join("run.json"))
                    && let Ok(value) = serde_json::from_slice::<Value>(&bytes)
                    && let Some(trials) = value["trials"].as_array()
                {
                    for trial in trials {
                        if let Some(observations) = trial["observations"].as_array() {
                            for observation in observations {
                                if observation["id"] == "sevro.observation.workspaces"
                                    && let Some(path) = observation["data"]["candidate"].as_str()
                                {
                                    let _ = fs::remove_dir_all(path);
                                }
                            }
                        }
                    }
                }
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn missing_required_evidence_preserves_passing_check_and_returns_unavailable() {
    let fixture = Fixture::new();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["exitCode"], 4);
    for assessment in [
        &result,
        &result["cases"][0],
        &result["cases"][0]["trials"][0],
    ] {
        assert_eq!(assessment["execution"], json!({"status":"completed"}));
        assert_eq!(assessment["grading"], json!({"status":"unavailable"}));
        assert_eq!(assessment["task"], json!({"verdict":"not_assessed"}));
    }
    assert!(result.get("diagnostic").is_none());
    let summary = &result["cases"][0]["trials"][0];
    assert_eq!(
        summary["checks"],
        json!([{
            "id":"exact","grader":"sevro.output","status":"passed","detail":"ok",
            "evidenceRefs":["sevro.observation.final-message"]
        }])
    );
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    assert_eq!(evidence["result"], result);
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["requiredEvidenceDigest"],
        "161c1e21ac93ec931b698c87e715a0186b1a5802b84a294fbd35b61c3a883d1e"
    );
    let trial = &evidence["trials"][0];
    assert_eq!(trial["artifactRefs"], json!([]));
    assert_eq!(trial["observationCompleteness"], "complete");
    let raw = url::Url::parse(trial["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(raw).unwrap(), b"ready");
    let workspace = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert!(Path::new(workspace["data"]["candidate"].as_str().unwrap()).is_dir());
    let retained = read_json(Path::new(summary["artifactPath"].as_str().unwrap()));
    assert_eq!(retained["result"], *summary);
    assert_eq!(retained["evidence"], *trial);
    assert_eq!(read_json(&fixture.root.join("results/latest.json")), result);
}

#[test]
fn missing_required_evidence_preserves_a_failed_check_verdict() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("adapter.ts"), "export default {id:'sevro.host.required',model:'synthetic',effort:'none',async run(){return {finalMessage:'wait',complete:true}}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    for assessment in [
        &result,
        &result["cases"][0],
        &result["cases"][0]["trials"][0],
    ] {
        assert_eq!(assessment["execution"], json!({"status":"completed"}));
        assert_eq!(assessment["grading"], json!({"status":"unavailable"}));
        assert_eq!(assessment["task"], json!({"verdict":"failed"}));
    }
    assert_eq!(
        result["cases"][0]["trials"][0]["checks"],
        json!([{
            "id":"exact","grader":"sevro.output","status":"failed","detail":"exact output did not match",
            "evidenceRefs":["sevro.observation.final-message"]
        }])
    );
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    assert_eq!(evidence["result"], result);
    let raw = url::Url::parse(evidence["trials"][0]["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(raw).unwrap(), b"wait");
}

#[test]
fn actual_retained_host_artifact_satisfies_required_evidence() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("adapter.ts"), "export default {id:'sevro.host.required',model:'synthetic',effort:'none',async run(){return {finalMessage:'ready',complete:true,artifacts:[{id:'example.receipt',bytes:new Uint8Array([0,255,128,10,13,42])}]}}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    for assessment in [
        &result,
        &result["cases"][0],
        &result["cases"][0]["trials"][0],
    ] {
        assert_eq!(assessment["execution"], json!({"status":"completed"}));
        assert_eq!(assessment["grading"], json!({"status":"completed"}));
        assert_eq!(assessment["task"], json!({"verdict":"passed"}));
    }
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    assert_eq!(evidence["result"], result);
    let trial = &evidence["trials"][0];
    let artifacts = trial["artifactRefs"].as_array().unwrap();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0]["id"], "example.receipt");
    assert_eq!(
        artifacts[0]["sha256"],
        "f58452139dc66886579a1e60a27c45ccfca7ff93ac0490c01a0f26e6c3dbed02"
    );
    let artifact = url::Url::parse(artifacts[0]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(artifact).unwrap(), [0, 255, 128, 10, 13, 42]);
    let workspace = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert!(!Path::new(workspace["data"]["candidate"].as_str().unwrap()).exists());
}

#[test]
fn complete_builtin_observations_satisfy_required_evidence() {
    let fixture = Fixture::new();
    let mut case = read_json(&fixture.root.join("case.json"));
    case["requiredEvidence"] = json!([
        "sevro.observation.final-message",
        "sevro.observation.workspaces"
    ]);
    fs::write(
        fixture.root.join("case.json"),
        serde_json::to_vec(&case).unwrap(),
    )
    .unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    for assessment in [
        &result,
        &result["cases"][0],
        &result["cases"][0]["trials"][0],
    ] {
        assert_eq!(assessment["execution"], json!({"status":"completed"}));
        assert_eq!(assessment["grading"], json!({"status":"completed"}));
        assert_eq!(assessment["task"], json!({"verdict":"passed"}));
    }
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = &evidence["trials"][0];
    assert_eq!(trial["artifactRefs"], json!([]));
    let observations = trial["observations"].as_array().unwrap();
    for id in [
        "sevro.observation.final-message",
        "sevro.observation.workspaces",
    ] {
        let observation = observations.iter().find(|item| item["id"] == id).unwrap();
        assert_eq!(observation["completeness"], "complete");
    }
    let raw = url::Url::parse(trial["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(raw).unwrap(), b"ready");
    let workspace = observations
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert!(!Path::new(workspace["data"]["candidate"].as_str().unwrap()).exists());
}

#[test]
fn partial_required_output_is_unavailable_even_without_checks() {
    let fixture = Fixture::new();
    let mut case = read_json(&fixture.root.join("case.json"));
    case["checks"] = json!([]);
    case["requiredEvidence"] = json!([
        "sevro.observation.final-message",
        "sevro.observation.workspaces"
    ]);
    fs::write(
        fixture.root.join("case.json"),
        serde_json::to_vec(&case).unwrap(),
    )
    .unwrap();
    fs::write(fixture.root.join("adapter.ts"), "export default {id:'sevro.host.required',model:'synthetic',effort:'none',async run(){return {finalMessage:'ready',complete:false}}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    for assessment in [
        &result,
        &result["cases"][0],
        &result["cases"][0]["trials"][0],
    ] {
        assert_eq!(assessment["execution"], json!({"status":"completed"}));
        assert_eq!(assessment["grading"], json!({"status":"unavailable"}));
        assert_eq!(assessment["task"], json!({"verdict":"not_assessed"}));
    }
    assert_eq!(result["cases"][0]["trials"][0]["checks"], json!([]));
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = &evidence["trials"][0];
    assert_eq!(trial["observationCompleteness"], "partial");
    let observations = trial["observations"].as_array().unwrap();
    let output_observation = observations
        .iter()
        .find(|item| item["id"] == "sevro.observation.final-message")
        .unwrap();
    assert_eq!(output_observation["completeness"], "partial");
    let raw = url::Url::parse(trial["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(raw).unwrap(), b"ready");
    let workspace = observations
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert!(Path::new(workspace["data"]["candidate"].as_str().unwrap()).is_dir());
}
