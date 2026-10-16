use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct RetainedRun {
    root: PathBuf,
    result_path: PathBuf,
    evidence_path: PathBuf,
}

impl RetainedRun {
    fn graded() -> Self {
        let root = std::env::temp_dir().join(format!(
            "sevro-rust-report-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let result_path = root.join("result.json");
        let evidence_path = root.join("evidence.json");
        let trial_path = root.join("trial-1.json");
        let result = json!({
            "format": "sevro.cli-result.v1",
            "runId": "run-example",
            "execution": {"status": "completed"},
            "grading": {"status": "completed"},
            "task": {"verdict": "passed"},
            "exitCode": 0,
            "evidencePath": evidence_path,
            "cases": [{
                "caseId": "ready",
                "execution": {"status": "completed"},
                "grading": {"status": "completed"},
                "task": {"verdict": "passed"},
                "trials": [{
                    "trial": 1,
                    "execution": {"status": "completed"},
                    "grading": {"status": "completed"},
                    "task": {"verdict": "passed"},
                    "checks": [{"id": "ready", "grader":"sevro.regex", "status": "passed", "evidenceRefs": []}],
                    "artifactPath": trial_path
                }]
            }]
        });
        let route =
            json!({"role":"candidate","host":"example.host","model":"fixture","effort":"none"});
        let digest = "a".repeat(64);
        let evidence = json!({
            "format": "sevro.run-evidence.v1",
            "runId": "run-example",
            "evaluationIdentity": {
                "algorithm": "sevro.identity.v1", "digest": digest,
                "dimensions": {
                    "runnerBuildDigest": digest, "projectDigest": digest,
                    "configurationDigest": digest, "extensionDigest": null,
                    "extensionProtocol": null, "caseDigest": digest,
                    "fixtureDigest": digest, "checksDigest": digest,
                    "requiredEvidenceDigest": digest, "evaluatorDigest": digest,
                    "graderDigest": digest, "instrumentationDigest": digest,
                    "routeDigest": digest, "condition": "passive",
                    "trialCount": 1, "passThreshold": 1
                }
            },
            "configuration": {"digest": digest, "redacted": {}},
            "runner": {"source":"package","packageName":"sevro","version":"1.0.0","buildDigest":digest},
            "project": {"root":"file:///tmp/project","revision":null,"dirtyPatchDigest":null},
            "extension": null,
            "condition": {"requested":"passive","actual":"passive","requestedInstrumentation":[],"appliedInstrumentation":[]},
            "graders": {"active":[],"replacedDefaults":[]},
            "routes": [route],
            "result": result,
            "trials": [{
                "caseId":"ready", "trial":1,"executionMode":"executed",
                "condition":{"requested":"passive","actual":"passive","appliedInstrumentation":[]},
                "candidateDurationMs":1250,
                "observationCompleteness":"complete","observations":[],"metrics":[],
                "taskVerdictPolicy":null,"routes":[route],
                "usage":{"inputTokens":12,"outputTokens":3,"costUsd":0.001,"complete":true},
                "rawResult":{"source":"synthetic","path":null,"sha256":null},
                "artifactRefs":[]
            }]
        });
        write_json(&result_path, &result);
        write_json(&evidence_path, &evidence);
        Self {
            root,
            result_path,
            evidence_path,
        }
    }

    fn invoke(&self, options: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_sevro"))
            .arg("report")
            .args(options)
            .arg("--result-file")
            .arg(&self.result_path)
            .output()
            .unwrap()
    }

    fn edit(&self, change: impl FnOnce(&mut Value, &mut Value)) {
        let mut result = read_json(&self.result_path);
        let mut evidence = read_json(&self.evidence_path);
        change(&mut result, &mut evidence);
        evidence["result"] = result.clone();
        write_json(&self.result_path, &result);
        write_json(&self.evidence_path, &evidence);
    }
}

impl Drop for RetainedRun {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn write_json(path: &Path, value: &Value) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn reports_one_retained_case_as_json() {
    let run = RetainedRun::graded();
    let output = run.invoke(&["--json"]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        actual,
        json!({
            "format":"sevro.report.v1",
            "inputs":[{
                "resultFile":run.result_path,
                "execution":"completed","grading":"completed","task":"passed","exitCode":0,"caseCount":1
            }],
            "rows":[{
                "resultFile":run.result_path,"evidencePath":run.evidence_path,"runId":"run-example","caseId":"ready",
                "execution":"completed","grading":"completed","task":"passed","exitCode":0,
                "trialCount":1,"taskPassRate":1.0,"candidateDurationMs":1250.0,"inputTokens":12.0,"outputTokens":3.0,"costUsd":0.001,
                "runnerBuildDigest":"a".repeat(64),"evaluationDigest":"a".repeat(64),"requestedCondition":"passive","actualCondition":"passive",
                "candidateRoute":{"host":"example.host","model":"fixture","effort":"none"},
                "routes":[{"role":"candidate","host":"example.host","model":"fixture","effort":"none"}],"domainOutcomes":[]
            }],
            "summary":{"cases":1,"passed":1,"failed":0,"notAssessed":0}
        })
    );
}

#[test]
fn reports_readable_markdown_by_default() {
    let run = RetainedRun::graded();
    let output = run.invoke(&[]);
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.starts_with("# Sevro evaluation report\n"), "{text}");
    assert!(text.contains("Cases: 1; passed: 1; failed: 0; not assessed: 0."));
    assert!(text.contains("| ready | passed | completed | completed | 100% | 1.25s | 12 / 3 | $0.0010 | passive / passive | example.host/fixture@none |"));
    assert!(text.contains(&format!("- ready: {}", run.evidence_path.display())));
    assert!(text.contains("| ready | candidate | example.host | fixture | none |"));
    assert!(!text.contains("## Domain outcomes"));
}

#[test]
fn refuses_documents_outside_the_published_schemas() {
    let invalid = [
        ("result", "/format", json!("foreign.v1")),
        ("result", "/exitCode", json!(5)),
        ("result", "/extra", json!(true)),
        ("result", "/cases/0/trials/0/trial", json!(0)),
        ("result", "/grading/status", json!("error")),
        ("evidence", "/format", json!("foreign.v1")),
        ("evidence", "/runner/buildDigest", json!("A".repeat(64))),
        ("evidence", "/trials/0/usage/inputTokens", json!(-1)),
        ("evidence", "/trials/0/usage/outputTokens", json!(0.5)),
        (
            "evidence",
            "/trials/0/condition/appliedInstrumentation",
            json!([{"id":"example.guard","configuration":{},"extra":true}]),
        ),
    ];
    for (document, pointer, replacement) in invalid {
        let run = RetainedRun::graded();
        run.edit(|result, evidence| {
            let selected = if document == "result" {
                result
            } else {
                evidence
            };
            if pointer == "/extra" {
                selected["extra"] = replacement;
            } else {
                *selected.pointer_mut(pointer).unwrap() = replacement;
            }
        });
        let output = run.invoke(&["--json"]);
        assert_eq!(
            output.status.code(),
            Some(64),
            "accepted {document}{pointer}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}

#[test]
fn refuses_inconsistent_retained_evidence() {
    for scenario in [
        "missing-trial",
        "duplicate-trial",
        "wrong-trial",
        "wrong-run",
        "missing-route",
        "duplicate-route",
        "wrong-result",
    ] {
        let run = RetainedRun::graded();
        let mut evidence = read_json(&run.evidence_path);
        match scenario {
            "missing-trial" => evidence["trials"] = json!([]),
            "duplicate-trial" => {
                let duplicate = evidence["trials"][0].clone();
                evidence["trials"].as_array_mut().unwrap().push(duplicate);
            }
            "wrong-trial" => evidence["trials"][0]["trial"] = json!(2),
            "wrong-run" => evidence["runId"] = json!("another-run"),
            "missing-route" => evidence["routes"] = json!([]),
            "duplicate-route" => {
                let duplicate = evidence["routes"][0].clone();
                evidence["routes"].as_array_mut().unwrap().push(duplicate);
            }
            "wrong-result" => evidence["result"]["exitCode"] = json!(1),
            _ => unreachable!(),
        }
        write_json(&run.evidence_path, &evidence);
        let output = run.invoke(&["--json"]);
        assert_eq!(
            output.status.code(),
            Some(64),
            "accepted {scenario}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}

#[test]
fn distinguishes_measured_zero_from_unknown_usage_and_historical_duration() {
    for complete in [true, false] {
        let run = RetainedRun::graded();
        run.edit(|_, evidence| {
            evidence["trials"][0]["usage"] =
                json!({"inputTokens":0,"outputTokens":0,"costUsd":0,"complete":complete});
            if complete {
                evidence["trials"][0]["candidateDurationMs"] = json!(0);
            } else {
                evidence["trials"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("candidateDurationMs");
            }
        });
        let output = run.invoke(&["--json"]);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        for field in [
            "candidateDurationMs",
            "inputTokens",
            "outputTokens",
            "costUsd",
        ] {
            assert_eq!(
                report["rows"][0][field],
                if complete { json!(0.0) } else { Value::Null },
                "{field}, complete={complete}"
            );
        }
        let markdown = String::from_utf8(run.invoke(&[]).stdout).unwrap();
        assert!(
            markdown.contains(if complete {
                "100% | 0.00s | 0 / 0 | $0.0000"
            } else {
                "100% | unknown | unknown / unknown | unknown"
            }),
            "{markdown}"
        );
    }
}

#[test]
fn leaves_unassessed_pass_rates_unknown() {
    for mode in ["prompt-only", "dry", "empty"] {
        let run = RetainedRun::graded();
        run.edit(|result, evidence| {
            for pointer in ["", "/cases/0", "/cases/0/trials/0"] {
                let assessment = result.pointer_mut(pointer).unwrap();
                assessment["execution"]["status"] = json!(if mode == "prompt-only" {
                    "completed"
                } else {
                    "not_run"
                });
                assessment["grading"]["status"] = json!("not_requested");
                assessment["task"]["verdict"] = json!("not_assessed");
            }
            result["cases"][0]["trials"][0]["checks"] = json!([]);
            evidence["trials"][0]["candidateDurationMs"] = Value::Null;
            evidence["trials"][0]["usage"] =
                json!({"inputTokens":null,"outputTokens":null,"costUsd":null,"complete":false});
            if mode == "dry" {
                evidence["trials"][0]["executionMode"] = json!("dry");
            }
            if mode == "empty" {
                result["cases"][0]["trials"] = json!([]);
                evidence["trials"] = json!([]);
            }
        });
        let output = run.invoke(&["--json"]);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["rows"][0]["taskPassRate"], Value::Null, "{mode}");
        assert_eq!(
            report["rows"][0]["candidateDurationMs"],
            Value::Null,
            "{mode}"
        );
        assert_eq!(
            report["summary"],
            json!({"cases":1,"passed":0,"failed":0,"notAssessed":1})
        );
    }
}

#[test]
fn reports_prerun_failure_without_inventing_case_evidence() {
    let run = RetainedRun::graded();
    write_json(
        &run.result_path,
        &json!({
            "format":"sevro.cli-result.v1", "runId":null,
            "execution":{"status":"not_run"},"grading":{"status":"not_requested"},"task":{"verdict":"not_assessed"},
            "exitCode":64,"evidencePath":null,"cases":[]
        }),
    );
    fs::remove_file(&run.evidence_path).unwrap();
    let output = run.invoke(&["--json"]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report,
        json!({
            "format":"sevro.report.v1", "rows":[],
            "inputs":[{"resultFile":run.result_path,"execution":"not_run","grading":"not_requested","task":"not_assessed","exitCode":64,"caseCount":0}],
            "summary":{"cases":0,"passed":0,"failed":0,"notAssessed":0}
        })
    );
    assert!(
        String::from_utf8(run.invoke(&[]).stdout)
            .unwrap()
            .contains("| 64 | not_run | not_requested | not_assessed | 0 |")
    );
    let mut falsely_successful = read_json(&run.result_path);
    falsely_successful["exitCode"] = json!(0);
    write_json(&run.result_path, &falsely_successful);
    assert_eq!(run.invoke(&["--json"]).status.code(), Some(64));
}

#[test]
fn reports_domain_outcomes_separately_and_escapes_markdown_labels() {
    for verdict in ["passed", "failed"] {
        let run = RetainedRun::graded();
        run.edit(|result, evidence| {
            for pointer in ["", "/cases/0", "/cases/0/trials/0"] {
                result.pointer_mut(pointer).unwrap()["task"]["verdict"] = json!(verdict);
            }
            result["exitCode"] = json!(if verdict == "failed" { 1 } else { 0 });
            result["cases"][0]["caseId"] = json!("case|line\nnext");
            evidence["trials"][0]["caseId"] = json!("case|line\nnext");
            let outcomes =
                json!([{"id":"example.activation","status":"unavailable","evidenceRefs":[]}]);
            result["cases"][0]["trials"][0]["domainOutcomes"] = outcomes.clone();
            evidence["trials"][0]["domainOutcomes"] = outcomes;
            evidence["routes"][0]["model"] = json!("model|line\nnext");
        });
        let output = run.invoke(&["--json"]);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            report["rows"][0]["domainOutcomes"],
            json!([{"trial":1,"id":"example.activation","status":"unavailable"}])
        );
        assert_eq!(report["rows"][0]["task"], verdict);
        assert_eq!(
            report["rows"][0]["taskPassRate"],
            json!(if verdict == "failed" { 0.0 } else { 1.0 })
        );
        assert_eq!(report["summary"][verdict], 1);
        let markdown = String::from_utf8(run.invoke(&[]).stdout).unwrap();
        assert!(
            markdown.contains("| case\\|line next | 1 | example.activation | unavailable |"),
            "{markdown}"
        );
        assert!(markdown.contains("Domain outcomes are independent of the task verdict."));
        assert!(markdown.contains("example.host/model\\|line next@none"));
    }
}

#[test]
fn selects_latest_or_explicit_results_and_rejects_ambiguous_sources() {
    let run = RetainedRun::graded();
    for root in [".sevro/results", "saved"] {
        fs::create_dir_all(run.root.join(root)).unwrap();
        fs::copy(&run.result_path, run.root.join(root).join("latest.json")).unwrap();
    }
    let invoke = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_sevro"))
            .current_dir(&run.root)
            .arg("report")
            .arg("--json")
            .args(args)
            .output()
            .unwrap()
    };
    for (args, expected) in [
        (vec!["--latest"], ".sevro/results/latest.json"),
        (
            vec!["--latest", "--results-root", "saved"],
            "saved/latest.json",
        ),
        (
            vec!["--latest", "--results-root=saved"],
            "saved/latest.json",
        ),
        (vec!["--result-file", "result.json"], "result.json"),
        (vec!["--result-file=result.json"], "result.json"),
    ] {
        let output = invoke(&args);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            report["inputs"][0]["resultFile"],
            json!(run.root.join(expected))
        );
    }
    for args in [
        vec![],
        vec!["--unknown"],
        vec!["extra"],
        vec!["--json=true"],
        vec!["--latest", "--result-file", "result.json"],
        vec!["--results-root", "saved"],
        vec![
            "--result-file",
            "result.json",
            "--result-file",
            "./result.json",
        ],
        vec!["--result-file", ""],
        vec!["--result-file"],
        vec!["--result-file", "missing.json"],
        vec!["--latest", "--results-root", "missing"],
    ] {
        let output = invoke(&args);
        assert_eq!(output.status.code(), Some(64), "accepted {args:?}");
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}

#[test]
fn refuses_missing_unreadable_or_relative_retained_evidence() {
    for mode in ["relative", "null", "missing", "malformed", "non-utf8"] {
        let run = RetainedRun::graded();
        match mode {
            "relative" => run.edit(|result, _| result["evidencePath"] = json!("evidence.json")),
            "null" => run.edit(|result, _| result["evidencePath"] = Value::Null),
            "missing" => fs::remove_file(&run.evidence_path).unwrap(),
            "malformed" => fs::write(&run.evidence_path, b"{broken").unwrap(),
            "non-utf8" => fs::write(&run.evidence_path, [255]).unwrap(),
            _ => unreachable!(),
        }
        let output = Command::new(env!("CARGO_BIN_EXE_sevro"))
            .current_dir(&run.root)
            .args(["report", "--json", "--result-file", "result.json"])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(64), "accepted {mode}");
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}

#[test]
fn preserves_run_case_order_and_sums_only_complete_trial_measurements() {
    let first = RetainedRun::graded();
    first.edit(|result, evidence| {
        let mut failed = result["cases"][0]["trials"][0].clone();
        failed["trial"] = json!(2);
        failed["task"]["verdict"] = json!("failed");
        failed["checks"][0]["status"] = json!("failed");
        result["cases"][0]["trials"]
            .as_array_mut()
            .unwrap()
            .push(failed);
        let mut retained = evidence["trials"][0].clone();
        retained["trial"] = json!(2);
        retained["candidateDurationMs"] = json!(750);
        retained["usage"] =
            json!({"inputTokens":8,"outputTokens":7,"costUsd":0.002,"complete":true});
        evidence["trials"].as_array_mut().unwrap().push(retained);
        let mut prompt = result["cases"][0].clone();
        prompt["caseId"] = json!("prompt-only");
        prompt["grading"]["status"] = json!("not_requested");
        prompt["task"]["verdict"] = json!("not_assessed");
        prompt["trials"].as_array_mut().unwrap().truncate(1);
        prompt["trials"][0]["grading"]["status"] = json!("not_requested");
        prompt["trials"][0]["task"]["verdict"] = json!("not_assessed");
        prompt["trials"][0]["checks"] = json!([]);
        result["cases"].as_array_mut().unwrap().push(prompt);
        result["task"]["verdict"] = json!("not_assessed");
        let mut unmeasured = evidence["trials"][0].clone();
        unmeasured["caseId"] = json!("prompt-only");
        unmeasured["candidateDurationMs"] = Value::Null;
        unmeasured["usage"] =
            json!({"inputTokens":null,"outputTokens":null,"costUsd":null,"complete":false});
        evidence["trials"].as_array_mut().unwrap().push(unmeasured);
        for role in ["semantic", "advisory"] {
            evidence["routes"]
                .as_array_mut()
                .unwrap()
                .push(json!({"role":role,"host":"example.judge","model":"judge","effort":"high"}));
        }
    });
    let second = RetainedRun::graded();
    second.edit(|_, evidence| evidence["trials"][0]["usage"]["costUsd"] = Value::Null);
    let output = Command::new(env!("CARGO_BIN_EXE_sevro"))
        .args(["report", "--json", "--result-file"])
        .arg(&first.result_path)
        .arg("--result-file")
        .arg(&second.result_path)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["summary"],
        json!({"cases":3,"passed":2,"failed":0,"notAssessed":1})
    );
    let rows = report["rows"].as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|row| row["caseId"].clone())
            .collect::<Vec<_>>(),
        vec![json!("ready"), json!("prompt-only"), json!("ready")]
    );
    assert_eq!(
        rows.iter()
            .map(|row| row["resultFile"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!(first.result_path),
            json!(first.result_path),
            json!(second.result_path)
        ]
    );
    assert_eq!(rows[0]["taskPassRate"], json!(0.5));
    assert_eq!(rows[0]["candidateDurationMs"], json!(2000.0));
    assert_eq!(rows[0]["inputTokens"], json!(20.0));
    assert_eq!(rows[0]["outputTokens"], json!(10.0));
    assert_eq!(rows[0]["costUsd"], json!(0.003));
    assert_eq!(rows[0]["routes"].as_array().unwrap().len(), 3);
    assert_eq!(rows[1]["taskPassRate"], Value::Null);
    assert_eq!(rows[1]["candidateDurationMs"], Value::Null);
    assert_eq!(rows[2]["inputTokens"], json!(12.0));
    assert_eq!(rows[2]["costUsd"], Value::Null);
}

#[test]
fn accepts_canonical_numeric_equivalence_in_retained_results() {
    let run = RetainedRun::graded();
    let mut evidence = read_json(&run.evidence_path);
    evidence["result"]["exitCode"] = json!(-0.0);
    evidence["result"]["cases"][0]["trials"][0]["trial"] = json!(1.0);
    evidence["trials"][0]["trial"] = json!(1.0);
    write_json(&run.evidence_path, &evidence);
    let output = run.invoke(&["--json"]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["rows"][0]["task"], "passed");
}

#[test]
fn markdown_rounds_exact_decimal_halves_like_the_existing_report() {
    let run = RetainedRun::graded();
    run.edit(|result, evidence| {
        let first_trial = result["cases"][0]["trials"][0].clone();
        let first_evidence = evidence["trials"][0].clone();
        for index in 2..=8 {
            let mut trial = first_trial.clone();
            trial["trial"] = json!(index);
            trial["task"]["verdict"] = json!("failed");
            result["cases"][0]["trials"]
                .as_array_mut()
                .unwrap()
                .push(trial);
            let mut retained = first_evidence.clone();
            retained["trial"] = json!(index);
            retained["candidateDurationMs"] = json!(0);
            retained["usage"]["costUsd"] = json!(0);
            evidence["trials"].as_array_mut().unwrap().push(retained);
        }
        evidence["trials"][0]["candidateDurationMs"] = json!(1125);
        evidence["trials"][0]["usage"]["costUsd"] = json!(0.03125);
    });
    let output = run.invoke(&[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(
        text.contains("| 13% | 1.13s | 96 / 24 | $0.0313 |"),
        "{text}"
    );
}

#[test]
fn markdown_uses_ecmascript_exponents_for_large_measurements() {
    let run = RetainedRun::graded();
    run.edit(|_, evidence| {
        evidence["trials"][0]["candidateDurationMs"] = json!(1e24);
        evidence["trials"][0]["usage"] =
            json!({"inputTokens":1e21,"outputTokens":1e21,"costUsd":1e21,"complete":true});
    });
    let output = run.invoke(&[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(
        text.contains("| 100% | 1e+21s | 1e+21 / 1e+21 | $1e+21 |"),
        "{text}"
    );
}

#[test]
fn refuses_overflowing_measured_totals_instead_of_fabricating_unknown() {
    for field in [
        "/candidateDurationMs",
        "/usage/inputTokens",
        "/usage/outputTokens",
        "/usage/costUsd",
    ] {
        let run = RetainedRun::graded();
        run.edit(|result, evidence| {
            let mut trial = result["cases"][0]["trials"][0].clone();
            trial["trial"] = json!(2);
            result["cases"][0]["trials"]
                .as_array_mut()
                .unwrap()
                .push(trial);
            let mut retained = evidence["trials"][0].clone();
            retained["trial"] = json!(2);
            evidence["trials"].as_array_mut().unwrap().push(retained);
            for trial in evidence["trials"].as_array_mut().unwrap() {
                *trial.pointer_mut(field).unwrap() = json!(1e308);
            }
        });
        let output = run.invoke(&["--json"]);
        assert_eq!(
            output.status.code(),
            Some(64),
            "accepted overflow {field}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}
