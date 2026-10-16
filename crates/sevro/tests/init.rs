use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct Project(PathBuf);

impl Project {
    fn new() -> Self {
        let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("sevro-rust-init-{}-{sequence}", std::process::id()));
        fs::create_dir(&path).expect("create init invocation directory");
        Self(path.canonicalize().expect("canonical invocation directory"))
    }

    fn init(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_sevro"))
            .arg("init")
            .args(args)
            .current_dir(&self.0)
            .output()
            .expect("execute sevro init")
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove init invocation directory");
    }
}

fn text(output: &[u8]) -> String {
    String::from_utf8(output.to_vec()).expect("UTF-8 command output")
}

fn baseline_run(directory: &Path, fail: bool) -> Output {
    let cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/cli.ts");
    Command::new("bun")
        .arg(cli)
        .args(["run", "--run-manifest-file", "run.json", "--json"])
        .env("SEVRO_TEMPLATE_FAIL", if fail { "1" } else { "0" })
        .current_dir(directory)
        .output()
        .expect("execute generated project through existing TypeScript runner")
}

#[test]
fn response_template_creates_runnable_positive_and_negative_controls() {
    let project = Project::new();
    let output = project.init(&["--template", "response", "--directory", "sample"]);
    assert_eq!(output.status.code(), Some(0), "{}", text(&output.stderr));
    assert!(output.stderr.is_empty());
    let sample = project.0.join("sample");
    assert_eq!(
        text(&output.stdout),
        format!(
            "Created response evaluation at {}\nOpen README.md, then:\n  cd '{}'\n  sevro run --run-manifest-file run.json --dry\n  sevro run --run-manifest-file run.json\n",
            sample.display(),
            sample.display()
        )
    );
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(sample.join("run.json")).unwrap()).unwrap();
    assert_eq!(
        manifest,
        serde_json::json!({
            "format": "sevro.run.v1",
            "settings": {
                "case-file": "case.json",
                "adapter-module": "adapter.ts",
                "project-root": "."
            }
        })
    );
    assert_eq!(
        fs::read_to_string(sample.join(".gitignore")).unwrap(),
        ".sevro/\n"
    );
    let readme = fs::read_to_string(sample.join("README.md")).unwrap();
    assert!(readme.contains("an exact response assertion"));
    assert!(readme.contains("negative control must report task=failed and exit 1"));
    for (fail, code, verdict) in [(false, 0, "passed"), (true, 1, "failed")] {
        let run = baseline_run(&sample, fail);
        assert_eq!(run.status.code(), Some(code), "{}", text(&run.stderr));
        let result: serde_json::Value = serde_json::from_slice(&run.stdout).unwrap();
        assert_eq!(result["task"]["verdict"], verdict);
        assert!(
            Path::new(result["evidencePath"].as_str().unwrap())
                .starts_with(sample.join(".sevro/results"))
        );
    }
}

#[test]
fn existing_destination_and_alias_are_refused_without_touching_user_content() {
    let project = Project::new();
    let existing = project.0.join("existing");
    fs::create_dir(&existing).unwrap();
    fs::write(existing.join("keep.txt"), "preserve").unwrap();
    for name in ["existing", "occupied.txt"] {
        if name == "occupied.txt" {
            fs::write(project.0.join(name), "existing file").unwrap();
        }
        let output = project.init(&["--directory", name]);
        assert_eq!(output.status.code(), Some(64));
        assert!(output.stdout.is_empty());
        assert!(text(&output.stderr).contains("already exists"));
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("existing", project.0.join("alias")).unwrap();
        std::os::unix::fs::symlink("missing", project.0.join("dangling")).unwrap();
        for name in ["alias", "dangling"] {
            let output = project.init(&["--directory", name]);
            assert_eq!(output.status.code(), Some(64));
            assert!(output.stdout.is_empty());
            assert!(text(&output.stderr).contains("already exists"));
            assert!(
                fs::symlink_metadata(project.0.join(name))
                    .unwrap()
                    .is_symlink()
            );
        }
    }
    assert_eq!(
        fs::read_to_string(existing.join("keep.txt")).unwrap(),
        "preserve"
    );
    assert_eq!(fs::read_dir(&existing).unwrap().count(), 1);
    assert_eq!(
        fs::read_to_string(project.0.join("occupied.txt")).unwrap(),
        "existing file"
    );
}

#[test]
fn equals_options_resolve_dot_segments_and_print_a_shell_safe_destination() {
    let project = Project::new();
    let output = project.init(&[
        "--template=response",
        "--directory=parent/unused/../owner's sample",
    ]);
    assert_eq!(output.status.code(), Some(0), "{}", text(&output.stderr));
    let sample = project.0.join("parent/owner's sample");
    assert!(sample.join("case.json").is_file());
    assert!(!project.0.join("parent/unused").exists());
    let message = text(&output.stdout);
    assert!(message.starts_with(&format!(
        "Created response evaluation at {}\n",
        sample.display()
    )));
    assert!(message.contains(&format!(
        "  cd '{}/parent/owner'\\''s sample'\n",
        project.0.display()
    )));
}

#[test]
fn invalid_init_options_fail_without_creating_files() {
    let project = Project::new();
    for args in [
        vec!["--template", "unknown"],
        vec!["unexpected"],
        vec!["--directory", ""],
        vec!["--directory", "  "],
        vec!["--directory"],
        vec!["--unknown", "value"],
        vec!["--directory", "--template=response"],
    ] {
        let output = project.init(&args);
        assert_eq!(output.status.code(), Some(64), "arguments: {args:?}");
        assert!(output.stdout.is_empty(), "arguments: {args:?}");
        assert!(!output.stderr.is_empty(), "arguments: {args:?}");
        assert_eq!(
            fs::read_dir(&project.0).unwrap().count(),
            0,
            "arguments: {args:?}"
        );
    }
}

#[test]
fn coding_template_grades_real_edits_and_preserves_its_negative_control() {
    let project = Project::new();
    let output = project.init(&["--template", "coding", "--directory", "coding"]);
    assert_eq!(output.status.code(), Some(0), "{}", text(&output.stderr));
    assert!(output.stderr.is_empty());
    assert!(text(&output.stdout).starts_with("Created coding evaluation at "));
    let sample = project.0.join("coding");
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(sample.join("run.json")).unwrap()).unwrap();
    assert_eq!(manifest["settings"]["shell-isolation"], true);
    let readme = fs::read_to_string(sample.join("README.md")).unwrap();
    assert!(
        readme.contains("positive, negative and zero addition assertions against edited add.sh")
    );
    assert!(readme.contains("bubblewrap/socat on Linux"));
    for (fail, code, verdict, check) in [
        (false, 0, "passed", "passed"),
        (true, 1, "failed", "failed"),
    ] {
        let run = baseline_run(&sample, fail);
        assert_eq!(run.status.code(), Some(code), "{}", text(&run.stderr));
        let result: serde_json::Value = serde_json::from_slice(&run.stdout).unwrap();
        assert_eq!(result["task"]["verdict"], verdict);
        assert_eq!(
            result["cases"][0]["trials"][0]["checks"][0]["id"],
            "addition"
        );
        assert_eq!(
            result["cases"][0]["trials"][0]["checks"][0]["status"],
            check
        );
    }
}

#[test]
fn repository_skill_template_prepares_the_real_mount_with_explicit_native_prerequisites() {
    let project = Project::new();
    let output = project.init(&["--template", "repository-skill", "--directory", "skill"]);
    assert_eq!(output.status.code(), Some(0), "{}", text(&output.stderr));
    assert!(output.stderr.is_empty());
    assert!(text(&output.stdout).contains(
        "--model YOUR_MODEL --effort YOUR_EFFORT --codex-auth-file /absolute/auth.json --dry"
    ));
    let sample = project.0.join("skill");
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(sample.join("run.json")).unwrap()).unwrap();
    assert_eq!(
        manifest,
        serde_json::json!({
            "format": "sevro.run.v1",
            "settings": {
                "project-root": ".",
                "extension-command-file": "command.json",
                "extension-source-file": ["extension.ts", "extension-data.ts", ".agents/skills/startup-guide/SKILL.md"],
                "case-id": "repository-skill",
                "host": "codex"
            }
        })
    );
    let command: Vec<String> =
        serde_json::from_slice(&fs::read(sample.join("command.json")).unwrap()).unwrap();
    assert_eq!(command.len(), 2);
    assert!(Path::new(&command[0]).is_absolute());
    assert_eq!(Path::new(&command[1]), sample.join("extension.ts"));
    let cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/cli.ts");
    let run = |extra: &[&str]| {
        Command::new("bun")
            .arg(&cli)
            .args(["run", "--run-manifest-file", "run.json", "--json", "--dry"])
            .args(extra)
            .current_dir(&sample)
            .output()
            .unwrap()
    };
    let missing = run(&[]);
    assert_eq!(missing.status.code(), Some(64));
    assert!(text(&missing.stderr).contains("--codex-auth-file"));
    fs::write(sample.join("auth.json"), "synthetic preparation only").unwrap();
    let prepared = run(&[
        "--model",
        "synthetic",
        "--effort",
        "low",
        "--codex-bin",
        "/bin/true",
        "--codex-auth-file",
        "auth.json",
    ]);
    assert_eq!(
        prepared.status.code(),
        Some(0),
        "{}",
        text(&prepared.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&prepared.stdout).unwrap();
    assert_eq!(result["execution"]["status"], "not_run");
    assert_eq!(result["grading"]["status"], "not_requested");
    assert_eq!(result["task"]["verdict"], "not_assessed");
    let evidence: serde_json::Value =
        serde_json::from_slice(&fs::read(result["evidencePath"].as_str().unwrap()).unwrap())
            .unwrap();
    let mounted = evidence["trials"][0]["artifactRefs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|artifact| artifact["id"] == "template.startup-skill")
        .unwrap();
    let mounted_bytes = fs::read(
        mounted["path"]
            .as_str()
            .unwrap()
            .strip_prefix("file://")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        mounted_bytes,
        fs::read(sample.join(".agents/skills/startup-guide/SKILL.md")).unwrap()
    );
    assert!(text(&mounted_bytes).contains("Read README.md"));
    assert!(
        fs::read_to_string(sample.join("README.md"))
            .unwrap()
            .contains("No authenticated model execution")
    );
}

#[test]
fn missing_bun_removes_the_partial_repository_skill_destination() {
    let project = Project::new();
    let empty_path = project.0.join("empty-bin");
    fs::create_dir(&empty_path).unwrap();
    fs::write(project.0.join("keep.txt"), "preserve neighboring files").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_sevro"))
        .args([
            "init",
            "--template",
            "repository-skill",
            "--directory",
            "skill",
        ])
        .env("PATH", &empty_path)
        .current_dir(&project.0)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(64));
    assert!(output.stdout.is_empty());
    assert_eq!(
        text(&output.stderr),
        "sevro: repository-skill initialization requires Bun on PATH\n"
    );
    assert!(!project.0.join("skill").exists());
    assert_eq!(
        fs::read_to_string(project.0.join("keep.txt")).unwrap(),
        "preserve neighboring files"
    );
    assert_eq!(fs::read_dir(&project.0).unwrap().count(), 2);

    let retry = project.init(&["--template", "repository-skill", "--directory", "skill"]);
    assert_eq!(retry.status.code(), Some(0), "{}", text(&retry.stderr));
    assert!(project.0.join("skill/command.json").is_file());
}

#[test]
#[cfg(unix)]
fn failed_bun_discovery_removes_the_partial_repository_skill_destination() {
    use std::os::unix::fs::PermissionsExt;

    let project = Project::new();
    let bin = project.0.join("bin");
    fs::create_dir(&bin).unwrap();
    let bun = bin.join("bun");
    let script = "#!/bin/sh\nprintf '/unavailable/bun\\n'\nexit 7\n";
    fs::write(&bun, script).unwrap();
    fs::set_permissions(&bun, fs::Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_sevro"))
        .args([
            "init",
            "--template",
            "repository-skill",
            "--directory",
            "skill",
        ])
        .env("PATH", &bin)
        .current_dir(&project.0)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(64));
    assert!(output.stdout.is_empty());
    assert_eq!(
        text(&output.stderr),
        "sevro: repository-skill initialization requires Bun on PATH\n"
    );
    assert!(!project.0.join("skill").exists());
    assert_eq!(fs::read_to_string(&bun).unwrap(), script);
    assert_eq!(fs::read_dir(&project.0).unwrap().count(), 1);
}

#[test]
fn an_uncreatable_parent_preserves_the_obstructing_file() {
    let project = Project::new();
    fs::write(project.0.join("occupied"), "user-owned file").unwrap();
    let output = project.init(&["--directory", "occupied/nested/evaluation"]);
    assert_eq!(output.status.code(), Some(64));
    assert!(output.stdout.is_empty());
    assert!(text(&output.stderr).starts_with("sevro: "));
    assert_eq!(
        fs::read_to_string(project.0.join("occupied")).unwrap(),
        "user-owned file"
    );
    assert_eq!(fs::read_dir(&project.0).unwrap().count(), 1);
}

#[test]
fn final_template_selection_wins_and_bare_terminator_preserves_defaults() {
    for args in [
        vec!["--template", "unknown", "--template", "response"],
        vec!["--"],
    ] {
        let project = Project::new();
        let output = project.init(&args);
        assert_eq!(output.status.code(), Some(0), "{}", text(&output.stderr));
        assert!(output.stderr.is_empty());
        assert!(project.0.join("sevro-evaluation/case.json").is_file());
        assert!(text(&output.stdout).starts_with("Created response evaluation at "));
    }
}

fn template_files(root: &Path, directory: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(template_files(root, &path));
        } else {
            files.insert(
                path.strip_prefix(root).unwrap().to_owned(),
                fs::read(&path).unwrap(),
            );
        }
    }
    files
}

#[test]
fn initializer_artifacts_and_instructions_match_the_existing_cli() {
    let cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/cli.ts");
    for args in [
        vec![],
        vec!["--"],
        vec!["--template", "unknown", "--template", "response"],
        vec!["--template", "coding"],
        vec!["--template", "repository-skill"],
    ] {
        let reference = Project::new();
        let project = Project::new();
        let baseline = Command::new("bun")
            .arg(&cli)
            .arg("init")
            .args(&args)
            .current_dir(&reference.0)
            .output()
            .unwrap();
        assert_eq!(
            baseline.status.code(),
            Some(0),
            "{}",
            text(&baseline.stderr)
        );
        let output = project.init(&args);
        assert_eq!(output.status.code(), Some(0), "{}", text(&output.stderr));
        assert_eq!(output.stderr, baseline.stderr);
        assert_eq!(
            text(&output.stdout),
            text(&baseline.stdout)
                .replace(reference.0.to_str().unwrap(), project.0.to_str().unwrap())
        );
        let mut expected = template_files(&reference.0, &reference.0);
        let command_path = PathBuf::from("sevro-evaluation/command.json");
        if let Some(command) = expected.get_mut(&command_path) {
            *command = text(command)
                .replace(reference.0.to_str().unwrap(), project.0.to_str().unwrap())
                .into_bytes();
        }
        assert_eq!(
            template_files(&project.0, &project.0),
            expected,
            "arguments: {args:?}"
        );
    }
}
