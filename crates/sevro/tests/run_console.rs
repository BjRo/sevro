use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::process::Command;
use uuid::Uuid;

#[test]
fn successful_exact_output_run_prints_the_observed_completion_summary() {
    let root = std::env::temp_dir().join(format!("sevro-rust-console-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(root.clone());
    fs::write(root.join("case.json"), serde_json::to_vec(&json!({
        "id":"console-ready","prompt":"Return ready.",
        "fixture":{"files":{"README.md":"console fixture\n"}},
        "checks":[{"id":"exact","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
        "requiredEvidence":[]
    })).unwrap()).unwrap();
    fs::write(root.join("adapter.ts"), "export default {id:'sevro.host.console',model:'synthetic',effort:'none',async run(){return {finalMessage:'ready',complete:true,inputTokens:12,outputTokens:3,costUsd:.25,usageComplete:true}}};\n").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_sevro"))
        .current_dir(&root)
        .args([
            "run",
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
        .unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert_eq!(output.status.code(), Some(0), "{stderr}");
    let result: Value =
        serde_json::from_slice(&fs::read(root.join("results/latest.json")).unwrap()).unwrap();
    let evidence_path = Path::new(result["evidencePath"].as_str().unwrap());
    let evidence: Value = serde_json::from_slice(&fs::read(evidence_path).unwrap()).unwrap();
    assert_eq!(evidence["result"], result);
    let duration = evidence["trials"][0]["candidateDurationMs"]
        .as_f64()
        .unwrap();
    assert!(duration.is_finite() && duration >= 0.0);
    let result_path = evidence_path.parent().unwrap().join("result.json");
    let saved_result: Value = serde_json::from_slice(&fs::read(&result_path).unwrap()).unwrap();
    assert_eq!(saved_result, result);
    // Normalize only the exact retained paths (including their generated run ID).
    // The measured duration stays in the output and must match public evidence.
    let stdout = String::from_utf8(output.stdout)
        .unwrap()
        .replace(result_path.to_str().unwrap(), "<RESULT>")
        .replace(evidence_path.to_str().unwrap(), "<EVIDENCE>");
    assert_eq!(
        stdout,
        format!(
            "execution=completed grading=completed task=passed\ntrial case=console-ready trial=1 execution=completed grading=completed task=passed\ncase=console-ready candidate duration={duration:.2}ms candidate tokens=12/3 cost=$0.2500\nresult=<RESULT>\nevidence=<EVIDENCE>\n"
        )
    );
    assert!(stderr.contains("sevro: effective settings "));
    assert!(!stdout.contains("sevro:"));
    assert!(!stderr.contains("trial case=console-ready"));
    assert!(!stderr.contains("candidate tokens=12/3"));
}

#[test]
fn failed_exact_output_prints_sanitized_check_and_unknown_measurements() {
    let root = std::env::temp_dir().join(format!("sevro-rust-console-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    struct Cleanup(Vec<std::path::PathBuf>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for path in &self.0 {
                let _ = fs::remove_dir_all(path);
            }
        }
    }
    let mut cleanup = Cleanup(vec![root.clone()]);
    fs::write(root.join("case.json"), serde_json::to_vec(&json!({
        "id":"console-failed","prompt":"PRIVATE_PROMPT_DO_NOT_PRINT",
        "fixture":{"files":{"README.md":"console failure fixture\n"}},
        "checks":[{"id":"exact\toutput\ncheck","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
        "requiredEvidence":[]
    })).unwrap()).unwrap();
    fs::write(root.join("adapter.ts"), "export default {id:'sevro.host.console',model:'synthetic',effort:'none',async run(){return {finalMessage:'PRIVATE_RESPONSE_DO_NOT_PRINT',complete:true,inputTokens:12,outputTokens:null,costUsd:.25,usageComplete:false}}};\n").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_sevro"))
        .current_dir(&root)
        .args([
            "run",
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
        .unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert_eq!(output.status.code(), Some(1), "{stderr}");
    let result: Value =
        serde_json::from_slice(&fs::read(root.join("results/latest.json")).unwrap()).unwrap();
    let evidence_path = Path::new(result["evidencePath"].as_str().unwrap());
    let evidence: Value = serde_json::from_slice(&fs::read(evidence_path).unwrap()).unwrap();
    let trial = &evidence["trials"][0];
    let workspace = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|observation| observation["id"] == "sevro.observation.workspaces")
        .unwrap()["data"]["candidate"]
        .as_str()
        .unwrap();
    cleanup.0.push(workspace.into());
    assert!(Path::new(workspace).is_dir());
    assert_eq!(evidence["result"], result);
    assert_eq!(
        trial["usage"],
        json!({"inputTokens":12.0,"outputTokens":null,"costUsd":0.25,"complete":false})
    );
    assert_eq!(
        result["cases"][0]["trials"][0]["checks"][0]["id"],
        "exact\toutput\ncheck"
    );
    let raw = url::Url::parse(trial["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(raw).unwrap(), b"PRIVATE_RESPONSE_DO_NOT_PRINT");
    let duration = trial["candidateDurationMs"].as_f64().unwrap();
    assert!(duration.is_finite() && duration >= 0.0);
    let result_path = evidence_path.parent().unwrap().join("result.json");
    let saved_result: Value = serde_json::from_slice(&fs::read(&result_path).unwrap()).unwrap();
    assert_eq!(saved_result, result);
    // Keep actual duration and every summary byte; normalize only retained paths.
    let stdout = String::from_utf8(output.stdout)
        .unwrap()
        .replace(result_path.to_str().unwrap(), "<RESULT>")
        .replace(evidence_path.to_str().unwrap(), "<EVIDENCE>");
    assert_eq!(
        stdout,
        format!(
            "execution=completed grading=completed task=failed\ntrial case=console-failed trial=1 execution=completed grading=completed task=failed\n  check=exact output check status=failed reason=exact output did not match\ncase=console-failed candidate duration={duration:.2}ms candidate tokens=unknown/unknown cost=unknown\nresult=<RESULT>\nevidence=<EVIDENCE>\n"
        )
    );
    assert!(stderr.contains("sevro: effective settings "));
    assert!(!stdout.contains("sevro:"));
    assert!(!stderr.contains("check=exact output check"));
    assert!(!stderr.contains("candidate tokens="));
    for private in [
        "PRIVATE_PROMPT_DO_NOT_PRINT",
        "PRIVATE_RESPONSE_DO_NOT_PRINT",
    ] {
        assert!(!stdout.contains(private));
        assert!(!stderr.contains(private));
    }
}

#[test]
fn complete_usage_rounds_decimal_half_cost_like_the_existing_console() {
    let root = std::env::temp_dir().join(format!("sevro-rust-console-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(root.clone());
    fs::write(root.join("case.json"), serde_json::to_vec(&json!({
        "id":"console-ready","prompt":"Return ready.",
        "fixture":{"files":{"README.md":"console fixture\n"}},
        "checks":[{"id":"exact","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
        "requiredEvidence":[]
    })).unwrap()).unwrap();
    fs::write(root.join("adapter.ts"), "export default {id:'sevro.host.console',model:'synthetic',effort:'none',async run(){return {finalMessage:'ready',complete:true,inputTokens:12,outputTokens:3,costUsd:.03125,usageComplete:true}}};\n").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_sevro"))
        .current_dir(&root)
        .args([
            "run",
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
        .unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert_eq!(output.status.code(), Some(0), "{stderr}");
    let result: Value =
        serde_json::from_slice(&fs::read(root.join("results/latest.json")).unwrap()).unwrap();
    let evidence_path = Path::new(result["evidencePath"].as_str().unwrap());
    let evidence: Value = serde_json::from_slice(&fs::read(evidence_path).unwrap()).unwrap();
    assert_eq!(evidence["result"], result);
    assert_eq!(
        evidence["trials"][0]["usage"],
        json!({"inputTokens":12.0,"outputTokens":3.0,"costUsd":0.03125,"complete":true})
    );
    let duration = evidence["trials"][0]["candidateDurationMs"]
        .as_f64()
        .unwrap();
    assert!(duration.is_finite() && duration >= 0.0);
    let result_path = evidence_path.parent().unwrap().join("result.json");
    let saved_result: Value = serde_json::from_slice(&fs::read(&result_path).unwrap()).unwrap();
    assert_eq!(saved_result, result);
    // The cost text is literal from the TypeScript CLI, not a Rust formatter.
    let stdout = String::from_utf8(output.stdout)
        .unwrap()
        .replace(result_path.to_str().unwrap(), "<RESULT>")
        .replace(evidence_path.to_str().unwrap(), "<EVIDENCE>");
    assert_eq!(
        stdout,
        format!(
            "execution=completed grading=completed task=passed\ntrial case=console-ready trial=1 execution=completed grading=completed task=passed\ncase=console-ready candidate duration={duration:.2}ms candidate tokens=12/3 cost=$0.0313\nresult=<RESULT>\nevidence=<EVIDENCE>\n"
        )
    );
    assert!(!stderr.contains("candidate tokens=12/3"));
}

#[test]
fn failed_host_publication_warning_preserves_plain_evidence_summary() {
    let root = std::env::temp_dir().join(format!("sevro-rust-console-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    struct Cleanup(Vec<std::path::PathBuf>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for path in &self.0 {
                let _ = fs::remove_dir_all(path);
            }
        }
    }
    let mut cleanup = Cleanup(vec![root.clone()]);
    fs::write(
        root.join("case.json"),
        serde_json::to_vec(&json!({
            "id":"console-publication","prompt":"PRIVATE_PROMPT_DO_NOT_PRINT",
            "fixture":{"files":{"README.md":"publication fixture\n"}},
            "checks":[],"requiredEvidence":[]
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(root.join("adapter.ts"), "export default {id:'sevro.host.console',model:'synthetic',effort:'none',async run(){return {executionFailed:true,failureMessage:'controlled host failure',finalMessage:'PRIVATE_PARTIAL_RESPONSE_DO_NOT_PRINT',complete:false,inputTokens:12,outputTokens:3,costUsd:.25,usageComplete:true}}};\n").unwrap();
    let latest = root.join("results/latest.json");
    fs::create_dir_all(&latest).unwrap();
    fs::write(latest.join("sentinel.txt"), "preserve collision\n").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_sevro"))
        .current_dir(&root)
        .args([
            "run",
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
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert_eq!(output.status.code(), Some(2), "{stderr}");
    let evidence_path = Path::new(
        stdout
            .lines()
            .find_map(|line| line.strip_prefix("evidence="))
            .unwrap(),
    );
    assert!(evidence_path.is_absolute());
    let evidence: Value = serde_json::from_slice(&fs::read(evidence_path).unwrap()).unwrap();
    let trial = &evidence["trials"][0];
    let workspace = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|observation| observation["id"] == "sevro.observation.workspaces")
        .unwrap()["data"]["candidate"]
        .as_str()
        .unwrap();
    cleanup.0.push(workspace.into());
    assert!(Path::new(workspace).is_dir());
    let result_path = evidence_path.parent().unwrap().join("result.json");
    let result: Value = serde_json::from_slice(&fs::read(result_path).unwrap()).unwrap();
    assert_eq!(evidence["result"], result);
    assert_eq!(result["exitCode"], 2);
    assert_eq!(
        result["diagnostic"],
        json!({"code":"sevro.host.failed","message":"controlled host failure"})
    );
    assert_eq!(trial["observationCompleteness"], "partial");
    assert_eq!(
        trial["usage"],
        json!({"inputTokens":12.0,"outputTokens":3.0,"costUsd":0.25,"complete":true})
    );
    let duration = trial["candidateDurationMs"].as_f64().unwrap();
    assert!(duration.is_finite() && duration >= 0.0);
    let raw = url::Url::parse(trial["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(
        fs::read(raw).unwrap(),
        b"PRIVATE_PARTIAL_RESPONSE_DO_NOT_PRINT"
    );
    assert_eq!(
        trial["rawResult"]["sha256"],
        "f906a0994073fd2d7300dd96cbe3a7287b1b77986be7255c6c8850b8109f8e53"
    );
    let trial_result = &result["cases"][0]["trials"][0];
    let retained_trial: Value =
        serde_json::from_slice(&fs::read(trial_result["artifactPath"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!(retained_trial["evidence"], *trial);
    assert_eq!(retained_trial["result"], *trial_result);
    assert!(latest.is_dir());
    assert_eq!(
        fs::read_to_string(latest.join("sentinel.txt")).unwrap(),
        "preserve collision\n"
    );
    // Only the actual evidence path is dynamic. Known retained measurements and
    // the existing result.json are deliberately absent from this human summary.
    assert_eq!(
        stdout.replace(evidence_path.to_str().unwrap(), "<EVIDENCE>"),
        "execution=failed grading=not_requested task=not_assessed\ntrial case=console-publication trial=1 execution=failed grading=not_requested task=not_assessed\nevidence=<EVIDENCE>\n"
    );
    assert!(stderr.ends_with("sevro: CLI result/latest could not be retained; original run outcome preserved; inspect evidence directly\nsevro: controlled host failure\n"), "{stderr}");
    for private in [
        "PRIVATE_PROMPT_DO_NOT_PRINT",
        "PRIVATE_PARTIAL_RESPONSE_DO_NOT_PRINT",
    ] {
        assert!(!stdout.contains(private));
        assert!(!stderr.contains(private));
    }
}
