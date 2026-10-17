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
        let root = std::env::temp_dir().join(format!("sevro-rust-receipt-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::write(root.join("case.json"), serde_json::to_vec(&json!({
            "id":"receipt-boundary","prompt":"Return ready.",
            "fixture":{"files":{"README.md":"receipt fixture\n"}},
            "checks":[{"id":"exact","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
            "requiredEvidence":[]
        })).unwrap()).unwrap();
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
        if let Ok(workspace) = fs::read_to_string(self.root.join("workspace.txt")) {
            let _ = fs::remove_dir_all(workspace);
        }
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
fn oversized_final_message_discards_the_unaccepted_receipt() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("adapter.ts"), "export default {id:'sevro.host.receipt',model:'synthetic',effort:'none',async run(){return {finalMessage:'x'.repeat(8*1024*1024+1),complete:true,inputTokens:12,outputTokens:3,costUsd:.25,usageComplete:true,artifacts:[{id:'example.trace',bytes:new Uint8Array([65,10])}]}}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["exitCode"], 2);
    assert_eq!(
        result["diagnostic"],
        json!({"code":"sevro.host.failed","message":"host execution did not complete"})
    );
    for assessment in [
        &result,
        &result["cases"][0],
        &result["cases"][0]["trials"][0],
    ] {
        assert_eq!(assessment["execution"], json!({"status":"failed"}));
        assert_eq!(assessment["grading"], json!({"status":"not_requested"}));
        assert_eq!(assessment["task"], json!({"verdict":"not_assessed"}));
    }
    let summary = &result["cases"][0]["trials"][0];
    assert_eq!(summary["checks"], json!([]));
    let evidence_path = Path::new(result["evidencePath"].as_str().unwrap());
    let evidence = read_json(evidence_path);
    assert_eq!(evidence["result"], result);
    let trial = &evidence["trials"][0];
    assert_eq!(trial["observationCompleteness"], "unavailable");
    assert_eq!(
        trial["rawResult"],
        json!({"source":"sevro.host.receipt","path":null,"sha256":null})
    );
    assert_eq!(
        trial["usage"],
        json!({"inputTokens":null,"outputTokens":null,"costUsd":null,"complete":false})
    );
    assert_eq!(trial["artifactRefs"], json!([]));
    let observations = trial["observations"].as_array().unwrap();
    let final_message = observations
        .iter()
        .find(|item| item["id"] == "sevro.observation.final-message")
        .unwrap();
    assert_eq!(final_message["completeness"], "unavailable");
    assert_eq!(final_message["data"], json!({}));
    let workspace = observations
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap()["data"]["candidate"]
        .as_str()
        .unwrap();
    assert_eq!(
        fs::read(Path::new(workspace).join("README.md")).unwrap(),
        b"receipt fixture\n"
    );
    let run_directory = evidence_path.parent().unwrap();
    assert!(!run_directory.join("trial-1-raw.txt").exists());
    assert!(
        !run_directory
            .join("trial-1-host-example.trace.bin")
            .exists()
    );
    let retained_trial = read_json(Path::new(summary["artifactPath"].as_str().unwrap()));
    assert_eq!(retained_trial["result"], *summary);
    assert_eq!(retained_trial["evidence"], *trial);
    assert_eq!(read_json(&run_directory.join("result.json")), result);
    assert_eq!(read_json(&fixture.root.join("results/latest.json")), result);
}

#[test]
fn raw_evidence_write_failure_retains_actual_partial_evidence_and_workspace() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("adapter.ts"), format!(
        "import {{mkdir,readdir,writeFile}} from 'node:fs/promises';\nimport {{join}} from 'node:path';\nexport default {{id:'sevro.host.receipt',model:'synthetic',effort:'none',async run({{workspace}}){{\nawait writeFile({},workspace);\nconst root={};\nconst run=(await readdir(root,{{withFileTypes:true}})).find(item=>item.isDirectory()&&/^[a-f0-9-]{{36}}$/.test(item.name));\nif(!run)throw new Error('no allocated run directory');\nawait mkdir(join(root,run.name,'trial-1-raw.txt'));\nreturn {{finalMessage:'ready',complete:true,inputTokens:12,outputTokens:3,costUsd:.25,usageComplete:true,artifacts:[{{id:'example.trace',bytes:new Uint8Array([65,10])}}]}};\n}}}};\n",
        json!(fixture.root.join("workspace.txt")),json!(fixture.root.join("results"))
    )).unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let diagnostic = result["diagnostic"]["message"].as_str().unwrap();
    let workspace = diagnostic
        .strip_prefix("trial persistence failed; fixture retained at ")
        .unwrap_or_else(|| panic!("unexpected persistence diagnostic: {diagnostic}"));
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,
            "execution":{"status":"not_run"},"grading":{"status":"not_requested"},"task":{"verdict":"not_assessed"},
            "exitCode":70,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.runner.error","message":diagnostic}
        })
    );
    assert_eq!(
        fs::read(Path::new(workspace).join("README.md")).unwrap(),
        b"receipt fixture\n"
    );
    let runs = fs::read_dir(fixture.root.join("results"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.join("trial-1-raw.txt").is_dir())
        .collect::<Vec<_>>();
    assert_eq!(runs.len(), 1);
    let run = &runs[0];
    assert_eq!(
        fs::read(run.join("trial-1-host-example.trace.bin")).unwrap(),
        b"A\n"
    );
    for name in ["trial-1.json", "run.json", "result.json"] {
        assert!(!run.join(name).exists(), "unexpected published {name}");
    }
    assert!(!fixture.root.join("results/latest.json").exists());
}

#[test]
fn host_artifact_write_failure_keeps_earlier_bytes_and_names_retained_workspace() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("adapter.ts"), format!(
        "import {{mkdir,readdir,writeFile}} from 'node:fs/promises';\nimport {{join}} from 'node:path';\nexport default {{id:'sevro.host.receipt',model:'synthetic',effort:'none',async run({{workspace}}){{\nawait writeFile({},workspace);\nconst root={};\nconst run=(await readdir(root,{{withFileTypes:true}})).find(item=>item.isDirectory()&&/^[a-f0-9-]{{36}}$/.test(item.name));\nif(!run)throw new Error('no allocated run directory');\nawait mkdir(join(root,run.name,'trial-1-host-example.blocked.bin'));\nreturn {{finalMessage:'ready',complete:true,inputTokens:12,outputTokens:3,costUsd:.25,usageComplete:true,artifacts:[{{id:'example.before',bytes:new Uint8Array([65,10])}},{{id:'example.blocked',bytes:new Uint8Array([66,10])}}]}};\n}}}};\n",
        json!(fixture.root.join("workspace.txt")), json!(fixture.root.join("results"))
    )).unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let workspace = fs::read_to_string(fixture.root.join("workspace.txt")).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,
            "execution":{"status":"not_run"},"grading":{"status":"not_requested"},"task":{"verdict":"not_assessed"},
            "exitCode":70,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.runner.error","message":format!("trial persistence failed; fixture retained at {workspace}")}
        })
    );
    assert_eq!(
        fs::read(Path::new(&workspace).join("README.md")).unwrap(),
        b"receipt fixture\n"
    );
    let runs = fs::read_dir(fixture.root.join("results"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.join("trial-1-host-example.blocked.bin").is_dir())
        .collect::<Vec<_>>();
    assert_eq!(runs.len(), 1);
    let run = &runs[0];
    assert_eq!(
        fs::read(run.join("trial-1-host-example.before.bin")).unwrap(),
        b"A\n"
    );
    assert_eq!(
        fs::read_dir(run.join("trial-1-host-example.blocked.bin"))
            .unwrap()
            .count(),
        0
    );
    for name in ["trial-1-raw.txt", "trial-1.json", "run.json", "result.json"] {
        assert!(!run.join(name).exists(), "unexpected published {name}");
    }
    assert!(!fixture.root.join("results/latest.json").exists());
}

#[test]
fn artifact_check_id_collision_discards_the_unaccepted_receipt() {
    let fixture = Fixture::new();
    let mut case = read_json(&fixture.root.join("case.json"));
    case["checks"][0]["id"] = json!("example.trace");
    fs::write(
        fixture.root.join("case.json"),
        serde_json::to_vec(&case).unwrap(),
    )
    .unwrap();
    fs::write(fixture.root.join("adapter.ts"), "export default {id:'sevro.host.receipt',model:'synthetic',effort:'none',async run(){return {finalMessage:'ready',complete:true,inputTokens:12,outputTokens:3,costUsd:.25,usageComplete:true,artifacts:[{id:'example.trace',bytes:new Uint8Array([65,10])}]}}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["exitCode"], 2);
    assert_eq!(
        result["diagnostic"],
        json!({"code":"sevro.host.failed","message":"host execution did not complete"})
    );
    for assessment in [
        &result,
        &result["cases"][0],
        &result["cases"][0]["trials"][0],
    ] {
        assert_eq!(assessment["execution"], json!({"status":"failed"}));
        assert_eq!(assessment["grading"], json!({"status":"not_requested"}));
        assert_eq!(assessment["task"], json!({"verdict":"not_assessed"}));
    }
    let summary = &result["cases"][0]["trials"][0];
    assert_eq!(summary["checks"], json!([]));
    let evidence_path = Path::new(result["evidencePath"].as_str().unwrap());
    let evidence = read_json(evidence_path);
    assert_eq!(evidence["result"], result);
    assert_eq!(evidence["diagnostic"], result["diagnostic"]);
    let trial = &evidence["trials"][0];
    assert_eq!(trial["observationCompleteness"], "unavailable");
    assert_eq!(
        trial["rawResult"],
        json!({"source":"sevro.host.receipt","path":null,"sha256":null})
    );
    assert_eq!(
        trial["usage"],
        json!({"inputTokens":null,"outputTokens":null,"costUsd":null,"complete":false})
    );
    assert_eq!(trial["artifactRefs"], json!([]));
    let observations = trial["observations"].as_array().unwrap();
    let final_message = observations
        .iter()
        .find(|item| item["id"] == "sevro.observation.final-message")
        .unwrap();
    assert_eq!(final_message["completeness"], "unavailable");
    assert_eq!(final_message["data"], json!({}));
    let workspace = observations
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap()["data"]["candidate"]
        .as_str()
        .unwrap();
    assert_eq!(
        fs::read(Path::new(workspace).join("README.md")).unwrap(),
        b"receipt fixture\n"
    );
    let run = evidence_path.parent().unwrap();
    assert!(!run.join("trial-1-raw.txt").exists());
    assert!(!run.join("trial-1-host-example.trace.bin").exists());
    let retained_trial = read_json(Path::new(summary["artifactPath"].as_str().unwrap()));
    assert_eq!(retained_trial["result"], *summary);
    assert_eq!(retained_trial["evidence"], *trial);
    assert_eq!(read_json(&run.join("result.json")), result);
    assert_eq!(read_json(&fixture.root.join("results/latest.json")), result);
}
