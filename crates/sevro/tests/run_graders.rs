use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    adapter: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "sevro-rust-graders-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::write(
            root.join("case.json"),
            serde_json::to_vec(&json!({
                "id":"output-exact", "prompt":"Return ready.",
                "fixture":{"files":{"README.md":"grading fixture\n"}},
                "checks":[{"id":"exact","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
                "requiredEvidence":[]
            }))
            .unwrap(),
        )
        .unwrap();
        Self {
            root,
            adapter: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/fixtures/host-adapter.ts"),
        }
    }

    fn observation(&mut self, final_message: Option<&str>, complete: bool) {
        self.adapter = self.root.join("adapter.ts");
        let receipt = json!({
            "finalMessage":final_message,"complete":complete,
            "inputTokens":null,"outputTokens":null,"costUsd":null,"usageComplete":false
        });
        fs::write(
            &self.adapter,
            format!(
                "export default {{ id:'sevro.host.synthetic', model:'synthetic-v1', effort:'none', async run() {{ return {receipt}; }} }};\n"
            ),
        )
        .unwrap();
    }

    fn output_configuration(&self, configuration: Value) {
        let path = self.root.join("case.json");
        let mut case = read_json(&path);
        case["id"] = json!("output-json");
        case["prompt"] = json!("Return JSON.");
        case["checks"] =
            json!([{"id":"json","grader":"sevro.output","configuration":configuration}]);
        fs::write(path, serde_json::to_vec(&case).unwrap()).unwrap();
    }

    fn regex_configuration(&self, configuration: Value) {
        let mut case: Value =
            serde_json::from_slice(include_bytes!("../../../examples/basic/graded.json")).unwrap();
        case["checks"][0]["configuration"] = configuration;
        fs::write(
            self.root.join("case.json"),
            serde_json::to_vec(&case).unwrap(),
        )
        .unwrap();
    }

    fn invoke(&self) -> Output {
        self.invoke_trials("1", "1")
    }

    fn invoke_trials(&self, trials: &str, threshold: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_sevro"))
            .current_dir(&self.root)
            .env_remove("SEVRO_TEST_SCENARIO")
            .env_remove("SEVRO_TEST_MUTATE_EXTENSION_SOURCE")
            .args([
                "run",
                "--json",
                "--case-file",
                "case.json",
                "--adapter-module",
            ])
            .arg(&self.adapter)
            .arg("--project-root")
            .arg(&self.root)
            .arg("--results-root")
            .arg(self.root.join("results"))
            .arg("--runner-build-digest")
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64))
            .args(["--trials", trials, "--threshold", threshold, "--jobs", "1"])
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn assert_assessed_result(
    output: &Output,
    exit_code: i32,
    grading: &str,
    task: &str,
    expected_check: Value,
) -> Value {
    assert_eq!(
        output.status.code(),
        Some(exit_code),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["exitCode"], exit_code);
    let case = &result["cases"][0];
    let trial = &case["trials"][0];
    for assessment in [&result, case, trial] {
        assert_eq!(assessment["execution"], json!({"status":"completed"}));
        assert_eq!(assessment["grading"], json!({"status":grading}));
        assert_eq!(assessment["task"], json!({"verdict":task}));
    }
    assert_eq!(trial["checks"], json!([expected_check]));
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    assert_eq!(evidence["result"], result);
    let retained = read_json(Path::new(trial["artifactPath"].as_str().unwrap()));
    assert_eq!(retained["result"], *trial);
    assert_eq!(retained["evidence"], evidence["trials"][0]);
    evidence
}

fn raw_bytes(evidence: &Value) -> Vec<u8> {
    let path = url::Url::parse(evidence["trials"][0]["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    fs::read(path).unwrap()
}

fn remove_retained_workspace(evidence: &Value) {
    let workspace = workspace_path(&evidence["trials"][0]);
    assert!(workspace.is_dir());
    fs::remove_dir_all(workspace).unwrap();
}

fn workspace_path(trial: &Value) -> &Path {
    let observation = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|observation| observation["id"] == "sevro.observation.workspaces")
        .unwrap();
    Path::new(observation["data"]["candidate"].as_str().unwrap())
}

#[test]
fn standalone_regex_passes_the_shipped_graded_case() {
    let mut fixture = Fixture::new();
    fs::write(
        fixture.root.join("case.json"),
        include_bytes!("../../../examples/basic/graded.json"),
    )
    .unwrap();
    fixture.observation(Some("ready"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({
            "id":"ready","grader":"sevro.regex","status":"passed","detail":"ok",
            "evidenceRefs":["sevro.observation.final-message"]
        }),
    );
    let result = &evidence["result"];
    assert_eq!(result["cases"][0]["caseId"], "basic-graded");
    assert_eq!(
        evidence["graders"],
        json!({"active":[{"id":"sevro.regex","source":"builtin","version":"1.0.0"}],"replacedDefaults":[]})
    );
    assert_eq!(raw_bytes(&evidence), b"ready");
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6"
    );
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    assert!(!workspace_path(&evidence["trials"][0]).exists());
}

#[test]
fn standalone_regex_mismatch_fails_the_shipped_graded_case() {
    let mut fixture = Fixture::new();
    fs::write(
        fixture.root.join("case.json"),
        include_bytes!("../../../examples/basic/graded.json"),
    )
    .unwrap();
    fixture.observation(Some("not ready"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"ready","grader":"sevro.regex","status":"failed","detail":"regex assertion failed","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"not ready");
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "6b76aeb099be120560b5e3a57bc32053310954bcc34459f762ad43977ba25691"
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn standalone_regex_negation_passes_when_the_pattern_is_absent() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"secret","negate":true}));
    fixture.observation(Some("ready"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"ready","grader":"sevro.regex","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"ready");
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6"
    );
}

#[test]
fn standalone_regex_negation_fails_when_the_pattern_matches() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"secret","negate":true}));
    fixture.observation(Some("a secret"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"ready","grader":"sevro.regex","status":"failed","detail":"regex assertion failed","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), "a secret".as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "984ca5162200734c592148f1820b71057f098573d138666b48663e4e30cd8d3a"
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn standalone_regex_always_matches_in_multiline_mode() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"^ready$"}));
    fixture.observation(Some("before\nready\nafter"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"ready","grader":"sevro.regex","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), "before\nready\nafter".as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "4bdd9eb8c8d58538fa61d266fcf770945585553b2bc1215f6ee1bd54c146cfca"
    );
}

#[test]
fn standalone_regex_rejects_invalid_syntax_before_execution() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"(?i)ready"}));
    fixture.observation(Some("ready"), true);
    fs::write(&fixture.adapter, "import {writeFile} from 'node:fs/promises'; export default {id:'sevro.host.synthetic',model:'synthetic-v1',effort:'none',async run(){await writeFile(new URL('./candidate-called',import.meta.url),'called');return {finalMessage:'ready',complete:true};}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,
            "execution":{"status":"not_run"},"grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"},"exitCode":64,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.invocation.invalid","message":"invalid regex pattern or flags"}
        })
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("sevro: invalid regex pattern or flags")
    );
    assert!(!fixture.root.join("candidate-called").exists());
    assert!(!fixture.root.join("results").exists());
}

#[test]
fn standalone_regex_rejects_unknown_configuration_before_execution() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"ready","unknown":true}));
    fixture.observation(Some("ready"), true);
    fs::write(&fixture.adapter, "import {writeFile} from 'node:fs/promises'; export default {id:'sevro.host.synthetic',model:'synthetic-v1',effort:'none',async run(){await writeFile(new URL('./candidate-called',import.meta.url),'called');return {finalMessage:'ready',complete:true};}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,
            "execution":{"status":"not_run"},"grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"},"exitCode":64,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.invocation.invalid","message":"unsupported check configuration: unknown"}
        })
    );
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("sevro: unsupported check configuration: unknown")
    );
    assert!(!fixture.root.join("candidate-called").exists());
    assert!(!fixture.root.join("results").exists());
}

#[test]
fn standalone_regex_requires_a_string_pattern_before_execution() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":42}));
    fixture.observation(Some("ready"), true);
    fs::write(&fixture.adapter, "import {writeFile} from 'node:fs/promises'; export default {id:'sevro.host.synthetic',model:'synthetic-v1',effort:'none',async run(){await writeFile(new URL('./candidate-called',import.meta.url),'called');return {finalMessage:'ready',complete:true};}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,
            "execution":{"status":"not_run"},"grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"},"exitCode":64,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.invocation.invalid","message":"invalid regex check configuration"}
        })
    );
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("sevro: invalid regex check configuration")
    );
    assert!(!fixture.root.join("candidate-called").exists());
    assert!(!fixture.root.join("results").exists());
}

#[test]
fn standalone_regex_requires_boolean_negation_before_execution() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"ready","negate":"yes"}));
    fixture.observation(Some("ready"), true);
    fs::write(&fixture.adapter, "import {writeFile} from 'node:fs/promises'; export default {id:'sevro.host.synthetic',model:'synthetic-v1',effort:'none',async run(){await writeFile(new URL('./candidate-called',import.meta.url),'called');return {finalMessage:'ready',complete:true};}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,
            "execution":{"status":"not_run"},"grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"},"exitCode":64,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.invocation.invalid","message":"invalid regex check configuration"}
        })
    );
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("sevro: invalid regex check configuration")
    );
    assert!(!fixture.root.join("candidate-called").exists());
    assert!(!fixture.root.join("results").exists());
}

#[test]
fn standalone_regex_requires_string_flags_before_execution() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"ready","flags":42}));
    fixture.observation(Some("ready"), true);
    fs::write(&fixture.adapter, "import {writeFile} from 'node:fs/promises'; export default {id:'sevro.host.synthetic',model:'synthetic-v1',effort:'none',async run(){await writeFile(new URL('./candidate-called',import.meta.url),'called');return {finalMessage:'ready',complete:true};}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,
            "execution":{"status":"not_run"},"grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"},"exitCode":64,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.invocation.invalid","message":"invalid regex pattern or flags"}
        })
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("sevro: invalid regex pattern or flags")
    );
    assert!(!fixture.root.join("candidate-called").exists());
    assert!(!fixture.root.join("results").exists());
}

#[test]
fn standalone_regex_rejects_a_duplicate_mandatory_multiline_flag() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"ready","flags":"m"}));
    fixture.observation(Some("ready"), true);
    fs::write(&fixture.adapter, "import {writeFile} from 'node:fs/promises'; export default {id:'sevro.host.synthetic',model:'synthetic-v1',effort:'none',async run(){await writeFile(new URL('./candidate-called',import.meta.url),'called');return {finalMessage:'ready',complete:true};}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,
            "execution":{"status":"not_run"},"grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"},"exitCode":64,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.invocation.invalid","message":"invalid regex pattern or flags"}
        })
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("sevro: invalid regex pattern or flags")
    );
    assert!(!fixture.root.join("candidate-called").exists());
    assert!(!fixture.root.join("results").exists());
}

#[test]
fn standalone_regex_rejects_unknown_flags_before_execution() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"ready","flags":"q"}));
    fixture.observation(Some("ready"), true);
    fs::write(&fixture.adapter, "import {writeFile} from 'node:fs/promises'; export default {id:'sevro.host.synthetic',model:'synthetic-v1',effort:'none',async run(){await writeFile(new URL('./candidate-called',import.meta.url),'called');return {finalMessage:'ready',complete:true};}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,
            "execution":{"status":"not_run"},"grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"},"exitCode":64,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.invocation.invalid","message":"invalid regex pattern or flags"}
        })
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("sevro: invalid regex pattern or flags")
    );
    assert!(!fixture.root.join("candidate-called").exists());
    assert!(!fixture.root.join("results").exists());
}

#[test]
fn standalone_regex_rejects_conflicting_unicode_flags_before_execution() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"ready","flags":"uv"}));
    fixture.observation(Some("ready"), true);
    fs::write(&fixture.adapter, "import {writeFile} from 'node:fs/promises'; export default {id:'sevro.host.synthetic',model:'synthetic-v1',effort:'none',async run(){await writeFile(new URL('./candidate-called',import.meta.url),'called');return {finalMessage:'ready',complete:true};}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,
            "execution":{"status":"not_run"},"grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"},"exitCode":64,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.invocation.invalid","message":"invalid regex pattern or flags"}
        })
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("sevro: invalid regex pattern or flags")
    );
    assert!(!fixture.root.join("candidate-called").exists());
    assert!(!fixture.root.join("results").exists());
}

#[test]
fn standalone_regex_global_matching_resets_for_each_trial() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"ready","flags":"g"}));
    fixture.observation(Some("ready"), true);
    let expected_check = json!({"id":"ready","grader":"sevro.regex","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]});
    let evidence = assert_assessed_result(
        &fixture.invoke_trials("3", "1"),
        0,
        "completed",
        "passed",
        expected_check.clone(),
    );
    let trials = evidence["result"]["cases"][0]["trials"].as_array().unwrap();
    assert_eq!(trials.len(), 3);
    for (index, trial) in trials.iter().enumerate() {
        assert_eq!(trial["trial"], index + 1);
        assert_eq!(trial["execution"], json!({"status":"completed"}));
        assert_eq!(trial["grading"], json!({"status":"completed"}));
        assert_eq!(trial["task"], json!({"verdict":"passed"}));
        assert_eq!(trial["checks"], json!([expected_check]));
        let retained = &evidence["trials"][index];
        assert_eq!(
            retained["rawResult"]["sha256"],
            "b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6"
        );
        let raw_path = url::Url::parse(retained["rawResult"]["path"].as_str().unwrap())
            .unwrap()
            .to_file_path()
            .unwrap();
        assert_eq!(fs::read(raw_path).unwrap(), b"ready");
        assert_eq!(
            read_json(Path::new(trial["artifactPath"].as_str().unwrap()))["result"],
            *trial
        );
    }
}

#[test]
fn standalone_regex_sticky_matching_accepts_the_start() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"ready","flags":"y"}));
    fixture.observation(Some("ready later"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"ready","grader":"sevro.regex","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), "ready later".as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "4b9df8916aaf536798caf8e3f825d8fa9f628eef5500a6f1428c99a16fc764d5"
    );
}

#[test]
fn standalone_regex_sticky_matching_rejects_a_later_match() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"ready","flags":"y"}));
    fixture.observation(Some("later ready"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"ready","grader":"sevro.regex","status":"failed","detail":"regex assertion failed","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), "later ready".as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "47a607b25f3e584bcf9e64b3b1370dca39c80d260c5b4cca0207506f0506a6c4"
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn standalone_regex_without_unicode_uses_utf16_code_units() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"^.$"}));
    fixture.observation(Some("😀"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"ready","grader":"sevro.regex","status":"failed","detail":"regex assertion failed","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), "😀".as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9"
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn standalone_regex_unicode_combines_a_surrogate_pair() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"^.$","flags":"u"}));
    fixture.observation(Some("😀"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"ready","grader":"sevro.regex","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), "😀".as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9"
    );
}

#[test]
fn standalone_regex_supports_lookarounds_and_backreferences() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":r"(?<=start:)(ready)\1(?=:end)"}));
    fixture.observation(Some("start:readyready:end"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"ready","grader":"sevro.regex","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), "start:readyready:end".as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "19569777d9f32ce730fd7fa3560da76ac1172006c3e03715b6926a2ec6648986"
    );
}

#[test]
fn standalone_regex_unicode_sets_accepts_the_intersection() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":r"^[\p{ASCII}&&\p{Letter}]+$","flags":"v"}));
    fixture.observation(Some("ready"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"ready","grader":"sevro.regex","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), "ready".as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6"
    );
}

#[test]
fn standalone_regex_unicode_sets_rejects_values_outside_the_intersection() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":r"^[\p{ASCII}&&\p{Letter}]+$","flags":"v"}));
    fixture.observation(Some("123"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"ready","grader":"sevro.regex","status":"failed","detail":"regex assertion failed","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), "123".as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3"
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn standalone_regex_supports_indices_case_insensitive_and_dot_all_flags() {
    let mut fixture = Fixture::new();
    fixture.regex_configuration(json!({"pattern":"^READY.$","flags":"dis"}));
    fixture.observation(Some("ready\n"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"ready","grader":"sevro.regex","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), "ready\n".as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "ed1a545bb85e55816bbf9566b028b2a0bc456b88f49f6f266c0401048824194b"
    );
}

#[test]
fn exact_output_passes_complete_adapter_turn() {
    let fixture = Fixture::new();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["format"], "sevro.cli-result.v1");
    assert_eq!(result["exitCode"], 0);
    assert_eq!(result["cases"].as_array().unwrap().len(), 1);
    let case = &result["cases"][0];
    assert_eq!(case["caseId"], "output-exact");
    assert_eq!(case["trials"].as_array().unwrap().len(), 1);
    let trial = &case["trials"][0];
    for assessment in [&result, case, trial] {
        assert_eq!(assessment["execution"], json!({"status":"completed"}));
        assert_eq!(assessment["grading"], json!({"status":"completed"}));
        assert_eq!(assessment["task"], json!({"verdict":"passed"}));
    }
    assert_eq!(
        trial["checks"],
        json!([{
            "id":"exact", "grader":"sevro.output", "status":"passed", "detail":"ok",
            "evidenceRefs":["sevro.observation.final-message"]
        }])
    );
    assert_eq!(trial["domainOutcomes"], json!([]));
    let evidence_path = Path::new(result["evidencePath"].as_str().unwrap());
    let evidence = read_json(evidence_path);
    assert_eq!(evidence["format"], "sevro.run-evidence.v1");
    assert_eq!(evidence["result"], result);
    assert_eq!(
        evidence["graders"],
        json!({"active":[{"id":"sevro.output","source":"builtin","version":"1.0.0"}],"replacedDefaults":[]})
    );
    let retained = &evidence["trials"][0];
    assert_eq!(retained["executionMode"], "executed");
    assert_eq!(retained["observationCompleteness"], "complete");
    assert_eq!(retained["metrics"], json!([]));
    assert_eq!(retained["domainOutcomes"], json!([]));
    assert_eq!(
        retained["rawResult"]["sha256"],
        "b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6"
    );
    let raw_path = url::Url::parse(retained["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(raw_path).unwrap(), b"ready");
    let trial_evidence = read_json(Path::new(trial["artifactPath"].as_str().unwrap()));
    assert_eq!(trial_evidence["format"], "sevro.trial-evidence.v1");
    assert_eq!(trial_evidence["result"], *trial);
    assert_eq!(trial_evidence["evidence"], *retained);
    assert_eq!(
        read_json(&evidence_path.parent().unwrap().join("result.json")),
        result
    );
    assert_eq!(read_json(&fixture.root.join("results/latest.json")), result);
}

#[test]
fn json_path_does_not_select_an_inherited_constructor() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/constructor"}));
    fixture.observation(Some(r#"{}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON pointer does not resolve","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), r#"{}"#.as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn json_path_does_not_select_an_array_length() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/items/length"}));
    fixture.observation(Some(r#"{"items":["ready"]}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON pointer does not resolve","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), r#"{"items":["ready"]}"#.as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "509e6cb0605e567b10a09debf82a901b42da417a2ea95e6bce8ae656fcbdca63"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn json_path_selects_an_explicit_constructor_member() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/constructor"}));
    fixture.observation(Some(r#"{"constructor":"ready"}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        r#"{"constructor":"ready"}"#.as_bytes()
    );
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "85d3422f92d58bdc83a9b4f8bb9f1facb8e84c9bb7543fa2cd1960295631b8bf"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    assert!(!workspace_path(&evidence["trials"][0]).exists());
}

#[test]
fn json_path_selects_an_explicit_length_member() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/length"}));
    fixture.observation(Some(r#"{"length":1}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), r#"{"length":1}"#.as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "36145fc388e953077ff72f2ad8e7716f23129ba3bc8d535250dcd0580a4dcd42"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    assert!(!workspace_path(&evidence["trials"][0]).exists());
}

#[test]
fn json_path_selects_a_member_despite_unrelated_duplicate_names() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status"}));
    fixture.observation(Some(r#"{"ignored":1,"ignored":2,"status":"ready"}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        r#"{"ignored":1,"ignored":2,"status":"ready"}"#.as_bytes()
    );
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "bd837f4c30587a91291cb204f8666c96d95a9af0bb7c660063612a7fb20dad5c"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    assert!(!workspace_path(&evidence["trials"][0]).exists());
}

#[test]
fn json_expectation_passes_a_selected_string() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status","expectJson":"ready"}));
    fixture.observation(Some(r#"{"status":"ready"}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), br#"{"status":"ready"}"#);
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "31bf75f4c0a97cc1f7b60df824fa390b3be9ba014f29b63c87c698ba63d9a9fd"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
}

#[test]
fn json_expectation_rejects_a_different_string() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status","expectJson":"ready"}));
    fixture.observation(Some(r#"{"status":"wait"}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON value did not equal expectation","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), r#"{"status":"wait"}"#.as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "4cabe840edc4d80b08a2aa1284201449c961949e09ba62058e760ec69ac2d6fb"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn json_expectation_requires_a_pointer_before_execution() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"expectJson":"ready"}));
    fixture.observation(Some("ready"), true);
    fs::write(&fixture.adapter, "import {writeFile} from 'node:fs/promises'; export default {id:'sevro.host.synthetic',model:'synthetic-v1',effort:'none',async run(){await writeFile(new URL('./candidate-called',import.meta.url),'called');return {finalMessage:'ready',complete:true};}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,
            "execution":{"status":"not_run"},"grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"},"exitCode":64,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.invocation.invalid","message":"JSON expectations require a pointer"}
        })
    );
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("sevro: JSON expectations require a pointer")
    );
    assert!(!fixture.root.join("candidate-called").exists());
    assert!(!fixture.root.join("results").exists());
}

#[test]
fn json_expectation_compares_numeric_values_instead_of_number_spelling() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/value","expectJson":1}));
    fixture.observation(Some(r#"{"value":1.0}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), r#"{"value":1.0}"#.as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "3a7d647740ec6f86b72e0bf3948ab456551e07e9605e3a2785de1c66842ebb48"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    assert!(!workspace_path(&evidence["trials"][0]).exists());
}

#[test]
fn json_expectation_distinguishes_negative_zero() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status","expectJson":0}));
    fixture.observation(Some(r#"{"status":-0}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON value did not equal expectation","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), r#"{"status":-0}"#.as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "8843c39be6373d03e238611a7194f0433fbcee2ec9d42bd2d06c7b898d7cc888"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn json_expectation_does_not_replace_a_lone_surrogate() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status","expectJson":"�"}));
    fixture.observation(Some(r#"{"status":"\ud800"}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON value did not equal expectation","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), r#"{"status":"\ud800"}"#.as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "42ec3f4916b006d0f43c0ed7ac223d8ef43d155e274c1dbc332e6bbd51bd545c"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn json_expectation_treats_large_exponents_as_equality_mismatches() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/value","expectJson":1}));
    fixture.observation(Some(r#"{"value":1e400}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON value did not equal expectation","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), r#"{"value":1e400}"#.as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "c3481b4e0f5fa4a1c11f5d5f510a0a0da26a5b1bca5894159a6ce18f2c99331c"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn json_expectation_compares_ordered_arrays_of_json_values() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/items","expectJson":[false,null,1,"ready"]}));
    fixture.observation(Some(r#"{"items":[false,null,1.0,"ready"]}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        r#"{"items":[false,null,1.0,"ready"]}"#.as_bytes()
    );
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "a4e896eee083a499e8c5e929619eb909399a6b3373023f95c93e97d2014dfd96"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    assert!(!workspace_path(&evidence["trials"][0]).exists());
}

#[test]
fn json_expectation_preserves_array_order_and_element_types() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/items","expectJson":[false,null,1,"ready"]}));
    fixture.observation(Some(r#"{"items":[false,null,"ready",1]}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON value did not equal expectation","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        r#"{"items":[false,null,"ready",1]}"#.as_bytes()
    );
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "683ccc67ef888daf8cd0d257605c76ed56356026fa8244b9fbdb7f5bb0e0901d"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn json_expectation_compares_objects_without_property_order() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(
        json!({"jsonPath":"/item","expectJson":{"name":"ready","tags":[true,null,1]}}),
    );
    fixture.observation(
        Some(r#"{"item":{"tags":[true,null,1.0],"name":"ready"}}"#),
        true,
    );
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        r#"{"item":{"tags":[true,null,1.0],"name":"ready"}}"#.as_bytes()
    );
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "3ada0798b867d49b93dc44075c48968a756422280c8d8c3ab00c415b553488b3"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    assert!(!workspace_path(&evidence["trials"][0]).exists());
}

#[test]
fn json_expectation_rejects_extra_object_properties() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(
        json!({"jsonPath":"/item","expectJson":{"name":"ready","tags":[true,null,1]}}),
    );
    fixture.observation(
        Some(r#"{"item":{"tags":[true,null,1.0],"name":"ready","extra":1}}"#),
        true,
    );
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON value did not equal expectation","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        r#"{"item":{"tags":[true,null,1.0],"name":"ready","extra":1}}"#.as_bytes()
    );
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "497d7ca4b538f3c5fdd2564b16cf66ff0aa17d1c6a7a18e99a3c6060197278a8"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn json_expectation_distinguishes_explicit_null_from_no_expectation() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"","expectJson":null}));
    fixture.observation(Some("false"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON value did not equal expectation","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), "false".as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "fcbcf165908dd18a9e49f7ff27810176db8e9f63b4352213741664245224f8aa"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn json_expectation_compares_parsed_object_values_after_unique_selection() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/item","expectJson":{"status":"ready"}}));
    fixture.observation(Some(r#"{"item":{"status":"wait","status":"ready"}}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        r#"{"item":{"status":"wait","status":"ready"}}"#.as_bytes()
    );
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "4ac3156889141546bcb4b853311ab8f3f95b7f4ad1891513948eebb8ea042a96"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    assert!(!workspace_path(&evidence["trials"][0]).exists());
}

#[test]
fn json_expectation_selects_through_130_raw_array_levels() {
    let mut fixture = Fixture::new();
    let message = format!("{}\"ready\"{}", "[".repeat(130), "]".repeat(130));
    fixture.output_configuration(json!({"jsonPath":"/0".repeat(130),"expectJson":"ready"}));
    fixture.observation(Some(&message), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), message.as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "3f94e651b1f6f7d3be34f22e0d179770bd02bbbe333083f968bbbd077388b7b3"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    assert!(!workspace_path(&evidence["trials"][0]).exists());
}

#[test]
fn json_expectation_failure_precedes_exact_output_failure() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status","expectJson":"ready","expectExact":r#"{"status":"different"}"#}));
    fixture.observation(Some(r#"{"status":"wait"}"#), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON value did not equal expectation","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), r#"{"status":"wait"}"#.as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "4cabe840edc4d80b08a2aa1284201449c961949e09ba62058e760ec69ac2d6fb"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn json_expectation_keeps_matching_partial_output_unavailable() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status","expectJson":"ready"}));
    fixture.observation(Some(r#"{"status":"ready"}"#), false);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        4,
        "unavailable",
        "not_assessed",
        json!({"id":"json","grader":"sevro.output","status":"unavailable","detail":"output observation unavailable","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), r#"{"status":"ready"}"#.as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "31bf75f4c0a97cc1f7b60df824fa390b3be9ba014f29b63c87c698ba63d9a9fd"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    assert_eq!(evidence["trials"][0]["observationCompleteness"], "partial");
    remove_retained_workspace(&evidence);
}

#[test]
fn json_path_selects_a_present_field() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status"}));
    fixture.observation(Some("{\"status\":\"ready\"}"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({
            "id":"json","grader":"sevro.output","status":"passed","detail":"ok",
            "evidenceRefs":["sevro.observation.final-message"]
        }),
    );
    assert_eq!(raw_bytes(&evidence), b"{\"status\":\"ready\"}");
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "31bf75f4c0a97cc1f7b60df824fa390b3be9ba014f29b63c87c698ba63d9a9fd"
    );
    let result = &evidence["result"];
    let run_path = Path::new(result["evidencePath"].as_str().unwrap());
    assert_eq!(
        read_json(&run_path.parent().unwrap().join("result.json")),
        *result
    );
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
}

#[test]
fn json_path_missing_field_fails_with_retained_observation() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status"}));
    fixture.observation(Some("{}"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON pointer does not resolve","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), "{}".as_bytes());
    remove_retained_workspace(&evidence);
}

#[test]
fn json_path_cannot_traverse_a_scalar() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status/detail"}));
    fixture.observation(Some("{\"status\":\"ready\"}"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON pointer does not resolve","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"{\"status\":\"ready\"}");
    remove_retained_workspace(&evidence);
}

#[test]
fn json_path_empty_pointer_selects_a_null_root() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":""}));
    fixture.observation(Some("null"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"null");
}

#[test]
fn json_path_decodes_escaped_member_tokens() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/a~1b/~0key"}));
    fixture.observation(Some("{\"a/b\":{\"~key\":false}}"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"{\"a/b\":{\"~key\":false}}");
}

#[test]
fn json_path_selects_an_array_element() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/items/0"}));
    fixture.observation(Some("{\"items\":[\"ready\"]}"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"{\"items\":[\"ready\"]}");
}

#[test]
fn json_path_rejects_a_leading_zero_array_index() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/items/00"}));
    fixture.observation(Some("{\"items\":[\"ready\"]}"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON pointer does not resolve","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"{\"items\":[\"ready\"]}");
    remove_retained_workspace(&evidence);
}

#[test]
fn json_path_rejects_a_duplicate_selected_member() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/item/status"}));
    fixture.observation(
        Some("{\"item\":null,\"item\":{\"status\":\"ready\"}}"),
        true,
    );
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON pointer does not resolve","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        b"{\"item\":null,\"item\":{\"status\":\"ready\"}}"
    );
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "305e830ea90520e685fed3498c35185bdc0eaf798bb7e292a9c85259f9a18d55"
    );
    let result = &evidence["result"];
    let run_directory = Path::new(result["evidencePath"].as_str().unwrap())
        .parent()
        .unwrap();
    assert_eq!(read_json(&run_directory.join("result.json")), *result);
    assert_eq!(
        read_json(&fixture.root.join("results/latest.json")),
        *result
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn json_path_rejects_an_ambiguous_member_before_child_selection() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/item/status"}));
    fixture.observation(
        Some("{\"item\":{\"status\":\"ready\"},\"item\":null}"),
        true,
    );
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON pointer does not resolve","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        b"{\"item\":{\"status\":\"ready\"},\"item\":null}"
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn json_path_selects_a_child_of_a_later_array_element() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/items/1/status"}));
    fixture.observation(Some("{\"items\":[null,{\"status\":\"ready\"}]}"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        b"{\"items\":[null,{\"status\":\"ready\"}]}"
    );
}

#[test]
fn json_path_invalid_json_fails_before_selection() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status"}));
    fixture.observation(Some("ready"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"output is not valid JSON","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"ready");
    remove_retained_workspace(&evidence);
}

#[test]
fn json_path_selects_from_one_json_fence_with_surrounding_prose() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status"}));
    fixture.observation(Some("before\n```json\n{\"status\":\"ready\"}\n```"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        b"before\n```json\n{\"status\":\"ready\"}\n```"
    );
}

#[test]
fn json_path_missing_output_remains_unavailable() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status"}));
    fixture.observation(None, true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        4,
        "unavailable",
        "not_assessed",
        json!({"id":"json","grader":"sevro.output","status":"unavailable","detail":"output observation unavailable","evidenceRefs":[]}),
    );
    assert!(evidence["trials"][0]["rawResult"]["path"].is_null());
    assert!(evidence["trials"][0]["rawResult"]["sha256"].is_null());
    remove_retained_workspace(&evidence);
}

#[test]
fn json_path_partial_output_cannot_pass_selection() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status"}));
    fixture.observation(Some("{\"status\":\"ready\"}"), false);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        4,
        "unavailable",
        "not_assessed",
        json!({"id":"json","grader":"sevro.output","status":"unavailable","detail":"output observation unavailable","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"{\"status\":\"ready\"}");
    assert_eq!(evidence["trials"][0]["observationCompleteness"], "partial");
    remove_retained_workspace(&evidence);
}

#[test]
fn valid_json_failure_precedes_json_path_selection() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true,"jsonPath":"/status"}));
    fixture.observation(Some("before\n```json\n{}\n```"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"output is not exactly one JSON document","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"before\n```json\n{}\n```");
    remove_retained_workspace(&evidence);
}

#[test]
fn json_path_failure_precedes_exact_text_failure() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status","expectExact":"different"}));
    fixture.observation(Some("{}"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"JSON pointer does not resolve","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"{}");
    remove_retained_workspace(&evidence);
}

#[test]
fn exact_text_still_applies_after_json_path_selection() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status","expectExact":"different"}));
    fixture.observation(Some("{\"status\":\"ready\"}"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"exact output did not match","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"{\"status\":\"ready\"}");
    remove_retained_workspace(&evidence);
}

#[test]
fn json_path_rejects_invalid_escaping_before_candidate_execution() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/bad~2key"}));
    fixture.observation(Some("{\"status\":\"ready\"}"), true);
    fs::write(&fixture.adapter, "import {writeFile} from 'node:fs/promises'; export default {id:'sevro.host.synthetic',model:'synthetic-v1',effort:'none',async run(){await writeFile(new URL('./candidate-called',import.meta.url),'called');return {finalMessage:'ready',complete:true};}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(output.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"not_run"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    assert_eq!(result["evidencePath"], Value::Null);
    assert_eq!(result["cases"], json!([]));
    assert_eq!(
        result["diagnostic"],
        json!({"code":"sevro.invocation.invalid","message":"invalid JSON pointer"})
    );
    assert!(!fixture.root.join("candidate-called").exists());
    assert!(!fixture.root.join("results").exists());
}

#[test]
fn json_path_requires_a_string_before_candidate_execution() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":1}));
    fixture.observation(Some("{\"status\":\"ready\"}"), true);
    fs::write(&fixture.adapter, "import {writeFile} from 'node:fs/promises'; export default {id:'sevro.host.synthetic',model:'synthetic-v1',effort:'none',async run(){await writeFile(new URL('./candidate-called',import.meta.url),'called');return {finalMessage:'ready',complete:true};}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(output.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"not_run"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    assert_eq!(result["evidencePath"], Value::Null);
    assert_eq!(result["cases"], json!([]));
    assert_eq!(
        result["diagnostic"],
        json!({"code":"sevro.invocation.invalid","message":"JSON pointer must be a string"})
    );
    assert!(!fixture.root.join("candidate-called").exists());
    assert!(!fixture.root.join("results").exists());
}

#[test]
fn json_path_selects_a_number_beyond_finite_float_range() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status"}));
    fixture.observation(Some("{\"status\":1e400}"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"{\"status\":1e400}");
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "10d4e6ec7c018074e5ac2935ea480400f74ac26cf16fe366ea4adf0ca598b352"
    );
}

#[test]
fn json_path_selects_an_escaped_unpaired_surrogate() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status"}));
    fixture.observation(Some("{\"status\":\"\\ud800\"}"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), "{\"status\":\"\\ud800\"}".as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "42ec3f4916b006d0f43c0ed7ac223d8ef43d155e274c1dbc332e6bbd51bd545c"
    );
}

#[test]
fn json_path_traverses_130_levels_without_value_deserialization() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/0".repeat(130)}));
    fixture.observation(
        Some(&format!("{}0{}", "[".repeat(130), "]".repeat(130))),
        true,
    );
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        format!("{}0{}", "[".repeat(130), "]".repeat(130)).as_bytes()
    );
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "b04d255ad45ae4606adc932e61ce9b02559ba5c5e5aa6695f6e9f8f68b22121e"
    );
}

#[test]
fn json_path_skips_nonmatching_members_before_the_selected_member() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"jsonPath":"/status"}));
    fixture.observation(
        Some("{\"ignored\":{\"status\":null},\"status\":\"ready\"}"),
        true,
    );
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        "{\"ignored\":{\"status\":null},\"status\":\"ready\"}".as_bytes()
    );
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "411b55ab7460815d0bc94d1245b08adac2126ca656bacdf1b1ae29f0d8cf6e9a"
    );
}

#[test]
fn valid_json_output_rejects_malformed_json_inside_one_fence() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    fixture.observation(Some("```json\n{broken\n```"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"output is not valid JSON","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), "```json\n{broken\n```".as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "29cd345984e21821259c322142a9e6fc3004954e829e0f85fbba19e70d166614"
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn valid_json_output_rejects_a_jsonc_language_tag() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    fixture.observation(Some("```jsonc\n{\"status\":\"ready\"}\n```"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"output is not valid JSON","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        "```jsonc\n{\"status\":\"ready\"}\n```".as_bytes()
    );
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "bc5815934f0e720bb6d9120b39ea0841a97adfb6b3d812924c11f1fb02795831"
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn valid_json_output_accepts_a_mixed_case_json_language_tag() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    fixture.observation(Some("```JsOn\t\n{\"status\":\"ready\"}\n```"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        "```JsOn\t\n{\"status\":\"ready\"}\n```".as_bytes()
    );
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "0407bb9cfe67392671d0fe3cce87f4f3035358ad2ac02dfb496b2d8695ce00ff"
    );
}

#[test]
fn valid_json_output_does_not_trim_next_line_characters() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    fixture.observation(
        Some("\u{85}```json\n{\"status\":\"ready\"}\n```\u{85}"),
        true,
    );
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed","detail":"output is not exactly one JSON document","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        "\u{85}```json\n{\"status\":\"ready\"}\n```\u{85}".as_bytes()
    );
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "ebc9aa94116a62868db0abf71eb20e13ce66dcdbe75dd1508ca9de9475e79f0f"
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn valid_json_output_trims_line_and_paragraph_separators() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    fixture.observation(
        Some("\u{2028}```json\n{\"status\":\"ready\"}\n```\u{2029}"),
        true,
    );
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(
        raw_bytes(&evidence),
        "\u{2028}```json\n{\"status\":\"ready\"}\n```\u{2029}".as_bytes()
    );
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "21510796f8115c4365803b7c61f0633c658e034513112d36e0f935e7c7ded7a8"
    );
}

#[test]
fn valid_json_output_passes_a_complete_document() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    fixture.observation(Some(" {\"ok\":true}\n"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({
            "id":"json","grader":"sevro.output","status":"passed","detail":"ok",
            "evidenceRefs":["sevro.observation.final-message"]
        }),
    );
    assert_eq!(raw_bytes(&evidence), b" {\"ok\":true}\n");
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "d8768ba6f4ad4ee9bfcbceb0e0fa89b81ba0fffb4b6ecd3cad6675a7495455a1"
    );
    assert_eq!(evidence["trials"][0]["observationCompleteness"], "complete");
    assert_eq!(
        evidence["graders"],
        json!({"active":[{"id":"sevro.output","source":"builtin","version":"1.0.0"}],"replacedDefaults":[]})
    );
    assert!(!workspace_path(&evidence["trials"][0]).exists());
}

#[test]
fn valid_json_output_fails_invalid_json_with_an_assessed_task() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    fixture.observation(Some("ready"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({
            "id":"json","grader":"sevro.output","status":"failed",
            "detail":"output is not valid JSON",
            "evidenceRefs":["sevro.observation.final-message"]
        }),
    );
    assert_eq!(raw_bytes(&evidence), b"ready");
    remove_retained_workspace(&evidence);
}

#[test]
fn valid_json_output_accepts_one_complete_json_fence() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    fixture.observation(Some("```json\n{\"ok\":true}\n```"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({
            "id":"json","grader":"sevro.output","status":"passed","detail":"ok",
            "evidenceRefs":["sevro.observation.final-message"]
        }),
    );
    assert_eq!(raw_bytes(&evidence), b"```json\n{\"ok\":true}\n```");
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "3091fc821793b0828702bf02ec208c266ee3b777fbe625f880e75356242ba075"
    );
    assert!(!workspace_path(&evidence["trials"][0]).exists());
}

#[test]
fn valid_json_output_distinguishes_prose_around_a_valid_fence() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    fixture.observation(Some("before\n```json\n{\"ok\":true}\n```"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({
            "id":"json","grader":"sevro.output","status":"failed",
            "detail":"output is not exactly one JSON document",
            "evidenceRefs":["sevro.observation.final-message"]
        }),
    );
    assert_eq!(raw_bytes(&evidence), b"before\n```json\n{\"ok\":true}\n```");
    remove_retained_workspace(&evidence);
}

#[test]
fn valid_json_output_rejects_multiple_json_fences() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    let message = "```json\n{}\n```\n```json\n{}\n```";
    fixture.observation(Some(message), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed",
            "detail":"output is not valid JSON","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), message.as_bytes());
    remove_retained_workspace(&evidence);
}

#[test]
fn valid_json_output_rejects_multiple_raw_documents() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    fixture.observation(Some("{} []"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed",
            "detail":"output is not valid JSON","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"{} []");
    remove_retained_workspace(&evidence);
}

#[test]
fn valid_json_output_accepts_supported_fence_case_spacing_and_line_endings() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    let message = "\u{feff}\u{a0}```JSON \t\r\n{\"ok\":true}\r\n```\u{a0}\u{feff}";
    fixture.observation(Some(message), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok",
            "evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), message.as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "50cca2badcdc11be12404081ba9762102755ca59d2da88bff8f0eb0c605187e6"
    );
}

#[test]
fn valid_json_output_keeps_missing_observations_unavailable() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    fixture.observation(None, true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        4,
        "unavailable",
        "not_assessed",
        json!({"id":"json","grader":"sevro.output","status":"unavailable",
            "detail":"output observation unavailable","evidenceRefs":[]}),
    );
    assert_eq!(
        evidence["trials"][0]["observationCompleteness"],
        "unavailable"
    );
    assert_eq!(evidence["trials"][0]["rawResult"]["path"], Value::Null);
    assert_eq!(evidence["trials"][0]["rawResult"]["sha256"], Value::Null);
    remove_retained_workspace(&evidence);
}

#[test]
fn valid_json_output_keeps_incomplete_valid_json_unavailable() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    fixture.observation(Some("{\"ok\":true}"), false);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        4,
        "unavailable",
        "not_assessed",
        json!({"id":"json","grader":"sevro.output","status":"unavailable",
            "detail":"output observation unavailable","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(evidence["trials"][0]["observationCompleteness"], "partial");
    assert_eq!(raw_bytes(&evidence), b"{\"ok\":true}");
    remove_retained_workspace(&evidence);
}

#[test]
fn valid_json_false_disables_the_json_assertion() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":false}));
    fixture.observation(Some("ready"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok",
            "evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"ready");
}

#[test]
fn valid_json_failure_precedes_a_simultaneous_exact_text_failure() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true,"expectExact":"different"}));
    fixture.observation(Some("ready"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed",
            "detail":"output is not valid JSON","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"ready");
    remove_retained_workspace(&evidence);
}

#[test]
fn exact_text_still_applies_after_json_validity_passes() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true,"expectExact":"{\"ok\":false}"}));
    fixture.observation(Some("{\"ok\":true}"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({"id":"json","grader":"sevro.output","status":"failed",
            "detail":"exact output did not match","evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"{\"ok\":true}");
    remove_retained_workspace(&evidence);
}

#[test]
fn valid_json_output_accepts_a_number_beyond_finite_float_range() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    fixture.observation(Some("1e400"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok",
            "evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"1e400");
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "f2bba4568fecd4b9729970732e571ac9373a33fb2d6a960794a41f0f2ecdbc25"
    );
}

#[test]
fn valid_json_output_accepts_an_escaped_unpaired_surrogate() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    fixture.observation(Some("\"\\ud800\""), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok",
            "evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), b"\"\\ud800\"");
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "8c0c59dd0d275aadcd462a5fe12eb352cbdfeaf961eae4f85a4660521df7d2f5"
    );
}

#[test]
fn valid_json_output_accepts_130_levels_of_nesting() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":true}));
    let message = format!("{}0{}", "[".repeat(130), "]".repeat(130));
    fixture.observation(Some(&message), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        0,
        "completed",
        "passed",
        json!({"id":"json","grader":"sevro.output","status":"passed","detail":"ok",
            "evidenceRefs":["sevro.observation.final-message"]}),
    );
    assert_eq!(raw_bytes(&evidence), message.as_bytes());
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "b04d255ad45ae4606adc932e61ce9b02559ba5c5e5aa6695f6e9f8f68b22121e"
    );
}

#[test]
fn valid_json_configuration_requires_a_boolean_before_candidate_execution() {
    let mut fixture = Fixture::new();
    fixture.output_configuration(json!({"validJson":"yes"}));
    fixture.observation(Some("ready"), true);
    fs::write(&fixture.adapter,
        "import {writeFile} from 'node:fs/promises'; export default {id:'sevro.host.synthetic',model:'synthetic-v1',effort:'none',async run(){await writeFile(new URL('./candidate-called',import.meta.url),'called');return {finalMessage:'ready',complete:true};}};\n").unwrap();
    let output = fixture.invoke();
    assert_eq!(output.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"not_run"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    assert_eq!(result["evidencePath"], Value::Null);
    assert_eq!(result["cases"], json!([]));
    assert_eq!(
        result["diagnostic"],
        json!({"code":"sevro.invocation.invalid","message":"validJson must be a boolean"})
    );
    assert!(!fixture.root.join("candidate-called").exists());
    assert!(!fixture.root.join("results").exists());
}

#[test]
fn exact_output_mismatch_fails_with_retained_observation() {
    let mut fixture = Fixture::new();
    fixture.observation(Some("wait"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({
            "id":"exact","grader":"sevro.output","status":"failed",
            "detail":"exact output did not match",
            "evidenceRefs":["sevro.observation.final-message"]
        }),
    );
    assert_eq!(raw_bytes(&evidence), b"wait");
    assert_eq!(evidence["trials"][0]["observationCompleteness"], "complete");
    remove_retained_workspace(&evidence);
}

#[test]
fn exact_output_does_not_trim_the_observed_message() {
    let mut fixture = Fixture::new();
    fixture.observation(Some("ready\n"), true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        1,
        "completed",
        "failed",
        json!({
            "id":"exact","grader":"sevro.output","status":"failed",
            "detail":"exact output did not match",
            "evidenceRefs":["sevro.observation.final-message"]
        }),
    );
    assert_eq!(raw_bytes(&evidence), b"ready\n");
    assert_eq!(
        evidence["trials"][0]["rawResult"]["sha256"],
        "ed1a545bb85e55816bbf9566b028b2a0bc456b88f49f6f266c0401048824194b"
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn missing_output_is_unavailable_without_a_fabricated_evidence_reference() {
    let mut fixture = Fixture::new();
    fixture.observation(None, true);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        4,
        "unavailable",
        "not_assessed",
        json!({
            "id":"exact","grader":"sevro.output","status":"unavailable",
            "detail":"output observation unavailable","evidenceRefs":[]
        }),
    );
    let retained = &evidence["trials"][0];
    assert_eq!(retained["observationCompleteness"], "unavailable");
    assert_eq!(
        retained["rawResult"],
        json!({"source":"sevro.host.synthetic","path":null,"sha256":null})
    );
    assert_eq!(
        retained["observations"][0],
        json!({
            "id":"sevro.observation.final-message","source":"sevro.host.synthetic",
            "completeness":"unavailable","data":{}
        })
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn incomplete_matching_output_is_unavailable_and_retains_partial_bytes() {
    let mut fixture = Fixture::new();
    fixture.observation(Some("ready"), false);
    let evidence = assert_assessed_result(
        &fixture.invoke(),
        4,
        "unavailable",
        "not_assessed",
        json!({
            "id":"exact","grader":"sevro.output","status":"unavailable",
            "detail":"output observation unavailable",
            "evidenceRefs":["sevro.observation.final-message"]
        }),
    );
    let retained = &evidence["trials"][0];
    assert_eq!(retained["observationCompleteness"], "partial");
    assert_eq!(raw_bytes(&evidence), b"ready");
    assert_eq!(
        retained["observations"][0],
        json!({
            "id":"sevro.observation.final-message","source":"sevro.host.synthetic",
            "completeness":"partial",
            "data":{"sha256":"b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6","byteLength":5}
        })
    );
    remove_retained_workspace(&evidence);
}

#[test]
fn completed_trial_outcomes_are_aggregated_at_the_requested_threshold() {
    for (threshold, exit_code, verdict) in [("0.5", 0, "passed"), ("0.75", 1, "failed")] {
        let mut fixture = Fixture::new();
        fixture.adapter = fixture.root.join("sequence.ts");
        fs::write(
            &fixture.adapter,
            "let index = 0; const messages = ['ready','no','ready']; export default { id:'sevro.host.synthetic', model:'synthetic-v1', effort:'none', async run() { return { finalMessage:messages[index++], complete:true, inputTokens:null, outputTokens:null, costUsd:null, usageComplete:false }; } };\n",
        )
        .unwrap();
        let output = fixture.invoke_trials("3", threshold);
        assert_eq!(
            output.status.code(),
            Some(exit_code),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["exitCode"], exit_code);
        let case = &result["cases"][0];
        for assessment in [&result, case] {
            assert_eq!(assessment["execution"], json!({"status":"completed"}));
            assert_eq!(assessment["grading"], json!({"status":"completed"}));
            assert_eq!(assessment["task"], json!({"verdict":verdict}));
        }
        let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
        assert_eq!(evidence["result"], result);
        let summaries = case["trials"].as_array().unwrap();
        let retained = evidence["trials"].as_array().unwrap();
        assert_eq!(summaries.len(), 3);
        assert_eq!(retained.len(), 3);
        for (index, (message, status, detail)) in [
            ("ready", "passed", "ok"),
            ("no", "failed", "exact output did not match"),
            ("ready", "passed", "ok"),
        ]
        .into_iter()
        .enumerate()
        {
            let trial = &summaries[index];
            let receipt = &retained[index];
            assert_eq!(trial["trial"], index + 1);
            assert_eq!(trial["execution"], json!({"status":"completed"}));
            assert_eq!(trial["grading"], json!({"status":"completed"}));
            assert_eq!(trial["task"], json!({"verdict":status}));
            assert_eq!(
                trial["checks"],
                json!([{
                    "id":"exact","grader":"sevro.output","status":status,"detail":detail,
                    "evidenceRefs":["sevro.observation.final-message"]
                }])
            );
            let raw_path = url::Url::parse(receipt["rawResult"]["path"].as_str().unwrap())
                .unwrap()
                .to_file_path()
                .unwrap();
            assert_eq!(fs::read(raw_path).unwrap(), message.as_bytes());
            let trial_file = read_json(Path::new(trial["artifactPath"].as_str().unwrap()));
            assert_eq!(trial_file["result"], *trial);
            assert_eq!(trial_file["evidence"], *receipt);
            let workspace = workspace_path(receipt);
            if status == "failed" {
                assert!(workspace.is_dir());
                fs::remove_dir_all(workspace).unwrap();
            } else {
                assert!(!workspace.exists());
            }
        }
    }
}
