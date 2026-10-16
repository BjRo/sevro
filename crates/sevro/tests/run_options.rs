use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct Project(PathBuf);

impl Project {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "sevro-rust-options-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir(root.join("settings")).unwrap();
        fs::create_dir(root.join("elsewhere")).unwrap();
        write_json(
            &root.join("case.json"),
            &json!({
                "id":"saved-run", "prompt":"Return ready.",
                "fixture":{"files":{"README.md":"fixture\n"}},
                "checks":[{"id":"ready","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
                "requiredEvidence":[]
            }),
        );
        fs::write(root.join("auth.json"), "private-auth-sentinel").unwrap();
        Self(root)
    }

    fn save(&self, extra: Value) -> PathBuf {
        let mut settings = json!({
            "case-file":"../case.json", "project-root":"..", "host":"codex",
            "codex-bin":"/bin/true", "codex-auth-file":"../auth.json",
            "model":"candidate-model", "effort":"low", "dry":true,
            "runner-build-digest":"a".repeat(64), "project-digest":"b".repeat(64)
        });
        settings
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let manifest = self.0.join("settings/evaluation.json");
        write_json(
            &manifest,
            &json!({"format":"sevro.run.v1","settings":settings}),
        );
        manifest
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_sevro"))
            .args(["run", "--json"])
            .args(args)
            .current_dir(self.0.join("elsewhere"))
            .env("SEVRO_TEST_SCENARIO", "pass")
            .env_remove("SEVRO_TEST_MUTATE_EXTENSION_SOURCE")
            .output()
            .unwrap()
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_json(path: &Path, value: &Value) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

fn retained(output: &Output) -> Value {
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .lines()
            .count(),
        1
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"]["status"], "not_run");
    assert_eq!(result["grading"]["status"], "not_requested");
    assert_eq!(result["task"]["verdict"], "not_assessed");
    serde_json::from_slice(&fs::read(result["evidencePath"].as_str().unwrap()).unwrap()).unwrap()
}

#[test]
fn saved_manifest_supplies_native_dry_settings_and_retains_its_selection() {
    let project = Project::new();
    let runner_digest = "0123456789abcdef".repeat(4);
    let project_digest = "fedcba9876543210".repeat(4);
    let manifest = project.save(json!({
        "condition":"enforced", "jobs":1, "threshold":0.5, "results-root":"../saved-results",
        "runner-build-digest":runner_digest, "project-digest":project_digest
    }));
    let output = project.run(&["--run-manifest-file", "../settings/evaluation.json"]);
    let evidence = retained(&output);
    let resolved = &evidence["configuration"]["resolved"];
    assert_eq!(resolved["runManifestFile"], manifest.to_str().unwrap());
    assert_eq!(
        resolved["caseFile"],
        project.0.join("case.json").to_str().unwrap()
    );
    assert_eq!(resolved["projectRoot"], project.0.to_str().unwrap());
    assert_eq!(
        resolved["resultsRoot"],
        project.0.join("saved-results").to_str().unwrap()
    );
    assert_eq!(resolved["condition"], "enforced");
    assert_eq!(resolved["trials"], 1);
    assert_eq!(resolved["jobs"], 1);
    assert_eq!(resolved["threshold"], 0.5);
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["runnerBuildDigest"],
        runner_digest
    );
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["projectDigest"],
        project_digest
    );
    assert_eq!(
        evidence["result"]["cases"][0]["trials"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(!resolved.to_string().contains("auth.json"));
    assert!(!evidence.to_string().contains("private-auth-sentinel"));
    assert!(String::from_utf8_lossy(&output.stderr).contains("sevro: effective settings "));
}

#[test]
fn explicit_cli_settings_replace_saved_values_and_relative_output_paths() {
    let project = Project::new();
    project.save(json!({"trials":2,"jobs":1,"threshold":0.5,"results-root":"../saved-results"}));
    let arguments = ["--run-manifest-file", "../settings/evaluation.json"];
    let saved = retained(&project.run(&arguments));
    assert_eq!(
        saved["result"]["cases"][0]["trials"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let repeated = retained(&project.run(&arguments));
    assert_eq!(
        repeated["evaluationIdentity"]["digest"],
        saved["evaluationIdentity"]["digest"]
    );
    let changed = retained(&project.run(&[
        "--run-manifest-file",
        "../settings/evaluation.json",
        "--trials",
        "1",
        "--jobs",
        "3",
        "--threshold",
        "1",
        "--results-root",
        "./cli-results",
    ]));
    let resolved = &changed["configuration"]["resolved"];
    assert_eq!(resolved["trials"], 1);
    assert_eq!(resolved["jobs"], 3);
    assert_eq!(resolved["threshold"], 1);
    assert_eq!(
        resolved["resultsRoot"],
        project.0.join("elsewhere/cli-results").to_str().unwrap()
    );
    assert_eq!(
        changed["result"]["cases"][0]["trials"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_ne!(
        changed["evaluationIdentity"]["digest"],
        saved["evaluationIdentity"]["digest"]
    );
    let relocated = retained(&project.run(&[
        "--run-manifest-file",
        "../settings/evaluation.json",
        "--results-root",
        "./relocated-results",
    ]));
    assert_eq!(
        relocated["evaluationIdentity"]["digest"],
        saved["evaluationIdentity"]["digest"]
    );
}

#[test]
fn invalid_manifest_fields_return_one_unassessed_result_before_storage() {
    for (document, field) in [
        (json!(null), "$"),
        (json!([]), "$"),
        (json!({"format":"sevro.run.v2","settings":{}}), "format"),
        (json!({"format":"sevro.run.v1"}), "settings"),
        (json!({"format":"sevro.run.v1","settings":[],}), "settings"),
        (
            json!({"format":"sevro.run.v1","settings":{},"typo":1}),
            "typo",
        ),
        (
            json!({"format":"sevro.run.v1","settings":{"trials":"2"}}),
            "settings.trials",
        ),
        (
            json!({"format":"sevro.run.v1","settings":{"dry":"yes"}}),
            "settings.dry",
        ),
        (
            json!({"format":"sevro.run.v1","settings":{"host":42}}),
            "settings.host",
        ),
        (
            json!({"format":"sevro.run.v1","settings":{"model":" "}}),
            "settings.model",
        ),
        (
            json!({"format":"sevro.run.v1","settings":{"extension-source-file":[""]}}),
            "settings.extension-source-file",
        ),
        (
            json!({"format":"sevro.run.v1","settings":{"json":true}}),
            "settings.json",
        ),
        (
            json!({"format":"sevro.run.v1","settings":{"run-manifest-file":"nested.json"}}),
            "settings.run-manifest-file",
        ),
        (
            json!({"format":"sevro.run.v1","settings":{"typo":true}}),
            "settings.typo",
        ),
    ] {
        let project = Project::new();
        let file = project.0.join("settings/invalid.json");
        write_json(&file, &document);
        let output = project.run(&["--run-manifest-file", file.to_str().unwrap()]);
        assert_eq!(output.status.code(), Some(64), "field: {field}");
        assert_eq!(
            String::from_utf8_lossy(&output.stdout)
                .trim()
                .lines()
                .count(),
            1
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["execution"]["status"], "not_run");
        assert_eq!(result["grading"]["status"], "not_requested");
        assert_eq!(result["task"]["verdict"], "not_assessed");
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(field), "{stderr}");
        assert!(stderr.contains(file.to_str().unwrap()), "{stderr}");
        assert!(!project.0.join(".sevro").exists());
        assert!(!project.0.join("elsewhere/.sevro").exists());
    }
}

#[test]
fn cli_case_file_replaces_the_saved_extension_selection() {
    let project = Project::new();
    let manifest = project.save(json!({
        "extension-command-file":"../not-selected-command.json",
        "extension-source-file":["../not-selected-source.ts"], "case-id":"saved-extension"
    }));
    let mut document: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    document["settings"]
        .as_object_mut()
        .unwrap()
        .remove("case-file");
    write_json(&manifest, &document);
    let evidence = retained(&project.run(&[
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--case-file",
        "../case.json",
    ]));
    let resolved = &evidence["configuration"]["resolved"];
    assert_eq!(
        resolved["caseFile"],
        project.0.join("case.json").to_str().unwrap()
    );
    assert_eq!(resolved["caseId"], "saved-run");
    assert_eq!(resolved["extensionCommandFile"], Value::Null);
    assert_eq!(resolved["extensionSourceFileCount"], 0);
}

#[test]
fn unreadable_or_unsafe_manifests_preserve_actionable_json_failure() {
    for kind in ["missing", "syntax", "oversize", "symlink", "directory"] {
        let project = Project::new();
        let file = project.0.join("settings/unusable.json");
        match kind {
            "syntax" => fs::write(&file, "{ private-invalid-json-marker").unwrap(),
            "oversize" => fs::write(&file, " ".repeat(65537)).unwrap(),
            "symlink" => std::os::unix::fs::symlink(project.0.join("case.json"), &file).unwrap(),
            "directory" => fs::create_dir(&file).unwrap(),
            _ => {}
        }
        let output = project.run(&["--run-manifest-file", file.to_str().unwrap()]);
        assert_eq!(output.status.code(), Some(64), "kind: {kind}");
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["task"]["verdict"], "not_assessed");
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("--run-manifest-file"), "{stderr}");
        assert!(stderr.contains(file.to_str().unwrap()), "{stderr}");
        assert!(!stderr.contains("private-invalid-json-marker"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private-invalid-json-marker"));
        assert!(!project.0.join(".sevro").exists());
    }
}

#[test]
fn manifest_directory_alias_resolves_paths_from_its_canonical_target() {
    let project = Project::new();
    let manifest = project.save(json!({}));
    fs::create_dir(project.0.join("elsewhere/nested")).unwrap();
    std::os::unix::fs::symlink(
        project.0.join("settings"),
        project.0.join("elsewhere/nested/alias"),
    )
    .unwrap();
    let evidence = retained(&project.run(&["--run-manifest-file", "nested/alias/evaluation.json"]));
    let resolved = &evidence["configuration"]["resolved"];
    assert_eq!(resolved["runManifestFile"], manifest.to_str().unwrap());
    assert_eq!(resolved["projectRoot"], project.0.to_str().unwrap());
    assert_eq!(
        resolved["caseFile"],
        project.0.join("case.json").to_str().unwrap()
    );
}

#[test]
fn empty_scalar_and_manifest_values_preserve_validation_diagnostics() {
    for (arguments, message) in [
        (
            vec!["--model", ""],
            "missing --model; supply --model with a value",
        ),
        (
            vec!["--model="],
            "missing --model; supply --model with a value",
        ),
        (
            vec!["--effort", ""],
            "missing --effort; supply --effort with a value",
        ),
        (
            vec!["--effort="],
            "missing --effort; supply --effort with a value",
        ),
        (
            vec!["--condition", ""],
            "missing --condition; supply --condition with a value",
        ),
        (
            vec!["--condition="],
            "missing --condition; supply --condition with a value",
        ),
        (
            vec!["--trials", ""],
            "missing --trials; supply --trials with a value",
        ),
        (
            vec!["--trials="],
            "missing --trials; supply --trials with a value",
        ),
        (
            vec!["--jobs", ""],
            "missing --jobs; supply --jobs with a value",
        ),
        (
            vec!["--jobs="],
            "missing --jobs; supply --jobs with a value",
        ),
        (
            vec!["--threshold", ""],
            "missing --threshold; supply --threshold with a value",
        ),
        (
            vec!["--threshold="],
            "missing --threshold; supply --threshold with a value",
        ),
        (
            vec!["--run-manifest-file", ""],
            "missing --run-manifest-file; supply --run-manifest-file with a value",
        ),
        (
            vec!["--run-manifest-file="],
            "missing --run-manifest-file; supply --run-manifest-file with a value",
        ),
        (vec!["--host", ""], "missing --adapter-module or --host"),
        (vec!["--host="], "missing --adapter-module or --host"),
        (
            vec!["--runner-build-digest", ""],
            "--runner-build-digest must be a 64-character SHA-256 digest",
        ),
        (
            vec!["--runner-build-digest="],
            "--runner-build-digest must be a 64-character SHA-256 digest",
        ),
        (
            vec!["--project-digest", ""],
            "--project-digest must be a 64-character SHA-256 digest",
        ),
        (
            vec!["--project-digest="],
            "--project-digest must be a 64-character SHA-256 digest",
        ),
        (
            vec!["--codex-timeout-ms", ""],
            "invalid Codex host configuration",
        ),
        (
            vec!["--codex-timeout-ms="],
            "invalid Codex host configuration",
        ),
    ] {
        let project = Project::new();
        let manifest = project.save(json!({}));
        let mut args = vec!["--run-manifest-file", manifest.to_str().unwrap()];
        args.extend(arguments);
        let output = project.run(&args);
        assert_eq!(output.status.code(), Some(64));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            result,
            json!({
                "format":"sevro.cli-result.v1", "runId":null,
                "execution":{"status":"not_run"}, "grading":{"status":"not_requested"},
                "task":{"verdict":"not_assessed"}, "exitCode":64,
                "evidencePath":null, "cases":[],
                "diagnostic":{"code":"sevro.invocation.invalid","message":message}
            })
        );
        assert!(!project.0.join(".sevro").exists());
        assert!(!project.0.join("elsewhere/.sevro").exists());
    }
}

#[test]
fn unreadable_codex_configuration_paths_fail_before_admission() {
    use std::os::unix::fs::PermissionsExt;
    for kind in ["unsearchable-directory", "file-collision"] {
        let project = Project::new();
        let manifest = project.save(json!({}));
        let configuration = project.0.join(".codex");
        if kind == "unsearchable-directory" {
            fs::create_dir(&configuration).unwrap();
            fs::set_permissions(&configuration, fs::Permissions::from_mode(0o0)).unwrap();
        } else {
            fs::write(&configuration, "not a directory\n").unwrap();
        }
        let output = project.run(&["--run-manifest-file", manifest.to_str().unwrap()]);
        if kind == "unsearchable-directory" {
            fs::set_permissions(&configuration, fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(output.status.code(), Some(64));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            result,
            json!({
                "format":"sevro.cli-result.v1", "runId":null,
                "execution":{"status":"not_run"}, "grading":{"status":"not_requested"},
                "task":{"verdict":"not_assessed"}, "exitCode":64,
                "evidencePath":null, "cases":[],
                "diagnostic":{"code":"sevro.invocation.invalid","message":format!(
                    "Cannot read Codex configuration: {}", configuration.join("config.toml").display()
                )}
            })
        );
        assert!(!project.0.join(".sevro").exists());
    }
}

#[test]
fn malformed_cli_arguments_keep_configuration_failure_diagnostics() {
    for (args, diagnostic) in [
        (vec!["--unknown-sevro-option"], "invalid CLI arguments"),
        (vec!["--results-root"], "invalid CLI arguments"),
        (vec!["--case-file", "--dry"], "invalid CLI arguments"),
        (vec!["--dry=true"], "invalid CLI arguments"),
        (vec!["--no-model"], "invalid CLI arguments"),
        (vec!["--no-dry=false"], "invalid CLI arguments"),
        (vec!["--results-root", "--"], "invalid CLI arguments"),
        (vec!["extra-command"], "expected the run command"),
    ] {
        let project = Project::new();
        let output = project.run(&args);
        assert_eq!(output.status.code(), Some(64));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        assert_eq!(result["task"]["verdict"], "not_assessed");
        assert!(
            result["diagnostic"]["message"]
                .as_str()
                .unwrap()
                .contains(diagnostic),
            "{result}"
        );
        assert!(!project.0.join("elsewhere/.sevro").exists());
    }
}

#[test]
fn bare_option_terminator_preserves_the_selected_run() {
    let project = Project::new();
    let manifest = project.save(json!({}));
    let evidence =
        retained(&project.run(&["--run-manifest-file", manifest.to_str().unwrap(), "--"]));
    assert_eq!(evidence["configuration"]["resolved"]["caseId"], "saved-run");
    let refused = project.run(&[
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--",
        "extra-command",
    ]);
    assert_eq!(refused.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&refused.stdout).unwrap();
    assert_eq!(result["evidencePath"], Value::Null);
    assert!(
        result["diagnostic"]["message"]
            .as_str()
            .unwrap()
            .contains("expected the run command")
    );
}

#[test]
fn cli_adapter_replaces_saved_native_settings_and_negative_dry_executes() {
    let project = Project::new();
    let manifest = project.save(json!({}));
    let case_file = project.0.join("case.json");
    let mut case: Value = serde_json::from_slice(&fs::read(&case_file).unwrap()).unwrap();
    case["checks"] = json!([]);
    write_json(&case_file, &case);
    let adapter = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/host-adapter.ts")
        .canonicalize()
        .unwrap();
    let output = project.run(&[
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--adapter-module",
        adapter.to_str().unwrap(),
        "--no-dry",
    ]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"]["status"], "completed");
    assert_eq!(result["grading"]["status"], "not_requested");
    assert_eq!(result["task"]["verdict"], "not_assessed");
    let evidence: Value =
        serde_json::from_slice(&fs::read(result["evidencePath"].as_str().unwrap()).unwrap())
            .unwrap();
    let resolved = &evidence["configuration"]["resolved"];
    assert_eq!(resolved["dry"], false);
    assert_eq!(resolved["adapterModule"], adapter.to_str().unwrap());
    assert_eq!(
        resolved["candidate"],
        json!({
            "host":"sevro.host.synthetic", "model":"synthetic-v1", "effort":"none",
            "executable":null,"timeoutMs":null
        })
    );
    assert_eq!(resolved["codexEntrypoint"], Value::Null);
    assert!(!evidence.to_string().contains("private-auth-sentinel"));
}

#[test]
fn cli_native_host_replaces_a_saved_adapter_without_hiding_explicit_conflicts() {
    let project = Project::new();
    let manifest = project.save(json!({"adapter-module":"../not-selected-adapter.ts"}));
    let mut document: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    for name in ["host", "model", "effort", "codex-bin", "codex-auth-file"] {
        document["settings"].as_object_mut().unwrap().remove(name);
    }
    write_json(&manifest, &document);
    let args = [
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--host",
        "codex",
        "--codex-bin",
        "/bin/true",
        "--codex-auth-file",
        "../auth.json",
        "--model",
        "explicit-model",
        "--effort",
        "low",
    ];
    let evidence = retained(&project.run(&args));
    assert_eq!(
        evidence["configuration"]["resolved"]["adapterModule"],
        Value::Null
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["candidate"]["host"],
        "sevro.host.codex"
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["candidate"]["model"],
        "explicit-model"
    );
    let mut conflicting = args.to_vec();
    conflicting.extend(["--adapter-module", "../not-selected-adapter.ts"]);
    let output = project.run(&conflicting);
    assert_eq!(output.status.code(), Some(64));
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("--host and --adapter-module are exclusive")
    );
}

#[test]
fn saved_empty_extension_source_list_selects_no_entries_for_a_case_file() {
    let project = Project::new();
    let manifest = project.save(json!({"extension-source-file":[]}));
    let evidence = retained(&project.run(&["--run-manifest-file", manifest.to_str().unwrap()]));
    assert_eq!(
        evidence["configuration"]["resolved"]["extensionSourceFileCount"],
        0
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["extensionCommandFile"],
        Value::Null
    );
}

#[test]
fn failed_manifest_loading_honors_the_last_explicit_json_selection() {
    for (flags, json) in [
        (["--json", "--no-json"], false),
        (["--no-json", "--json"], true),
    ] {
        let project = Project::new();
        let output = project.run(&[flags[0], flags[1], "--run-manifest-file", "missing.json"]);
        assert_eq!(output.status.code(), Some(64));
        if json {
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result["task"]["verdict"], "not_assessed");
            assert_eq!(result["evidencePath"], Value::Null);
        } else {
            assert!(
                String::from_utf8_lossy(&output.stdout)
                    .starts_with("execution=not_run grading=not_requested task=not_assessed\n")
            );
        }
        assert!(!project.0.join("elsewhere/.sevro").exists());
    }
}

#[test]
fn invalid_aggregation_settings_are_refused_before_storage() {
    for (option, value) in [
        ("condition", "other"),
        ("trials", "0"),
        ("trials", "-1"),
        ("trials", "1.5"),
        ("trials", "NaN"),
        ("trials", "9007199254740992"),
        ("jobs", "0"),
        ("jobs", "not-a-number"),
        ("threshold", "0"),
        ("threshold", "1.01"),
        ("threshold", "NaN"),
        ("threshold", "Infinity"),
        ("threshold", "invalid"),
    ] {
        let project = Project::new();
        let manifest = project.save(json!({}));
        let flag = format!("--{option}");
        let output = project.run(&[
            "--run-manifest-file",
            manifest.to_str().unwrap(),
            &flag,
            value,
        ]);
        assert_eq!(output.status.code(), Some(64));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        assert!(
            result["diagnostic"]["message"]
                .as_str()
                .unwrap()
                .contains(&format!("invalid {flag}")),
            "{result}"
        );
        assert!(!project.0.join(".sevro").exists());
    }
}

#[test]
fn a_missing_results_directory_is_resolved_through_its_symlink() {
    let project = Project::new();
    let manifest = project.save(json!({}));
    let alias = project.0.join("elsewhere/results-alias");
    std::os::unix::fs::symlink("future-results", &alias).unwrap();
    let output = project.run(&[
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--results-root",
        "./results-alias",
    ]);
    let evidence = retained(&output);
    let target = project.0.join("elsewhere/future-results");
    assert_eq!(
        evidence["configuration"]["resolved"]["resultsRoot"],
        target.to_str().unwrap()
    );
    assert!(Path::new(evidence["result"]["evidencePath"].as_str().unwrap()).starts_with(&target));
    assert!(fs::symlink_metadata(&alias).unwrap().is_symlink());
    assert!(target.join("latest.json").is_file());
}

#[test]
fn explicit_runtime_configuration_replaces_default_and_binds_real_policy_identity() {
    let project = Project::new();
    let manifest = project.save(json!({}));
    let arguments = ["--run-manifest-file", manifest.to_str().unwrap()];
    let absent = retained(&project.run(&arguments));
    assert!(
        absent["configuration"]["redacted"]
            .get("runtimePolicy")
            .is_none()
    );
    let runtime = project.0.join("runtime.json");
    write_json(&runtime, &json!({"format":"sevro.runtime.v1"}));
    fs::write(project.0.join("sevro.json"), "malformed unselected default").unwrap();
    let selected = retained(&project.run(&[
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--runtime-config-file",
        "../runtime.json",
    ]));
    assert_eq!(
        selected["configuration"]["resolved"]["runtimeConfigFile"],
        runtime.to_str().unwrap()
    );
    assert_eq!(
        selected["configuration"]["redacted"]["runtimePolicy"],
        json!({
            "format":"sevro.runtime.v1", "environment":{}, "readOnlyRoots":[],
            "discovery":[], "skippedOptionalReadOnlyRoots":[], "seeds":[],
            "hooks":{"nativeGoal":false,"plugins":[]}
        })
    );
    assert_ne!(
        selected["configuration"]["digest"],
        absent["configuration"]["digest"]
    );
    assert_eq!(
        selected["evaluationIdentity"]["dimensions"]["configurationDigest"],
        selected["configuration"]["digest"]
    );
}

#[test]
fn discovered_and_explicit_runtime_files_share_policy_identity() {
    let project = Project::new();
    let manifest = project.save(json!({}));
    let runtime = project.0.join("sevro.json");
    write_json(&runtime, &json!({"format":"sevro.runtime.v1"}));
    let discovered = retained(&project.run(&["--run-manifest-file", manifest.to_str().unwrap()]));
    assert_eq!(
        discovered["configuration"]["resolved"]["runtimeConfigFile"],
        runtime.to_str().unwrap()
    );
    let explicit = retained(&project.run(&[
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--runtime-config-file",
        "../sevro.json",
    ]));
    assert_eq!(
        explicit["configuration"]["digest"],
        discovered["configuration"]["digest"]
    );
    assert_eq!(
        explicit["evaluationIdentity"]["digest"],
        discovered["evaluationIdentity"]["digest"]
    );
    let unrelated = retained(&project.run(&[
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--project-root",
        ".",
    ]));
    assert_eq!(
        unrelated["configuration"]["resolved"]["runtimeConfigFile"],
        Value::Null
    );
    assert!(
        unrelated["configuration"]["redacted"]
            .get("runtimePolicy")
            .is_none()
    );
}

#[test]
fn explicit_runtime_file_aliases_preserve_policy_identity() {
    let project = Project::new();
    let manifest = project.save(json!({}));
    let runtime = project.0.join("runtime.json");
    write_json(&runtime, &json!({"format":"sevro.runtime.v1"}));
    let alias = project.0.join("runtime-link.json");
    std::os::unix::fs::symlink("runtime.json", &alias).unwrap();
    let direct = retained(&project.run(&[
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--runtime-config-file",
        "../runtime.json",
    ]));
    let selected = retained(&project.run(&[
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--runtime-config-file",
        "../runtime-link.json",
    ]));
    assert_eq!(
        selected["configuration"]["resolved"]["runtimeConfigFile"],
        runtime.to_str().unwrap()
    );
    assert_eq!(
        selected["configuration"]["digest"],
        direct["configuration"]["digest"]
    );
    assert_eq!(
        selected["evaluationIdentity"]["digest"],
        direct["evaluationIdentity"]["digest"]
    );
    assert_eq!(
        selected["configuration"]["redacted"]["runtimePolicy"],
        json!({
            "format":"sevro.runtime.v1", "environment":{}, "readOnlyRoots":[],
            "discovery":[], "skippedOptionalReadOnlyRoots":[], "seeds":[],
            "hooks":{"nativeGoal":false,"plugins":[]}
        })
    );
    assert!(fs::symlink_metadata(&alias).unwrap().is_symlink());
}

#[test]
fn runtime_configuration_bounds_decoded_utf8_before_policy_validation() {
    let project = Project::new();
    let manifest = project.save(json!({}));
    let runtime = project.0.join("runtime.json");
    let mut document = br#"{"format":"sevro.runtime.v1","note":""#.to_vec();
    document.extend(vec![0x80; 22_000]);
    document.extend_from_slice(br#""}"#);
    fs::write(&runtime, document).unwrap();
    assert_eq!(fs::metadata(&runtime).unwrap().len(), 22_039);
    let output = project.run(&[
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--runtime-config-file",
        "../runtime.json",
    ]);
    assert_eq!(output.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1", "runId":null,
            "execution":{"status":"not_run"}, "grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"}, "exitCode":64,
            "evidencePath":null, "cases":[],
            "diagnostic":{
                "code":"sevro.invocation.invalid",
                "message":"invalid runtime configuration: runtime configuration exceeds 64 KiB"
            }
        })
    );
    assert!(!String::from_utf8_lossy(&output.stderr).contains('\u{fffd}'));
    assert!(!project.0.join(".sevro").exists());
}

#[test]
fn invalid_runtime_files_fail_before_admission_without_leaking_the_body() {
    for kind in [
        "missing",
        "syntax",
        "oversize",
        "directory",
        "wrong-version",
        "null",
        "array",
        "unknown-field",
        "default-symlink",
    ] {
        let project = Project::new();
        let manifest = project.save(json!({}));
        let runtime = project.0.join("runtime.json");
        match kind {
            "syntax" => fs::write(&runtime, "{ private-runtime-marker").unwrap(),
            "oversize" => fs::write(&runtime, " ".repeat(65537)).unwrap(),
            "directory" => fs::create_dir(&runtime).unwrap(),
            "wrong-version" => write_json(&runtime, &json!({"format":"sevro.runtime.v2"})),
            "null" => write_json(&runtime, &json!(null)),
            "array" => write_json(&runtime, &json!([])),
            "unknown-field" => write_json(
                &runtime,
                &json!({"format":"sevro.runtime.v1","typo":"private-runtime-marker"}),
            ),
            "default-symlink" => {
                write_json(&runtime, &json!({"format":"sevro.runtime.v1"}));
                std::os::unix::fs::symlink(&runtime, project.0.join("sevro.json")).unwrap();
            }
            _ => {}
        }
        let mut args = vec!["--run-manifest-file", manifest.to_str().unwrap()];
        if kind != "default-symlink" {
            args.extend(["--runtime-config-file", runtime.to_str().unwrap()]);
        }
        let output = project.run(&args);
        assert_eq!(output.status.code(), Some(64), "kind: {kind}");
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["execution"]["status"], "not_run");
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("invalid runtime configuration"), "{stderr}");
        assert!(!stderr.contains("private-runtime-marker"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private-runtime-marker"));
        assert!(!project.0.join(".sevro").exists());
    }
}

#[test]
fn selected_codex_binary_uses_path_and_honors_an_explicit_override() {
    use std::os::unix::fs::PermissionsExt;
    let project = Project::new();
    let manifest = project.save(json!({}));
    let mut document: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    document["settings"]
        .as_object_mut()
        .unwrap()
        .remove("codex-bin");
    write_json(&manifest, &document);
    let bin = project.0.join("bin");
    fs::create_dir(&bin).unwrap();
    for name in ["native", "override"] {
        let path = project.0.join(name);
        fs::write(
            &path,
            "#!/bin/sh\nprintf invoked > \"$SEVRO_PATH_MARKER\"\nexit 98\n",
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    std::os::unix::fs::symlink("../native", bin.join("codex")).unwrap();
    let invoke = |extra: &[&str], path: &std::ffi::OsStr| {
        Command::new(env!("CARGO_BIN_EXE_sevro"))
            .args([
                "run",
                "--json",
                "--run-manifest-file",
                manifest.to_str().unwrap(),
            ])
            .args(extra)
            .env("PATH", path)
            .env("SEVRO_PATH_MARKER", project.0.join("native-invocations"))
            .current_dir(project.0.join("elsewhere"))
            .output()
            .unwrap()
    };
    let directory_entry = project.0.join("directory-bin");
    fs::create_dir_all(directory_entry.join("codex")).unwrap();
    let path =
        std::env::join_paths([project.0.join("absent-bin"), directory_entry, bin.clone()]).unwrap();
    let selected = retained(&invoke(&[], &path));
    assert_eq!(
        selected["configuration"]["resolved"]["candidate"]["executable"],
        project.0.join("native").to_str().unwrap()
    );
    let explicit = retained(&invoke(
        &["--codex-bin", "../override"],
        project.0.join("absent-bin").as_os_str(),
    ));
    assert_eq!(
        explicit["configuration"]["resolved"]["candidate"]["executable"],
        project.0.join("override").to_str().unwrap()
    );
    fs::set_permissions(project.0.join("native"), fs::Permissions::from_mode(0o600)).unwrap();
    let missing = invoke(&[], &path);
    assert_eq!(missing.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&missing.stdout).unwrap();
    assert_eq!(result["evidencePath"], Value::Null);
    assert!(String::from_utf8_lossy(&missing.stderr).contains("not found on PATH"));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("--codex-bin"));
    assert!(!project.0.join("native-invocations").exists());
}

#[test]
fn claude_options_name_the_required_host_before_loading_other_routes() {
    use std::os::unix::fs::PermissionsExt;
    for (route, flag, value) in [
        ("adapter", "--claude-bin", "../native"),
        ("adapter", "--claude-credential-file", "../auth.json"),
        ("codex", "--claude-bin", "../native"),
        ("codex", "--claude-credential-file", "../auth.json"),
    ] {
        let project = Project::new();
        fs::write(
            project.0.join("adapter.ts"),
            "import {writeFileSync} from 'node:fs';\nwriteFileSync(new URL('adapter-imported',import.meta.url),'imported');\nexport default {id:'sevro.host.refusal',model:'synthetic',effort:'none',async run(){return {finalMessage:'ready',complete:true}}};\n",
        )
        .unwrap();
        fs::write(
            project.0.join("native"),
            "#!/bin/sh\nprintf called > \"$0.called\"\nexit 97\n",
        )
        .unwrap();
        fs::set_permissions(project.0.join("native"), fs::Permissions::from_mode(0o700)).unwrap();
        let mut arguments = vec![
            "--case-file",
            "../case.json",
            "--project-root",
            "..",
            "--results-root",
            "../results",
        ];
        if route == "adapter" {
            arguments.extend(["--adapter-module", "../adapter.ts"]);
        } else {
            arguments.extend([
                "--host",
                "codex",
                "--codex-bin",
                "../native",
                "--codex-auth-file",
                "../auth.json",
                "--model",
                "synthetic",
                "--effort",
                "low",
            ]);
        }
        arguments.extend([flag, value]);
        let output = project.run(&arguments);
        assert_eq!(output.status.code(), Some(64), "{route}: {flag}");
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert_eq!(stdout.lines().count(), 1);
        let result: Value = serde_json::from_str(&stdout).unwrap();
        assert_eq!(
            result,
            json!({
                "format":"sevro.cli-result.v1", "runId":null,
                "execution":{"status":"not_run"}, "grading":{"status":"not_requested"},
                "task":{"verdict":"not_assessed"}, "exitCode":64, "evidencePath":null,
                "cases":[], "diagnostic":{
                    "code":"sevro.invocation.invalid",
                    "message":"Claude options require --host claude"
                }
            }),
            "{route}: {flag}"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .starts_with("sevro: Claude options require --host claude\n")
        );
        assert!(!project.0.join("adapter-imported").exists());
        assert!(!project.0.join("native.called").exists());
        assert!(!project.0.join("results").exists());
        assert!(!project.0.join(".sevro").exists());
    }
}

#[test]
fn unsupported_host_takes_precedence_over_adapter_selection() {
    for with_adapter in [true, false] {
        let project = Project::new();
        fs::write(
            project.0.join("adapter.ts"),
            "import {writeFileSync} from 'node:fs';\nwriteFileSync(new URL('adapter-imported',import.meta.url),'imported');\nexport default {id:'sevro.host.refusal',model:'synthetic',effort:'none',async run(){return {finalMessage:'ready',complete:true}}};\n",
        )
        .unwrap();
        let mut arguments = vec![
            "--case-file",
            "../case.json",
            "--project-root",
            "..",
            "--results-root",
            "../results",
            "--host",
            "unsupported",
        ];
        if with_adapter {
            arguments.extend(["--adapter-module", "../adapter.ts"]);
        }
        let output = project.run(&arguments);
        assert_eq!(output.status.code(), Some(64));
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert_eq!(stdout.lines().count(), 1);
        let result: Value = serde_json::from_str(&stdout).unwrap();
        assert_eq!(
            result,
            json!({
                "format":"sevro.cli-result.v1", "runId":null,
                "execution":{"status":"not_run"}, "grading":{"status":"not_requested"},
                "task":{"verdict":"not_assessed"}, "exitCode":64, "evidencePath":null,
                "cases":[], "diagnostic":{
                    "code":"sevro.invocation.invalid",
                    "message":"unsupported --host; use codex or claude"
                }
            }),
            "adapter selected: {with_adapter}"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .starts_with("sevro: unsupported --host; use codex or claude\n")
        );
        assert!(!project.0.join("adapter-imported").exists());
        assert!(!project.0.join("results").exists());
        assert!(!project.0.join(".sevro").exists());
    }
}

#[test]
fn incompatible_input_selections_are_refused_before_run_allocation() {
    let invalid_hex = "g".repeat(64);
    for (extra, diagnostic) in [
        (
            vec!["--case-source-root", ".."],
            "case sources require a root and map file",
        ),
        (
            vec!["--case-source-map-file", "../map.json"],
            "case sources require a root and map file",
        ),
        (
            vec!["--project-root", "../case.json"],
            "must be directories",
        ),
        (vec!["--config-root", "../case.json"], "must be directories"),
        (
            vec!["--runner-build-digest", "short"],
            "64-character SHA-256 digest",
        ),
        (
            vec!["--project-digest", invalid_hex.as_str()],
            "64-character SHA-256 digest",
        ),
        (
            vec![
                "--adapter-module",
                "../not-loaded.ts",
                "--model",
                "explicit",
            ],
            "--model and --effort require a built-in host",
        ),
        (
            vec!["--adapter-module", "../not-loaded.ts", "--effort", "low"],
            "--model and --effort require a built-in host",
        ),
        (
            vec![
                "--adapter-module",
                "../not-loaded.ts",
                "--codex-bin",
                "/bin/true",
            ],
            "Codex options require a Codex host route",
        ),
        (
            vec![
                "--adapter-module",
                "../not-loaded.ts",
                "--codex-auth-file",
                "../auth.json",
            ],
            "Codex options require a Codex host route",
        ),
        (
            vec!["--case-id", "unselected-extension"],
            "extension options require --extension-command-file",
        ),
        (
            vec!["--extension-source-file", "../not-loaded.ts"],
            "extension options require --extension-command-file",
        ),
    ] {
        let project = Project::new();
        let manifest = project.save(json!({}));
        let mut args = vec!["--run-manifest-file", manifest.to_str().unwrap()];
        args.extend(extra);
        let output = project.run(&args);
        assert_eq!(output.status.code(), Some(64));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        assert!(
            result["diagnostic"]["message"]
                .as_str()
                .unwrap()
                .contains(diagnostic),
            "{result}"
        );
        assert!(!project.0.join(".sevro").exists());
    }
}

#[test]
fn saved_native_timeout_is_overridden_and_validated_before_admission() {
    let project = Project::new();
    let manifest = project.save(json!({"codex-timeout-ms":120000}));
    let saved = retained(&project.run(&["--run-manifest-file", manifest.to_str().unwrap()]));
    assert_eq!(
        saved["configuration"]["resolved"]["candidate"]["timeoutMs"],
        120000
    );
    assert_eq!(
        saved["configuration"]["redacted"]["runSettings"]["candidateTimeoutMs"],
        120000
    );
    for value in ["1", "1800000"] {
        let changed = retained(&project.run(&[
            "--run-manifest-file",
            manifest.to_str().unwrap(),
            "--codex-timeout-ms",
            value,
        ]));
        assert_eq!(
            changed["configuration"]["resolved"]["candidate"]["timeoutMs"],
            value.parse::<u64>().unwrap()
        );
        assert_ne!(
            changed["configuration"]["digest"],
            saved["configuration"]["digest"]
        );
        assert_eq!(
            changed["evaluationIdentity"]["dimensions"]["routeDigest"],
            saved["evaluationIdentity"]["dimensions"]["routeDigest"]
        );
    }
    let adapter = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/host-adapter.ts")
        .canonicalize()
        .unwrap();
    let replaced = retained(&project.run(&[
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--adapter-module",
        adapter.to_str().unwrap(),
    ]));
    assert_eq!(
        replaced["configuration"]["resolved"]["candidate"]["timeoutMs"],
        Value::Null
    );
    let conflict = project.run(&[
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--adapter-module",
        adapter.to_str().unwrap(),
        "--codex-timeout-ms",
        "120000",
    ]);
    assert_eq!(conflict.status.code(), Some(64));
    assert!(
        String::from_utf8_lossy(&conflict.stderr)
            .contains("Codex options require a Codex host route")
    );
    for value in ["0", "-1", "1.5", "1800001", "NaN", "Infinity"] {
        let project = Project::new();
        let manifest = project.save(json!({}));
        let output = project.run(&[
            "--run-manifest-file",
            manifest.to_str().unwrap(),
            "--codex-timeout-ms",
            value,
        ]);
        assert_eq!(output.status.code(), Some(64), "timeout {value}");
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["evidencePath"], Value::Null);
        assert!(String::from_utf8_lossy(&output.stderr).contains("invalid --codex-timeout-ms"));
        assert!(!project.0.join(".sevro").exists());
    }
    project.save(json!({"codex-timeout-ms":"120000"}));
    let invalid_saved = project.run(&["--run-manifest-file", manifest.to_str().unwrap()]);
    assert_eq!(invalid_saved.status.code(), Some(64));
    assert!(
        String::from_utf8_lossy(&invalid_saved.stderr)
            .contains("settings.codex-timeout-ms: expected a finite number")
    );
}

#[test]
fn unreadable_selected_configuration_is_refused_before_storage() {
    use std::os::unix::fs::PermissionsExt;
    for kind in ["manifest", "runtime"] {
        let project = Project::new();
        let manifest = project.save(json!({}));
        let runtime = project.0.join("runtime.json");
        write_json(&runtime, &json!({"format":"sevro.runtime.v1"}));
        let selected = if kind == "manifest" {
            &manifest
        } else {
            &runtime
        };
        fs::set_permissions(selected, fs::Permissions::from_mode(0o0)).unwrap();
        let mut arguments = vec!["--run-manifest-file", manifest.to_str().unwrap()];
        if kind == "runtime" {
            arguments.extend(["--runtime-config-file", runtime.to_str().unwrap()]);
        }
        let output = project.run(&arguments);
        fs::set_permissions(selected, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            output.status.code(),
            Some(64),
            "{kind}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["execution"]["status"], "not_run");
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        assert!(
            result["diagnostic"]["message"]
                .as_str()
                .unwrap()
                .contains(selected.to_str().unwrap())
        );
        assert!(!project.0.join(".sevro").exists());
    }
}

#[test]
fn empty_extension_source_names_the_missing_input_before_loading_the_command() {
    for source in [
        vec!["--extension-source-file", ""],
        vec!["--extension-source-file="],
        vec![],
    ] {
        let project = Project::new();
        let manifest = project.save(json!({
            "extension-command-file":"../unselected-command.json", "case-id":"selected",
            "extension-source-file":[]
        }));
        let mut document: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        document["settings"]
            .as_object_mut()
            .unwrap()
            .remove("case-file");
        write_json(&manifest, &document);
        let mut arguments = vec!["--run-manifest-file", manifest.to_str().unwrap()];
        arguments.extend(source);
        let output = project.run(&arguments);
        assert_eq!(output.status.code(), Some(64));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            result["diagnostic"]["message"]
                .as_str()
                .unwrap()
                .contains("missing --extension-source-file"),
            "{result}"
        );
        assert_eq!(result["execution"]["status"], "not_run");
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        assert!(!project.0.join(".sevro").exists());
    }
}

#[test]
fn incomplete_input_selections_fail_before_run_allocation() {
    for (kind, diagnostic) in [
        ("host", "missing --adapter-module or --host"),
        ("codex-auth-file", "missing --codex-auth-file"),
        ("model", "missing --model"),
        ("effort", "missing --effort"),
        (
            "case-file",
            "select exactly one of --case-file or --extension-command-file",
        ),
        (
            "both-sources",
            "select exactly one of --case-file or --extension-command-file",
        ),
        ("case-id", "missing --case-id"),
        ("extension-source-file", "missing --extension-source-file"),
        (
            "extension-configuration",
            "extension options require --extension-command-file",
        ),
    ] {
        let project = Project::new();
        let manifest = project.save(json!({}));
        let mut document: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        let settings = document["settings"].as_object_mut().unwrap();
        match kind {
            "host" => {
                for name in ["host", "model", "effort", "codex-bin", "codex-auth-file"] {
                    settings.remove(name);
                }
            }
            "both-sources" => {
                settings.insert(
                    "extension-command-file".into(),
                    "../unselected-command.json".into(),
                );
            }
            "case-id" | "extension-source-file" => {
                settings.remove("case-file");
                settings.insert(
                    "extension-command-file".into(),
                    "../unselected-command.json".into(),
                );
                if kind == "case-id" {
                    settings.insert("extension-source-file".into(), json!(["../case.json"]));
                } else {
                    settings.insert("case-id".into(), "selected".into());
                }
            }
            "extension-configuration" => {
                settings.insert(
                    "extension-configuration-file".into(),
                    "../unselected-private.json".into(),
                );
                settings.insert(
                    "extension-redacted-configuration-file".into(),
                    "../unselected-redacted.json".into(),
                );
            }
            name => {
                settings.remove(name);
            }
        }
        write_json(&manifest, &document);
        let output = project.run(&["--run-manifest-file", manifest.to_str().unwrap()]);
        assert_eq!(output.status.code(), Some(64), "missing {kind}");
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            result["diagnostic"]["message"]
                .as_str()
                .unwrap()
                .contains(diagnostic),
            "{result}"
        );
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        assert!(!project.0.join(".sevro").exists());
    }
}

#[test]
fn filesystem_resolution_failures_do_not_allocate_runs() {
    use std::os::unix::fs::PermissionsExt;
    for kind in ["cyclic-results", "file-parent", "inaccessible-project"] {
        let project = Project::new();
        let manifest = project.save(json!({}));
        let private_project = project.0.join("private-project");
        let mut arguments = vec!["--run-manifest-file", manifest.to_str().unwrap()];
        let selected = match kind {
            "cyclic-results" => {
                let path = project.0.join("cyclic-results");
                std::os::unix::fs::symlink("cyclic-results", &path).unwrap();
                path
            }
            "file-parent" => project.0.join("case.json/results"),
            _ => {
                fs::create_dir(&private_project).unwrap();
                fs::set_permissions(&private_project, fs::Permissions::from_mode(0o0)).unwrap();
                arguments.extend(["--project-root", private_project.to_str().unwrap()]);
                project.0.join("results")
            }
        };
        arguments.extend(["--results-root", selected.to_str().unwrap()]);
        let output = project.run(&arguments);
        if kind == "inaccessible-project" {
            fs::set_permissions(&private_project, fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(
            output.status.code(),
            Some(64),
            "{kind}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        let named_path = if kind == "inaccessible-project" {
            &private_project
        } else {
            &selected
        };
        assert!(
            result["diagnostic"]["message"]
                .as_str()
                .unwrap()
                .contains(named_path.to_str().unwrap()),
            "{result}"
        );
        assert!(!project.0.join(".sevro").exists());
        assert!(!project.0.join("results").exists());
    }
}

#[test]
fn integral_decimal_and_exponent_settings_preserve_numeric_identity() {
    let project = Project::new();
    let manifest = project.save(json!({
        "trials":"TRIALS", "jobs":"JOBS", "threshold":"THRESHOLD", "codex-timeout-ms":"TIMEOUT"
    }));
    let template = fs::read_to_string(&manifest).unwrap();
    let mut original: Option<Value> = None;
    for literals in [
        ["1", "3", "0.5", "600000"],
        ["1.0", "3.0", "0.50", "600000.0"],
        ["1e0", "3e0", "5e-1", "6e5"],
    ] {
        let mut source = template.clone();
        for (name, literal) in ["TRIALS", "JOBS", "THRESHOLD", "TIMEOUT"]
            .iter()
            .zip(literals)
        {
            source = source.replace(&format!("\"{name}\""), literal);
        }
        fs::write(&manifest, source).unwrap();
        let evidence = retained(&project.run(&["--run-manifest-file", manifest.to_str().unwrap()]));
        assert_eq!(evidence["configuration"]["resolved"]["trials"], 1);
        assert_eq!(evidence["configuration"]["resolved"]["jobs"], 3);
        assert_eq!(evidence["configuration"]["resolved"]["threshold"], 0.5);
        assert_eq!(
            evidence["configuration"]["resolved"]["candidate"]["timeoutMs"],
            600000
        );
        if let Some(original) = &original {
            assert_eq!(
                evidence["configuration"]["digest"],
                original["configuration"]["digest"]
            );
            assert_eq!(
                evidence["evaluationIdentity"]["digest"],
                original["evaluationIdentity"]["digest"]
            );
        } else {
            original = Some(evidence);
        }
    }
    let explicit = retained(&project.run(&[
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--trials",
        "1.0",
        "--jobs",
        "3e0",
        "--threshold",
        "5e-1",
        "--codex-timeout-ms",
        "6e5",
    ]));
    assert_eq!(
        explicit["evaluationIdentity"]["digest"],
        original.unwrap()["evaluationIdentity"]["digest"]
    );
}

#[test]
fn inline_path_values_preserve_leading_option_tokens() {
    let project = Project::new();
    let manifest = project.save(json!({}));
    let evidence = retained(&project.run(&[
        "--run-manifest-file",
        manifest.to_str().unwrap(),
        "--results-root=--dry",
    ]));
    let target = project.0.join("elsewhere/--dry");
    assert_eq!(
        evidence["configuration"]["resolved"]["resultsRoot"],
        target.to_str().unwrap()
    );
    assert_eq!(evidence["configuration"]["resolved"]["dry"], true);
    assert!(Path::new(evidence["result"]["evidencePath"].as_str().unwrap()).starts_with(&target));
    assert!(target.join("latest.json").is_file());
}

#[test]
fn empty_selected_paths_name_the_missing_input() {
    for key in [
        "case-file",
        "adapter-module",
        "extension-command-file",
        "extension-configuration-file",
        "extension-redacted-configuration-file",
        "case-source-root",
        "case-source-map-file",
        "codex-bin",
        "codex-auth-file",
        "project-root",
        "config-root",
        "results-root",
        "runtime-config-file",
    ] {
        let project = Project::new();
        let manifest = project.save(json!({}));
        let flag = format!("--{key}");
        let expected = if key == "adapter-module" {
            "missing --adapter-module or --host".to_owned()
        } else {
            format!("missing {flag}; supply {flag} with a value")
        };
        for arguments in [vec![flag.as_str(), ""], vec![]] {
            let inline = format!("{flag}=");
            let mut selected = vec!["--run-manifest-file", manifest.to_str().unwrap()];
            if arguments.is_empty() {
                selected.push(&inline);
            } else {
                selected.extend(arguments);
            }
            let output = project.run(&selected);
            assert_eq!(output.status.code(), Some(64));
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result["diagnostic"]["message"], expected);
            assert_eq!(result["evidencePath"], Value::Null);
            assert_eq!(result["cases"], json!([]));
            assert!(!project.0.join(".sevro").exists());
        }
    }
}

#[test]
fn configuration_files_accept_64_kib_and_refuse_the_next_byte() {
    for kind in ["manifest", "runtime"] {
        let project = Project::new();
        let manifest = project.save(json!({}));
        let runtime = project.0.join("runtime.json");
        write_json(&runtime, &json!({"format":"sevro.runtime.v1"}));
        let selected = if kind == "manifest" {
            &manifest
        } else {
            &runtime
        };
        let mut arguments = vec!["--run-manifest-file", manifest.to_str().unwrap()];
        if kind == "runtime" {
            arguments.extend(["--runtime-config-file", runtime.to_str().unwrap()]);
        }
        let ordinary = retained(&project.run(&arguments));
        let mut bytes = fs::read(selected).unwrap();
        bytes.resize(65536, b' ');
        fs::write(selected, &bytes).unwrap();
        let at_limit = retained(&project.run(&arguments));
        assert_eq!(
            at_limit["configuration"]["digest"],
            ordinary["configuration"]["digest"]
        );
        assert_eq!(
            at_limit["evaluationIdentity"]["digest"],
            ordinary["evaluationIdentity"]["digest"]
        );
        bytes.push(b' ');
        fs::write(selected, &bytes).unwrap();
        arguments.extend(["--results-root", "../refused-results"]);
        let output = project.run(&arguments);
        assert_eq!(output.status.code(), Some(64));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        assert!(
            result["diagnostic"]["message"]
                .as_str()
                .unwrap()
                .contains("64 KiB")
        );
        assert!(!project.0.join("refused-results").exists());
    }
}

#[test]
fn cyclic_selected_input_paths_fail_before_loading_or_storage() {
    for key in [
        "case-file",
        "adapter-module",
        "codex-bin",
        "codex-auth-file",
        "project-root",
        "config-root",
        "runtime-config-file",
        "case-source-root",
        "case-source-map-file",
        "extension-command-file",
        "extension-source-file",
        "extension-configuration-file",
        "extension-redacted-configuration-file",
    ] {
        let project = Project::new();
        let manifest = project.save(json!({}));
        let cycle = project.0.join("cycle");
        std::os::unix::fs::symlink("cycle", &cycle).unwrap();
        let mut arguments = vec!["--run-manifest-file", manifest.to_str().unwrap()];
        if key.starts_with("extension-") {
            arguments.extend([
                "--extension-command-file",
                "../unselected-command.json",
                "--case-id",
                "selected",
                "--extension-source-file",
                "../case.json",
            ]);
        }
        match key {
            "extension-configuration-file" => {
                arguments.extend(["--extension-redacted-configuration-file", "../case.json"])
            }
            "extension-redacted-configuration-file" => {
                arguments.extend(["--extension-configuration-file", "../case.json"])
            }
            "case-source-root" => arguments.extend(["--case-source-map-file", "../case.json"]),
            "case-source-map-file" => arguments.extend(["--case-source-root", ".."]),
            _ => {}
        }
        let flag = format!("--{key}");
        arguments.extend([&flag, cycle.to_str().unwrap()]);
        let output = project.run(&arguments);
        assert_eq!(
            output.status.code(),
            Some(64),
            "{key}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            result["diagnostic"]["message"]
                .as_str()
                .unwrap()
                .contains(cycle.to_str().unwrap()),
            "{result}"
        );
        assert_eq!(result["execution"]["status"], "not_run");
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        assert!(!project.0.join(".sevro").exists());
    }
}
