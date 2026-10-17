use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("sevro-rust-storage-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::write(
            root.join("case.json"),
            serde_json::to_vec(&json!({
                "id":"locked-workspace", "prompt":"Return ready.",
                "fixture":{"files":{"README.md":"original fixture\n"}},
                "checks":[], "requiredEvidence":[]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::create_dir(root.join("external")).unwrap();
        fs::write(root.join("external/retained.txt"), "external retained\n").unwrap();
        mode(&root.join("external/retained.txt"), 0o400);
        mode(&root.join("external"), 0o500);
        Self { root }
    }

    fn locked_adapter(&self, root_mode: Option<u32>) {
        let location = root_mode.map_or("join(workspace,'locked')", |_| "workspace");
        let permissions = root_mode.unwrap_or(0);
        fs::write(self.root.join("adapter.ts"), format!(
            "import {{chmod,mkdir,symlink,writeFile}} from 'node:fs/promises';\nimport {{join}} from 'node:path';\nexport default {{id:'sevro.host.storage',model:'synthetic',effort:'none',async run({{workspace}}) {{\nawait writeFile({},workspace);\nconst locked={location}; if(locked !== workspace) await mkdir(locked);\nawait writeFile(join(locked,'value.txt'),'candidate output\\n');\nawait symlink({},join(locked,'external'));\nawait chmod(locked,{permissions});\nreturn {{finalMessage:'ready',complete:true}};\n}}}};\n",
            json!(self.root.join("workspace.txt")), json!(self.root.join("external"))
        )).unwrap();
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

    fn workspace(&self) -> PathBuf {
        PathBuf::from(fs::read_to_string(self.root.join("workspace.txt")).unwrap())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(workspace) = fs::read_to_string(self.root.join("workspace.txt")) {
            let workspace = PathBuf::from(workspace);
            let _ = fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700));
            let _ =
                fs::set_permissions(workspace.join("locked"), fs::Permissions::from_mode(0o700));
            let _ = fs::remove_dir_all(&workspace);
            let _ = fs::remove_file(&workspace);
        }
        let _ = fs::set_permissions(
            self.root.join("external"),
            fs::Permissions::from_mode(0o700),
        );
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn mode(path: &Path, value: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(value)).unwrap();
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn results_file_collision_prints_runner_storage_hint() {
    let fixture = Fixture::new();
    fixture.locked_adapter(None);
    let results_root = fixture.root.join("results");
    fs::write(&results_root, "caller-owned results file\n").unwrap();

    let output = fixture.invoke();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert_eq!(output.status.code(), Some(70), "{stderr}");
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 1);
    let result: Value = serde_json::from_str(&stdout).unwrap();
    let message = result["diagnostic"]["message"].as_str().unwrap();
    assert!(
        message.contains(results_root.to_str().unwrap()),
        "{message}"
    );
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1", "runId":null,
            "execution":{"status":"not_run"}, "grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"}, "exitCode":70, "evidencePath":null,
            "cases":[], "diagnostic":{"code":"sevro.runner.error","message":message}
        })
    );
    assert_eq!(
        fs::read(&results_root).unwrap(),
        b"caller-owned results file\n"
    );
    assert!(!fixture.root.join("workspace.txt").exists());
    assert!(
        stderr.ends_with(&format!(
            "sevro: {message}\nCheck the reported path and ensure --results-root and --run-state-root are writable directories, then retry.\n"
        )),
        "{stderr}"
    );
}

#[test]
fn removes_permission_locked_workspace_without_changing_external_symlink_target() {
    let fixture = Fixture::new();
    fixture.locked_adapter(None);
    assert_cleaned(&fixture);
}

#[test]
fn removes_unreadable_and_read_only_workspace_roots_without_following_symlinks() {
    for permissions in [0o000, 0o500] {
        let fixture = Fixture::new();
        fixture.locked_adapter(Some(permissions));
        assert_cleaned(&fixture);
    }
}

fn assert_cleaned(fixture: &Fixture) {
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"completed"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    assert_eq!(evidence["result"], result);
    let workspace = fixture.workspace();
    assert!(
        !workspace.exists(),
        "permission-locked candidate workspace remains"
    );
    let observation = evidence["trials"][0]["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert_eq!(observation["data"]["candidate"], json!(workspace));
    assert_eq!(
        fs::metadata(fixture.root.join("external"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o500
    );
    assert_eq!(
        fs::metadata(fixture.root.join("external/retained.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o400
    );
    assert_eq!(
        fs::read(fixture.root.join("external/retained.txt")).unwrap(),
        b"external retained\n"
    );
    assert_eq!(read_json(&fixture.root.join("results/latest.json")), result);
}

#[test]
fn latest_publication_failure_keeps_completed_evidence_and_removes_temporary_files() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("adapter.ts"), "export default {id:'sevro.host.storage',model:'synthetic',effort:'none',async run(){return {finalMessage:'ready',complete:true}}};\n").unwrap();
    fs::create_dir_all(fixture.root.join("results/latest.json")).unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1", "runId":null,
            "execution":{"status":"not_run"},"grading":{"status":"not_requested"},"task":{"verdict":"not_assessed"},
            "exitCode":70,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.runner.error","message":"CLI result/latest could not be retained; check --results-root permissions"}
        })
    );
    let runs = fs::read_dir(fixture.root.join("results"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.join("run.json").is_file())
        .collect::<Vec<_>>();
    assert_eq!(runs.len(), 1);
    let run = &runs[0];
    let evidence = read_json(&run.join("run.json"));
    assert_eq!(evidence["result"]["exitCode"], 0);
    assert_eq!(
        evidence["result"]["execution"],
        json!({"status":"completed"})
    );
    assert_eq!(read_json(&run.join("result.json")), evidence["result"]);
    let trial = read_json(&run.join("trial-1.json"));
    assert_eq!(trial["evidence"], evidence["trials"][0]);
    assert_eq!(fs::read(run.join("trial-1-raw.txt")).unwrap(), b"ready");
    assert!(fixture.root.join("results/latest.json").is_dir());
    for directory in [fixture.root.join("results"), run.clone()] {
        for entry in fs::read_dir(directory).unwrap() {
            assert!(
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".tmp")
            );
        }
    }
}

#[test]
fn cleanup_failure_preserves_completed_result_and_replacement_file() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("adapter.ts"), format!(
        "import {{rm,writeFile}} from 'node:fs/promises';\nexport default {{id:'sevro.host.storage',model:'synthetic',effort:'none',async run({{workspace}}) {{\nawait writeFile({},workspace);\nawait rm(workspace,{{recursive:true}});\nawait writeFile(workspace,'candidate replacement file\\n');\nreturn {{finalMessage:'ready',complete:true}};\n}}}};\n",
        json!(fixture.root.join("workspace.txt"))
    )).unwrap();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["exitCode"], 0);
    assert!(result.get("diagnostic").is_none());
    for assessment in [
        &result,
        &result["cases"][0],
        &result["cases"][0]["trials"][0],
    ] {
        assert_eq!(assessment["execution"], json!({"status":"completed"}));
        assert_eq!(assessment["grading"], json!({"status":"not_requested"}));
        assert_eq!(assessment["task"], json!({"verdict":"not_assessed"}));
    }
    let evidence_path = Path::new(result["evidencePath"].as_str().unwrap());
    let evidence = read_json(evidence_path);
    assert_eq!(evidence["result"], result);
    let trial = &evidence["trials"][0];
    let workspace = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap()["data"]["candidate"]
        .as_str()
        .unwrap();
    assert!(Path::new(workspace).is_file());
    assert_eq!(
        fs::read(workspace).unwrap(),
        b"candidate replacement file\n"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains(&format!("fixture cleanup failed; retained at {workspace}"))
    );
    let raw = url::Url::parse(trial["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(raw).unwrap(), b"ready");
    let summary = &result["cases"][0]["trials"][0];
    let retained_trial = read_json(Path::new(summary["artifactPath"].as_str().unwrap()));
    assert_eq!(retained_trial["result"], *summary);
    assert_eq!(retained_trial["evidence"], *trial);
    assert_eq!(
        read_json(&evidence_path.parent().unwrap().join("result.json")),
        result
    );
    assert_eq!(read_json(&fixture.root.join("results/latest.json")), result);
}
