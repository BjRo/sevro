use jsonschema::Registry;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const ASSET_ROOTS: [&str; 8] = [
    "package.json",
    "README.md",
    "LICENSE",
    "CONTRIBUTING.md",
    "docs",
    "examples",
    "schemas",
    "src",
];

struct InstalledBundle {
    root: PathBuf,
    bundle: PathBuf,
}

struct RefusalBaseline {
    marker: PathBuf,
    latest: Vec<u8>,
    result_entries: std::collections::BTreeSet<std::ffi::OsString>,
}

impl InstalledBundle {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("sevro-bundle-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let bundle = root.join("installed");
        fs::create_dir_all(bundle.join("bin")).unwrap();
        fs::create_dir(root.join("project")).unwrap();
        fs::create_dir(root.join("temporary")).unwrap();
        fs::write(root.join("project/README.md"), "consumer project\n").unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut assets = Vec::new();
        for name in ASSET_ROOTS {
            copy_asset(&source, &bundle, Path::new(name), &mut assets);
        }
        assets.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        fs::write(
            bundle.join("sevro-native-bundle.json"),
            serde_json::to_vec(&json!({
                "format":"sevro.native-bundle.v1",
                "executable":"bin/sevro",
                "assets":assets
            }))
            .unwrap(),
        )
        .unwrap();
        copy_executable(
            Path::new(env!("CARGO_BIN_EXE_sevro")),
            &bundle.join("bin/sevro"),
        );
        Self { root, bundle }
    }

    fn run(&self) -> Output {
        self.run_binary(&self.bundle.join("bin/sevro"), &[])
    }

    fn run_binary(&self, binary: &Path, extra: &[&str]) -> Output {
        self.run_case_binary("graded.json", binary, extra)
    }

    fn run_case(&self, case: &str) -> Output {
        self.run_case_binary(case, &self.bundle.join("bin/sevro"), &[])
    }

    fn record_candidate_runs(&self) -> PathBuf {
        let marker = self.root.join("candidate-runs.txt");
        let marker_json = serde_json::to_string(&marker).unwrap();
        fs::write(
            self.bundle.join("examples/basic/host.ts"),
            format!(
                r#"import {{ appendFileSync }} from "node:fs";
export default {{
  id: "sevro.host.example", model: "deterministic-example", effort: "none",
  run() {{
    appendFileSync({marker_json}, "run\n");
    return Promise.resolve({{ finalMessage: "ready", complete: true }});
  }}
}};
"#
            ),
        )
        .unwrap();
        marker
    }

    fn refusal_baseline(&self) -> RefusalBaseline {
        let marker = self.record_candidate_runs();
        completed_evidence(&self.run());
        assert_eq!(fs::read(&marker).unwrap(), b"run\n");
        RefusalBaseline {
            marker,
            latest: fs::read(self.root.join("results/latest.json")).unwrap(),
            result_entries: self.result_entries(),
        }
    }

    fn result_entries(&self) -> std::collections::BTreeSet<std::ffi::OsString> {
        fs::read_dir(self.root.join("results"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect()
    }

    fn assert_refused_before_candidate(&self, output: &Output, baseline: &RefusalBaseline) {
        assert_refusal(output);
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["execution"]["status"], "not_run");
        assert_eq!(result["grading"]["status"], "not_requested");
        assert_eq!(result["cases"], json!([]));
        assert_eq!(fs::read(&baseline.marker).unwrap(), b"run\n");
        assert_eq!(
            fs::read(self.root.join("results/latest.json")).unwrap(),
            baseline.latest
        );
        assert_eq!(self.result_entries(), baseline.result_entries);
        assert_eq!(
            fs::read(self.root.join("project/README.md")).unwrap(),
            b"consumer project\n"
        );
    }

    fn run_case_binary(&self, case: &str, binary: &Path, extra: &[&str]) -> Output {
        Command::new(binary)
            .args(["run", "--json", "--case-file"])
            .arg(self.bundle.join("examples/basic").join(case))
            .arg("--adapter-module")
            .arg(self.bundle.join("examples/basic/host.ts"))
            .arg("--project-root")
            .arg(self.root.join("project"))
            .arg("--config-root")
            .arg(&self.root)
            .arg("--results-root")
            .arg(self.root.join("results"))
            .args([
                "--condition",
                "passive",
                "--trials",
                "1",
                "--threshold",
                "1",
            ])
            .args(extra)
            .current_dir(&self.root)
            .env("TMPDIR", self.root.join("temporary"))
            .output()
            .unwrap()
    }

    fn expected_digest(&self) -> String {
        // Independent Python receipt over actual installed bytes and the public
        // native envelope; it does not import Rust helpers or trust the manifest's list.
        let script = self.root.join("receipt.py");
        fs::write(
            &script,
            r#"import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
paths=[pathlib.Path('sevro-native-bundle.json')]
for name in ('package.json','README.md','LICENSE','CONTRIBUTING.md','docs','examples','schemas','src'):
    path=root/name
    paths.extend([p.relative_to(root) for p in path.rglob('*') if p.is_file()] if path.is_dir() else [pathlib.Path(name)])
paths.sort(key=lambda p:p.as_posix().encode('utf-16-be'))
assets=[{'path':p.as_posix(),'sha256':hashlib.sha256((root/p).read_bytes()).hexdigest()} for p in paths]
profile={'format':'sevro.native-build.v1','distribution':'bundle','executableSha256':hashlib.sha256((root/'bin/sevro').read_bytes()).hexdigest(),'assets':assets}
print(hashlib.sha256(json.dumps(profile,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest())
"#,
        )
        .unwrap();
        let output = Command::new("python3")
            .arg(script)
            .arg(&self.bundle)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn validate_documents(&self, documents: &[(&str, &Value)]) {
        let mut registry = Registry::new();
        for name in ["cli-result", "run-evidence", "report"] {
            let path = self.bundle.join(format!("schemas/{name}-v1.schema.json"));
            let schema: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            registry = registry
                .add(format!("urn:sevro:schema:{name}:v1"), schema)
                .unwrap();
        }
        let registry = registry.prepare().unwrap();
        for (name, document) in documents {
            let schema = json!({"$ref":format!("urn:sevro:schema:{name}:v1")});
            let validator = jsonschema::draft202012::options()
                .with_registry(&registry)
                .build(&schema)
                .unwrap();
            let errors: Vec<_> = validator
                .iter_errors(document)
                .map(|error| error.to_string())
                .collect();
            assert!(errors.is_empty(), "invalid installed {name}: {errors:?}");
        }
    }
}

impl Drop for InstalledBundle {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn copy_asset(source: &Path, bundle: &Path, path: &Path, assets: &mut Vec<String>) {
    let metadata = fs::symlink_metadata(source.join(path)).unwrap();
    assert!(
        !metadata.is_symlink(),
        "source asset must be an ordinary path: {}",
        path.display()
    );
    if metadata.is_dir() {
        fs::create_dir(bundle.join(path)).unwrap();
        for entry in fs::read_dir(source.join(path)).unwrap() {
            copy_asset(
                source,
                bundle,
                &path.join(entry.unwrap().file_name()),
                assets,
            );
        }
    } else {
        assert!(metadata.is_file());
        fs::copy(source.join(path), bundle.join(path)).unwrap();
        assets.push(path.to_str().unwrap().to_owned());
    }
}

fn copy_executable(source: &Path, destination: &Path) {
    // A waited child owns the writable descriptor, preventing another test's
    // concurrent spawn from inheriting it and producing Linux ETXTBSY.
    let output = Command::new("/bin/cp")
        .arg(source)
        .arg(destination)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "copying {} to {}: {}: {}",
        source.display(),
        destination.display(),
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn completed_evidence(output: &Output) -> Value {
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"]["status"], "completed");
    assert_eq!(result["grading"]["status"], "completed");
    assert_eq!(result["task"]["verdict"], "passed");
    let evidence: Value =
        serde_json::from_slice(&fs::read(result["evidencePath"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!(evidence["format"], "sevro.run-evidence.v1");
    assert_eq!(evidence["result"], result);
    evidence
}

#[test]
fn installed_bundle_runs_packaged_case_with_bound_assets() {
    let installed = InstalledBundle::new();
    assert!(!installed.bundle.join(".git").exists());
    assert!(!installed.bundle.join("tests").exists());
    let expected = installed.expected_digest();
    let retained = completed_evidence(&installed.run());
    assert_eq!(
        retained["runner"],
        json!({
            "source":"package","packageName":"@bjoernrochel/sevro",
            "version":env!("CARGO_PKG_VERSION"),"buildDigest":expected
        })
    );
    assert_eq!(
        retained["evaluationIdentity"]["dimensions"]["runnerBuildDigest"],
        expected
    );
    assert_eq!(retained["trials"].as_array().unwrap().len(), 1);
}

#[test]
fn installed_bundle_runs_prompt_only_without_claiming_task_success() {
    let installed = InstalledBundle::new();
    let output = installed.run_case("prompt-only.json");
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["format"], "sevro.cli-result.v1");
    assert_eq!(result["exitCode"], 0);
    assert_eq!(result["execution"]["status"], "completed");
    assert_eq!(result["grading"]["status"], "not_requested");
    assert_eq!(result["task"]["verdict"], "not_assessed");
    assert_eq!(result["cases"].as_array().unwrap().len(), 1);
    let trials = result["cases"][0]["trials"].as_array().unwrap();
    assert_eq!(trials.len(), 1);
    assert_eq!(trials[0]["checks"], json!([]));
    let evidence: Value =
        serde_json::from_slice(&fs::read(result["evidencePath"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!(evidence["format"], "sevro.run-evidence.v1");
    assert_eq!(evidence["result"], result);
    assert_eq!(evidence["trials"].as_array().unwrap().len(), 1);
    assert_eq!(
        evidence["runner"]["buildDigest"],
        installed.expected_digest()
    );
}

#[test]
fn installed_bundle_reports_real_graded_and_prompt_only_results() {
    let installed = InstalledBundle::new();
    let graded = installed.run();
    let graded_evidence = completed_evidence(&graded);
    let prompt = installed.run_case("prompt-only.json");
    assert_eq!(
        prompt.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&prompt.stderr)
    );
    let prompt_result: Value = serde_json::from_slice(&prompt.stdout).unwrap();
    assert_eq!(prompt_result["task"]["verdict"], "not_assessed");
    let graded_path = installed.root.join("graded-result.json");
    let prompt_path = installed.root.join("prompt-result.json");
    fs::write(&graded_path, &graded.stdout).unwrap();
    fs::write(&prompt_path, &prompt.stdout).unwrap();
    let output = Command::new(installed.bundle.join("bin/sevro"))
        .args(["report", "--json", "--result-file"])
        .arg(&graded_path)
        .arg("--result-file")
        .arg(&prompt_path)
        .current_dir(&installed.root)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["format"], "sevro.report.v1");
    assert_eq!(
        report["summary"],
        json!({"cases":2,"passed":1,"failed":0,"notAssessed":1})
    );
    let rows = report["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["caseId"], "basic-graded");
    assert_eq!(rows[0]["task"], "passed");
    assert_eq!(rows[1]["caseId"], "basic-prompt-only");
    assert_eq!(rows[1]["task"], "not_assessed");
    assert_eq!(rows[1]["taskPassRate"], Value::Null);
    for row in rows {
        assert_eq!(row["trialCount"], 1);
        assert!(row["candidateDurationMs"].is_number());
        assert_eq!(row["costUsd"], Value::Null);
        assert_eq!(
            row["runnerBuildDigest"],
            graded_evidence["runner"]["buildDigest"]
        );
    }
    assert_eq!(fs::read(&graded_path).unwrap(), graded.stdout);
    assert_eq!(fs::read(&prompt_path).unwrap(), prompt.stdout);
}

#[test]
fn installed_bundle_response_template_preserves_pass_fail_dry_and_latest() {
    let installed = InstalledBundle::new();
    let binary = installed.bundle.join("bin/sevro");
    let consumer = installed.root.join("project");
    let output = Command::new(&binary)
        .args(["init", "--template", "response", "--directory", "response"])
        .current_dir(&consumer)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let project = consumer.join("response");
    assert!(!project.join(".git").exists());
    let manifest = fs::read(project.join("run.json")).unwrap();
    let adapter = fs::read(project.join("adapter.ts")).unwrap();
    let digest = installed.expected_digest();
    let mut failed_workspace = None;
    let latest_path = project.join(".sevro/results/latest.json");
    for (mode, exit_code, verdict) in [
        ("pass", 0, "passed"),
        ("fail", 1, "failed"),
        ("dry", 0, "not_assessed"),
    ] {
        let mut command = Command::new(&binary);
        command
            .args(["run", "--json", "--run-manifest-file", "run.json"])
            .current_dir(&project)
            .env("TMPDIR", installed.root.join("temporary"))
            .env(
                "SEVRO_TEMPLATE_FAIL",
                if mode == "fail" { "1" } else { "0" },
            );
        if mode == "dry" {
            command.arg("--dry");
        }
        let output = command.output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(exit_code),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["task"]["verdict"], verdict);
        assert_eq!(result["exitCode"], exit_code);
        assert_eq!(
            result["execution"]["status"],
            if mode == "dry" {
                "not_run"
            } else {
                "completed"
            }
        );
        assert_eq!(
            result["grading"]["status"],
            if mode == "dry" {
                "not_requested"
            } else {
                "completed"
            }
        );
        assert_eq!(result["cases"].as_array().unwrap().len(), 1);
        assert_eq!(result["cases"][0]["caseId"], "response-check");
        let evidence_path = Path::new(result["evidencePath"].as_str().unwrap());
        assert!(evidence_path.starts_with(project.join(".sevro/results")));
        let evidence: Value = serde_json::from_slice(&fs::read(evidence_path).unwrap()).unwrap();
        installed.validate_documents(&[("cli-result", &result), ("run-evidence", &evidence)]);
        assert_eq!(evidence["result"], result);
        assert_eq!(evidence["runner"]["buildDigest"], digest);
        assert_eq!(evidence["trials"].as_array().unwrap().len(), 1);
        assert_eq!(
            evidence["trials"][0]["candidateDurationMs"].is_null(),
            mode == "dry"
        );
        let latest: Value = serde_json::from_slice(&fs::read(&latest_path).unwrap()).unwrap();
        assert_eq!(latest, result);
        let workspace = evidence["trials"][0]["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|observation| observation["id"] == "sevro.observation.workspaces")
            .unwrap()["data"]["candidate"]
            .as_str()
            .unwrap();
        let workspace = PathBuf::from(workspace);
        assert_eq!(workspace.exists(), mode == "fail", "{mode}: {workspace:?}");
        if mode == "fail" {
            failed_workspace = Some(workspace);
        }
    }
    let latest = fs::read(&latest_path).unwrap();
    let output = Command::new(&binary)
        .args(["report", "--latest", "--json"])
        .current_dir(&project)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    installed.validate_documents(&[("report", &report)]);
    assert_eq!(
        report["summary"],
        json!({"cases":1,"passed":0,"failed":0,"notAssessed":1})
    );
    assert_eq!(report["rows"].as_array().unwrap().len(), 1);
    assert_eq!(report["rows"][0]["caseId"], "response-check");
    assert_eq!(report["rows"][0]["task"], "not_assessed");
    assert_eq!(report["rows"][0]["candidateDurationMs"], Value::Null);
    assert_eq!(report["rows"][0]["runnerBuildDigest"], digest);
    assert_eq!(fs::read(&latest_path).unwrap(), latest);
    assert_eq!(fs::read(project.join("run.json")).unwrap(), manifest);
    assert_eq!(fs::read(project.join("adapter.ts")).unwrap(), adapter);
    fs::remove_dir_all(failed_workspace.unwrap()).unwrap();
}

#[test]
fn relocating_a_complete_bundle_preserves_its_build_identity() {
    let mut installed = InstalledBundle::new();
    let original = completed_evidence(&installed.run());
    let relocated = installed.root.join("relocated");
    fs::rename(&installed.bundle, &relocated).unwrap();
    installed.bundle = relocated;
    let moved = completed_evidence(&installed.run());
    assert_eq!(moved["runner"], original["runner"]);
    assert_eq!(moved["runner"]["buildDigest"], installed.expected_digest());
}

#[test]
fn changing_a_shipped_asset_changes_the_installed_build_identity() {
    let installed = InstalledBundle::new();
    let original = completed_evidence(&installed.run());
    let path = installed.bundle.join("README.md");
    let mut bytes = fs::read(&path).unwrap();
    bytes.extend_from_slice(b"\nInstalled asset change.\n");
    fs::write(path, bytes).unwrap();
    let changed = completed_evidence(&installed.run());
    assert_ne!(
        changed["runner"]["buildDigest"],
        original["runner"]["buildDigest"]
    );
    assert_eq!(
        changed["runner"]["buildDigest"],
        installed.expected_digest()
    );
}

#[test]
fn missing_bundle_manifest_or_asset_refuses_without_replacing_latest() {
    let installed = InstalledBundle::new();
    completed_evidence(&installed.run());
    let latest_path = installed.root.join("results/latest.json");
    let latest = fs::read(&latest_path).unwrap();
    for relative in ["sevro-native-bundle.json", "schemas/report-v1.schema.json"] {
        let path = installed.bundle.join(relative);
        let withheld = installed.root.join("withheld");
        fs::rename(&path, &withheld).unwrap();
        let output = installed.run();
        assert_refusal(&output);
        assert_eq!(fs::read(&latest_path).unwrap(), latest);
        assert!(withheld.is_file());
        fs::rename(withheld, path).unwrap();
    }
}

#[test]
fn unsupported_bundle_manifest_identity_refuses_before_candidate_execution() {
    let installed = InstalledBundle::new();
    let baseline = installed.refusal_baseline();
    let manifest_path = installed.bundle.join("sevro-native-bundle.json");
    let original: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    for (key, value) in [
        ("format", "sevro.native-bundle.v2"),
        ("executable", "bin/another-runner"),
    ] {
        let mut manifest = original.clone();
        manifest[key] = json!(value);
        let bytes = serde_json::to_vec(&manifest).unwrap();
        fs::write(&manifest_path, &bytes).unwrap();
        let output = installed.run();
        installed.assert_refused_before_candidate(&output, &baseline);
        assert_eq!(fs::read(&manifest_path).unwrap(), bytes);
    }
}

#[test]
fn unsorted_or_duplicate_bundle_assets_refuse_before_candidate_execution() {
    let installed = InstalledBundle::new();
    let baseline = installed.refusal_baseline();
    let manifest_path = installed.bundle.join("sevro-native-bundle.json");
    let original: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    for duplicate in [false, true] {
        let mut manifest = original.clone();
        let assets = manifest["assets"].as_array_mut().unwrap();
        if duplicate {
            assets.insert(1, assets[0].clone());
        } else {
            assets.swap(0, 1);
        }
        let bytes = serde_json::to_vec(&manifest).unwrap();
        fs::write(&manifest_path, &bytes).unwrap();
        installed.assert_refused_before_candidate(&installed.run(), &baseline);
        assert_eq!(fs::read(&manifest_path).unwrap(), bytes);
    }
}

#[test]
fn omitting_a_required_bundle_asset_refuses_before_candidate_execution() {
    let installed = InstalledBundle::new();
    let baseline = installed.refusal_baseline();
    let asset_path = installed.bundle.join("docs/installing.md");
    let asset_bytes = fs::read(&asset_path).unwrap();
    let manifest_path = installed.bundle.join("sevro-native-bundle.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    let assets = manifest["assets"].as_array_mut().unwrap();
    let previous_count = assets.len();
    assets.retain(|asset| asset != "docs/installing.md");
    assert_eq!(assets.len(), previous_count - 1);
    let bytes = serde_json::to_vec(&manifest).unwrap();
    fs::write(&manifest_path, &bytes).unwrap();
    installed.assert_refused_before_candidate(&installed.run(), &baseline);
    assert_eq!(fs::read(&manifest_path).unwrap(), bytes);
    assert_eq!(fs::read(&asset_path).unwrap(), asset_bytes);
}

#[test]
fn mismatched_bundle_package_identity_refuses_before_candidate_execution() {
    let installed = InstalledBundle::new();
    let baseline = installed.refusal_baseline();
    let package_path = installed.bundle.join("package.json");
    let original: Value = serde_json::from_slice(&fs::read(&package_path).unwrap()).unwrap();
    for (key, value) in [("name", "@example/different-runner"), ("version", "0.0.0")] {
        let mut package = original.clone();
        package[key] = json!(value);
        let bytes = serde_json::to_vec(&package).unwrap();
        fs::write(&package_path, &bytes).unwrap();
        installed.assert_refused_before_candidate(&installed.run(), &baseline);
        assert_eq!(fs::read(&package_path).unwrap(), bytes);
    }
}

fn assert_refusal(output: &Output) {
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["exitCode"], 70);
    assert_eq!(result["task"]["verdict"], "not_assessed");
    assert_eq!(result["evidencePath"], Value::Null);
    assert!(String::from_utf8_lossy(&output.stdout).contains("native bundle"));
}

#[test]
fn copied_out_bundle_executable_does_not_fall_back_to_standalone_identity() {
    let installed = InstalledBundle::new();
    let detached = installed.root.join("detached/bin/sevro");
    fs::create_dir_all(detached.parent().unwrap()).unwrap();
    copy_executable(&installed.bundle.join("bin/sevro"), &detached);
    assert_refusal(&installed.run_binary(&detached, &[]));
    assert!(!installed.root.join("results/latest.json").exists());
    assert!(installed.bundle.join("sevro-native-bundle.json").is_file());
}

#[test]
fn explicit_runner_digest_overrides_automatic_bundle_identity() {
    let installed = InstalledBundle::new();
    fs::remove_file(installed.bundle.join("sevro-native-bundle.json")).unwrap();
    let digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let retained = completed_evidence(&installed.run_binary(
        &installed.bundle.join("bin/sevro"),
        &["--runner-build-digest", digest],
    ));
    assert_eq!(retained["runner"]["buildDigest"], digest);
    assert_eq!(
        retained["evaluationIdentity"]["dimensions"]["runnerBuildDigest"],
        digest
    );
}

#[test]
fn unsafe_manifest_paths_refuse_without_changing_outside_files() {
    let installed = InstalledBundle::new();
    let baseline = installed.refusal_baseline();
    let outside = installed.root.join("outside.txt");
    fs::write(&outside, "outside bundle\n").unwrap();
    let manifest_path = installed.bundle.join("sevro-native-bundle.json");
    let original: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    for path in [
        "",
        "../outside.txt",
        "docs/../outside.txt",
        "docs\\outside.txt",
        "docs//installing.md",
        "docs/./installing.md",
        "docs/\0installing.md",
        "unexpected-root/file.txt",
        outside.to_str().unwrap(),
    ] {
        let mut manifest = original.clone();
        let assets = manifest["assets"].as_array_mut().unwrap();
        assets.push(json!(path));
        assets.sort_by(|left, right| {
            left.as_str()
                .unwrap()
                .encode_utf16()
                .cmp(right.as_str().unwrap().encode_utf16())
        });
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let output = installed.run();
        installed.assert_refused_before_candidate(&output, &baseline);
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("unsafe or undeclared asset path")
        );
        assert_eq!(fs::read(&outside).unwrap(), b"outside bundle\n");
    }
}

#[test]
fn symlinked_or_non_file_assets_refuse_without_changing_the_referent() {
    let installed = InstalledBundle::new();
    let outside = installed.root.join("outside.txt");
    fs::write(&outside, "owned referent\n").unwrap();
    let asset = installed.bundle.join("README.md");
    fs::remove_file(&asset).unwrap();
    std::os::unix::fs::symlink(&outside, &asset).unwrap();
    assert_refusal(&installed.run());
    assert_eq!(fs::read(&outside).unwrap(), b"owned referent\n");
    fs::remove_file(&asset).unwrap();
    fs::create_dir(&asset).unwrap();
    assert_refusal(&installed.run());
    assert_eq!(fs::read(&outside).unwrap(), b"owned referent\n");
    assert!(!installed.root.join("results/latest.json").exists());
}
