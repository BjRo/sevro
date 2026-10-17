use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(sequence: Value) -> Self {
        let root = std::env::temp_dir().join(format!(
            "sevro-rust-results-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::write(
            root.join("case.json"),
            serde_json::to_vec(&json!({
                "id":"result-sequence","prompt":"Return ready.",
                "fixture":{"files":{"README.md":"results fixture\n"}},
                "checks":[{"id":"exact","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
                "requiredEvidence":[]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("adapter.ts"),
            format!(
                "import {{ appendFile }} from 'node:fs/promises';\nlet index=0; const sequence={sequence}; export default {{ id:'sevro.host.synthetic', model:'synthetic-v1', effort:'none', async run() {{ const step=sequence[index++]; await appendFile(new URL('./calls.jsonl',import.meta.url), JSON.stringify({{call:index}})+'\\n'); if(step.fail) throw new Error('private sequence host failure'); return {{finalMessage:step.message,complete:step.complete ?? true,inputTokens:null,outputTokens:null,costUsd:null,usageComplete:false}}; }} }};\n"
            ),
        )
        .unwrap();
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
            ])
            .arg("--project-root")
            .arg(&self.root)
            .arg("--results-root")
            .arg(self.root.join("results"))
            .arg("--runner-build-digest")
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64))
            .args(["--trials", "3", "--threshold", "0.5", "--jobs", "1"])
            .output()
            .unwrap()
    }

    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(self.root.join("calls.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(entries) = fs::read_dir(self.root.join("results")) {
            for entry in entries.flatten() {
                let Ok(bytes) = fs::read(entry.path().join("run.json")) else {
                    continue;
                };
                let Ok(evidence) = serde_json::from_slice::<Value>(&bytes) else {
                    continue;
                };
                for trial in evidence["trials"].as_array().into_iter().flatten() {
                    let _ = fs::remove_dir_all(workspace(trial));
                }
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn workspace(trial: &Value) -> &Path {
    let observation = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|observation| observation["id"] == "sevro.observation.workspaces")
        .unwrap();
    Path::new(observation["data"]["candidate"].as_str().unwrap())
}

fn assessment(value: &Value, execution: &str, grading: &str, task: &str) {
    assert_eq!(value["execution"], json!({"status":execution}));
    assert_eq!(value["grading"], json!({"status":grading}));
    assert_eq!(value["task"], json!({"verdict":task}));
}

fn retained_result(output: &Output, exit_code: i32) -> (Value, Value) {
    assert_eq!(
        output.status.code(),
        Some(exit_code),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["format"], "sevro.cli-result.v1");
    assert_eq!(result["exitCode"], exit_code);
    assert_eq!(result["cases"].as_array().unwrap().len(), 1);
    assert_eq!(result["cases"][0]["caseId"], "result-sequence");
    let path = Path::new(result["evidencePath"].as_str().unwrap());
    let evidence = read_json(path);
    assert_eq!(evidence["format"], "sevro.run-evidence.v1");
    assert_eq!(evidence["result"], result);
    assert_eq!(evidence["runId"], result["runId"]);
    assert_eq!(
        read_json(&path.parent().unwrap().join("result.json")),
        result
    );
    let trials = result["cases"][0]["trials"].as_array().unwrap();
    let retained = evidence["trials"].as_array().unwrap();
    assert_eq!(trials.len(), retained.len());
    for (trial, receipt) in trials.iter().zip(retained) {
        let artifact = read_json(Path::new(trial["artifactPath"].as_str().unwrap()));
        assert_eq!(artifact["format"], "sevro.trial-evidence.v1");
        assert_eq!(artifact["result"], *trial);
        assert_eq!(artifact["evidence"], *receipt);
        assert!(
            !artifact
                .to_string()
                .contains("private sequence host failure")
        );
    }
    assert!(
        !evidence
            .to_string()
            .contains("private sequence host failure")
    );
    assert!(!String::from_utf8_lossy(&output.stderr).contains("private sequence host failure"));
    (result, evidence)
}

fn persisted_result(fixture: &Fixture, output: &Output, exit_code: i32) -> (Value, Value) {
    let (result, evidence) = retained_result(output, exit_code);
    assert_eq!(read_json(&fixture.root.join("results/latest.json")), result);
    (result, evidence)
}

#[test]
fn host_failure_stops_admission_and_preserves_completed_trial_results() {
    let fixture = Fixture::new(json!([
        {"message":"ready"},{"fail":true},{"message":"ready"}
    ]));
    let (result, evidence) = persisted_result(&fixture, &fixture.invoke(), 2);
    assert_eq!(fixture.calls(), vec![json!({"call":1}), json!({"call":2})]);
    for summary in [&result, &result["cases"][0]] {
        assessment(summary, "failed", "completed", "not_assessed");
    }
    let trials = result["cases"][0]["trials"].as_array().unwrap();
    assert_eq!(trials.len(), 2);
    assessment(&trials[0], "completed", "completed", "passed");
    assessment(&trials[1], "failed", "not_requested", "not_assessed");
    assert_eq!(trials[1]["checks"], json!([]));
    assert_eq!(
        result["diagnostic"],
        json!({"code":"sevro.host.failed","message":"host execution did not complete"})
    );
    assert_eq!(evidence["diagnostic"], result["diagnostic"]);
    let first = &evidence["trials"][0];
    let raw = url::Url::parse(first["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(raw).unwrap(), b"ready");
    assert!(!workspace(first).exists());
    let failed = &evidence["trials"][1];
    assert!(workspace(failed).is_dir());
    assert!(failed["candidateDurationMs"].as_f64().unwrap() >= 0.0);
    assert_eq!(failed["observationCompleteness"], "unavailable");
    assert_eq!(failed["rawResult"]["path"], Value::Null);
    assert_eq!(failed["rawResult"]["sha256"], Value::Null);
}

#[test]
fn missing_output_prevents_a_threshold_pass_without_stopping_completed_trials() {
    let fixture = Fixture::new(json!([
        {"message":"ready"},{"message":null},{"message":"ready"}
    ]));
    let (result, evidence) = persisted_result(&fixture, &fixture.invoke(), 4);
    assert_eq!(
        fixture.calls(),
        vec![json!({"call":1}), json!({"call":2}), json!({"call":3})]
    );
    for summary in [&result, &result["cases"][0]] {
        assessment(summary, "completed", "unavailable", "not_assessed");
    }
    let trials = result["cases"][0]["trials"].as_array().unwrap();
    assert_eq!(trials.len(), 3);
    assessment(&trials[0], "completed", "completed", "passed");
    assessment(&trials[1], "completed", "unavailable", "not_assessed");
    assessment(&trials[2], "completed", "completed", "passed");
    assert_eq!(
        trials[1]["checks"],
        json!([{
            "id":"exact","grader":"sevro.output","status":"unavailable",
            "detail":"output observation unavailable","evidenceRefs":[]
        }])
    );
    let missing = &evidence["trials"][1];
    assert_eq!(missing["observationCompleteness"], "unavailable");
    assert_eq!(missing["rawResult"]["path"], Value::Null);
    assert_eq!(missing["rawResult"]["sha256"], Value::Null);
    assert!(workspace(missing).is_dir());
    assert!(!workspace(&evidence["trials"][0]).exists());
    assert!(!workspace(&evidence["trials"][2]).exists());
    assert!(result.get("diagnostic").is_none());
}

#[test]
fn unavailable_grading_preserves_a_failed_trial_and_outranks_task_failure() {
    let fixture = Fixture::new(json!([
        {"message":"no"},{"message":"ready","complete":false},{"message":"ready"}
    ]));
    let (result, evidence) = persisted_result(&fixture, &fixture.invoke(), 4);
    assert_eq!(
        fixture.calls(),
        vec![json!({"call":1}), json!({"call":2}), json!({"call":3})]
    );
    for summary in [&result, &result["cases"][0]] {
        assessment(summary, "completed", "unavailable", "not_assessed");
    }
    let trials = result["cases"][0]["trials"].as_array().unwrap();
    assert_eq!(trials.len(), 3);
    assessment(&trials[0], "completed", "completed", "failed");
    assessment(&trials[1], "completed", "unavailable", "not_assessed");
    assessment(&trials[2], "completed", "completed", "passed");
    assert_eq!(
        trials[0]["checks"],
        json!([{
            "id":"exact","grader":"sevro.output","status":"failed",
            "detail":"exact output did not match",
            "evidenceRefs":["sevro.observation.final-message"]
        }])
    );
    assert_eq!(
        trials[1]["checks"],
        json!([{
            "id":"exact","grader":"sevro.output","status":"unavailable",
            "detail":"output observation unavailable",
            "evidenceRefs":["sevro.observation.final-message"]
        }])
    );
    assert_eq!(evidence["trials"][1]["observationCompleteness"], "partial");
    for (index, bytes) in [b"no".as_slice(), b"ready", b"ready"]
        .into_iter()
        .enumerate()
    {
        let trial = &evidence["trials"][index];
        let raw = url::Url::parse(trial["rawResult"]["path"].as_str().unwrap())
            .unwrap()
            .to_file_path()
            .unwrap();
        assert_eq!(fs::read(raw).unwrap(), bytes);
        assert_eq!(workspace(trial).is_dir(), index < 2);
    }
    assert!(result.get("diagnostic").is_none());
}

#[test]
fn host_failure_outranks_prior_unavailable_evidence_or_failed_assessment() {
    for (message, grading, task) in [
        (Value::Null, "unavailable", "not_assessed"),
        (json!("no"), "completed", "failed"),
    ] {
        let fixture = Fixture::new(json!([
            {"message":message},{"fail":true},{"message":"ready"}
        ]));
        let (result, evidence) = persisted_result(&fixture, &fixture.invoke(), 2);
        assert_eq!(fixture.calls(), vec![json!({"call":1}), json!({"call":2})]);
        for summary in [&result, &result["cases"][0]] {
            assessment(summary, "failed", grading, "not_assessed");
        }
        let trials = result["cases"][0]["trials"].as_array().unwrap();
        assert_eq!(trials.len(), 2);
        assessment(&trials[0], "completed", grading, task);
        assessment(&trials[1], "failed", "not_requested", "not_assessed");
        assert_eq!(trials[1]["checks"], json!([]));
        assert_eq!(
            result["diagnostic"],
            json!({"code":"sevro.host.failed","message":"host execution did not complete"})
        );
        assert_eq!(evidence["diagnostic"], result["diagnostic"]);
        assert!(workspace(&evidence["trials"][0]).is_dir());
        assert!(workspace(&evidence["trials"][1]).is_dir());
    }
}

#[test]
fn latest_pointer_failure_preserves_an_earlier_host_failure_and_evidence() {
    let fixture = Fixture::new(json!([
        {"message":"ready"},{"fail":true},{"message":"ready"}
    ]));
    let latest = fixture.root.join("results/latest.json");
    fs::create_dir_all(&latest).unwrap();
    fs::write(latest.join("sentinel.txt"), "preserve collision\n").unwrap();
    let output = fixture.invoke();
    let (result, evidence) = retained_result(&output, 2);
    for summary in [&result, &result["cases"][0]] {
        assessment(summary, "failed", "completed", "not_assessed");
    }
    assert_eq!(fixture.calls(), vec![json!({"call":1}), json!({"call":2})]);
    let trials = result["cases"][0]["trials"].as_array().unwrap();
    assert_eq!(trials.len(), 2);
    assessment(&trials[0], "completed", "completed", "passed");
    assessment(&trials[1], "failed", "not_requested", "not_assessed");
    assert_eq!(trials[1]["checks"], json!([]));
    assert_eq!(
        result["diagnostic"],
        json!({"code":"sevro.host.failed","message":"host execution did not complete"})
    );
    assert_eq!(evidence["diagnostic"], result["diagnostic"]);
    let first = &evidence["trials"][0];
    let raw = url::Url::parse(first["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(raw).unwrap(), b"ready");
    assert!(!workspace(first).exists());
    assert!(workspace(&evidence["trials"][1]).is_dir());
    assert!(latest.is_dir());
    assert_eq!(
        fs::read_to_string(latest.join("sentinel.txt")).unwrap(),
        "preserve collision\n"
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains(
        "CLI result/latest could not be retained; original run outcome preserved; inspect evidence directly"
    ));
}
