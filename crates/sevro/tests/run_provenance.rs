use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

const RUNNER_DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    project: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "sevro-rust-provenance-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let project = root.join("project");
        fs::create_dir(&project).unwrap();
        fs::write(project.join("README.md"), "alpha\n").unwrap();
        fs::set_permissions(project.join("README.md"), fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(root.join("auth.json"), "SYNTHETIC_DRY_AUTH").unwrap();
        fs::write(
            root.join("case.json"),
            serde_json::to_vec(&json!({
                "id":"provenance","prompt":"Return ready.",
                "fixture":{"files":{"README.md":"fixture\n"}},
                "checks":[],"requiredEvidence":[]
            }))
            .unwrap(),
        )
        .unwrap();
        Self { root, project }
    }

    fn invoke(&self, extra: &[&str]) -> Output {
        self.invoke_binary(Path::new(env!("CARGO_BIN_EXE_sevro")), extra)
    }

    fn invoke_binary(&self, binary: &Path, extra: &[&str]) -> Output {
        self.invoke_command(Command::new(binary), extra)
    }

    fn invoke_reference(&self, extra: &[&str]) -> Output {
        let mut command = Command::new("bun");
        command.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/cli.ts"));
        self.invoke_command(command, extra)
    }

    fn invoke_command(&self, mut command: Command, extra: &[&str]) -> Output {
        command
            .current_dir(&self.root)
            .args(["run", "--json", "--dry", "--case-file", "case.json"])
            .arg("--project-root")
            .arg(&self.project)
            .arg("--config-root")
            .arg(&self.root)
            .arg("--results-root")
            .arg(self.project.join("results"))
            .args([
                "--host",
                "codex",
                "--model",
                "synthetic",
                "--effort",
                "low",
                "--codex-bin",
                "/bin/true",
                "--codex-auth-file",
                "auth.json",
            ])
            .args(extra)
            .output()
            .unwrap()
    }

    fn git(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.project)
            .args(args)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("LC_ALL", "C")
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
            .env("GIT_AUTHOR_DATE", "2000-01-01T00:00:00Z")
            .env("GIT_COMMITTER_DATE", "2000-01-01T00:00:00Z")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn commit_project(&self) {
        self.git(&[
            "init",
            "--quiet",
            "--initial-branch=main",
            "--object-format=sha1",
        ]);
        self.git(&["config", "core.autocrlf", "false"]);
        self.git(&["config", "core.filemode", "true"]);
        self.git(&["add", "README.md"]);
        self.git(&[
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "Provenance fixture",
        ]);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn evidence(output: &Output) -> Value {
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"]["status"], "not_run");
    assert_eq!(result["task"]["verdict"], "not_assessed");
    serde_json::from_slice(&fs::read(Path::new(result["evidencePath"].as_str().unwrap())).unwrap())
        .unwrap()
}

#[test]
fn derives_non_git_project_identity_without_a_digest_override() {
    let fixture = Fixture::new();
    for _ in 0..2 {
        let retained = evidence(&fixture.invoke(&["--runner-build-digest", RUNNER_DIGEST]));
        assert_eq!(
            retained["project"],
            json!({
                "root":url::Url::from_file_path(&fixture.project).unwrap().as_str(),
                "revision":null,"dirtyPatchDigest":null
            })
        );
        assert_eq!(
            retained["evaluationIdentity"]["dimensions"]["projectDigest"],
            "858d75592df9d4eb600d72b50440c1ca4be9eecd1a8cb7944cd92a6d1b74334f"
        );
        assert_eq!(
            retained["evaluationIdentity"]["dimensions"]["runnerBuildDigest"],
            RUNNER_DIGEST
        );
    }
    assert!(fixture.project.join("results/latest.json").is_file());
    assert_eq!(
        fs::read_to_string(fixture.project.join("README.md")).unwrap(),
        "alpha\n"
    );
}

#[test]
fn git_project_identity_binds_revision_tracked_edits_and_untracked_content() {
    let fixture = Fixture::new();
    fixture.commit_project();
    let revision = "118e3a42e2d7a59b599d2415e33d4a8e2a36e9a1";
    assert_eq!(fixture.git(&["rev-parse", "HEAD"]), revision);
    for (change, dirty, digest) in [
        (
            "clean",
            None,
            "686e923b8f017cb31a9d9adae45155d0ef045e76ddc8fd991eb97648d9d50656",
        ),
        (
            "repeat",
            None,
            "686e923b8f017cb31a9d9adae45155d0ef045e76ddc8fd991eb97648d9d50656",
        ),
        (
            "tracked",
            Some("ae119db73211d4a4b8dc3cd50538fa481f4d8025c21abf21b312929b216b93fe"),
            "c363114d3d29daeb0a4e247296365ff10a9b1b88d631dc6197c4dccb2d17623f",
        ),
        (
            "untracked",
            Some("3d4a58e14d0de01528b8ce68ad0c1050b71c498704bc22772a550b9603538f6b"),
            "4fcfd41d6ce21753081a26457e6d4abbf5bae891603a07be19943577cd7d4a2d",
        ),
    ] {
        match change {
            "tracked" => fs::write(fixture.project.join("README.md"), "beta\n").unwrap(),
            "untracked" => fs::write(fixture.project.join("new.txt"), "untracked\n").unwrap(),
            _ => {}
        }
        let retained = evidence(&fixture.invoke(&["--runner-build-digest", RUNNER_DIGEST]));
        assert_eq!(retained["project"]["revision"], revision, "{change}");
        assert_eq!(
            retained["project"]["dirtyPatchDigest"],
            json!(dirty),
            "{change}"
        );
        assert_eq!(
            retained["evaluationIdentity"]["dimensions"]["projectDigest"], digest,
            "{change}"
        );
        assert_eq!(fixture.git(&["rev-parse", "HEAD"]), revision);
    }
}

#[test]
fn standalone_runner_identity_binds_the_installed_binary_without_overrides() {
    let fixture = Fixture::new();
    let installed = fixture.root.join("installed/sevro");
    fs::create_dir(installed.parent().unwrap()).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_sevro"), &installed).unwrap();
    let receipt = Command::new("python3")
        .args([
            "-c",
            "import hashlib,json,pathlib,sys; binary=hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest(); profile={'format':'sevro.native-build.v1','distribution':'standalone','executableSha256':binary,'assets':[]}; print(hashlib.sha256(json.dumps(profile,sort_keys=True,separators=(',',':')).encode()).hexdigest())",
        ])
        .arg(&installed)
        .output()
        .unwrap();
    assert!(
        receipt.status.success(),
        "{}",
        String::from_utf8_lossy(&receipt.stderr)
    );
    let expected = String::from_utf8(receipt.stdout).unwrap();
    for binary in [Path::new(env!("CARGO_BIN_EXE_sevro")), installed.as_path()] {
        let retained = evidence(&fixture.invoke_binary(binary, &[]));
        assert_eq!(
            retained["runner"],
            json!({
                "source":"package","packageName":"@bjoernrochel/sevro",
                "version":env!("CARGO_PKG_VERSION"),"buildDigest":expected.trim()
            })
        );
        assert_eq!(
            retained["evaluationIdentity"]["dimensions"]["runnerBuildDigest"],
            expected.trim()
        );
        assert_eq!(
            retained["evaluationIdentity"]["dimensions"]["projectDigest"],
            "858d75592df9d4eb600d72b50440c1ca4be9eecd1a8cb7944cd92a6d1b74334f"
        );
    }
}

#[test]
fn non_git_snapshot_ignores_location_and_time_but_tracks_content_and_execute_mode() {
    let first = Fixture::new();
    let second = Fixture::new();
    let args = ["--runner-build-digest", RUNNER_DIGEST];
    let original = evidence(&first.invoke(&args));
    fs::File::open(second.project.join("README.md"))
        .unwrap()
        .set_times(
            fs::FileTimes::new()
                .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(946684800)),
        )
        .unwrap();
    let relocated = evidence(&second.invoke(&args));
    assert_eq!(
        original["evaluationIdentity"]["dimensions"]["projectDigest"],
        relocated["evaluationIdentity"]["dimensions"]["projectDigest"]
    );
    fs::write(second.project.join("README.md"), "beta\n").unwrap();
    for (mode, expected) in [
        (
            0o600,
            "408bebbfa9a236eec6e39c54369b3cfa347f84e851a9cca0286d097997e3cf9b",
        ),
        (
            0o700,
            "761978b0c1e5a05b17349be0d09b687b19188cafd9a8488e90c7a4f51e0a82b5",
        ),
    ] {
        fs::set_permissions(
            second.project.join("README.md"),
            fs::Permissions::from_mode(mode),
        )
        .unwrap();
        let retained = evidence(&second.invoke(&args));
        assert_eq!(
            retained["evaluationIdentity"]["dimensions"]["projectDigest"],
            expected
        );
    }
}

#[test]
fn unborn_repositories_use_content_identity_while_corrupt_git_metadata_refuses() {
    let unborn = Fixture::new();
    unborn.git(&[
        "init",
        "--quiet",
        "--initial-branch=main",
        "--object-format=sha1",
    ]);
    let retained = evidence(&unborn.invoke(&["--runner-build-digest", RUNNER_DIGEST]));
    assert_eq!(retained["project"]["revision"], Value::Null);
    assert_eq!(retained["project"]["dirtyPatchDigest"], Value::Null);
    assert_eq!(
        retained["evaluationIdentity"]["dimensions"]["projectDigest"],
        "858d75592df9d4eb600d72b50440c1ca4be9eecd1a8cb7944cd92a6d1b74334f"
    );

    let corrupt = Fixture::new();
    fs::write(corrupt.project.join(".git"), "not Git metadata\n").unwrap();
    let args = [
        "--runner-build-digest",
        RUNNER_DIGEST,
        "--project-digest",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ];
    for output in [corrupt.invoke_reference(&args), corrupt.invoke(&args)] {
        assert_eq!(output.status.code(), Some(70));
        assert!(String::from_utf8_lossy(&output.stderr).contains("Git identity is unavailable"));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["evidencePath"], Value::Null);
    }
    assert!(!corrupt.project.join("results").exists());
    assert_eq!(
        fs::read_to_string(corrupt.project.join(".git")).unwrap(),
        "not Git metadata\n"
    );
}

#[test]
fn non_git_snapshot_refuses_symlinks_and_fifos_without_modifying_them() {
    use std::os::unix::fs::MetadataExt;

    for kind in ["symbolic link", "non-file"] {
        let fixture = Fixture::new();
        let unsafe_path = fixture.project.join("unsafe");
        if kind == "symbolic link" {
            std::os::unix::fs::symlink("README.md", &unsafe_path).unwrap();
        } else {
            assert!(
                Command::new("mkfifo")
                    .arg(&unsafe_path)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let before = fs::symlink_metadata(&unsafe_path).unwrap();
        let args = ["--runner-build-digest", RUNNER_DIGEST];
        for output in [fixture.invoke_reference(&args), fixture.invoke(&args)] {
            assert_eq!(output.status.code(), Some(70), "{kind}");
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .contains(&format!("project snapshot contains a {kind}"))
            );
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result["evidencePath"], Value::Null);
        }
        assert!(!fixture.project.join("results").exists());
        let after = fs::symlink_metadata(&unsafe_path).unwrap();
        assert_eq!(after.ino(), before.ino());
        assert_eq!(after.mode(), before.mode());
        assert_eq!(
            fs::read_to_string(fixture.project.join("README.md")).unwrap(),
            "alpha\n"
        );
    }
}

#[test]
fn non_git_snapshot_enforces_file_and_byte_limits_without_replacing_latest() {
    for limit in ["files", "bytes"] {
        let fixture = Fixture::new();
        let boundary = fixture.project.join("boundary");
        if limit == "files" {
            fs::create_dir(&boundary).unwrap();
            for index in 0..4095 {
                fs::write(boundary.join(index.to_string()), []).unwrap();
            }
        } else {
            fs::File::create(&boundary)
                .unwrap()
                .set_len(64 * 1024 * 1024 - 6)
                .unwrap();
        }
        evidence(&fixture.invoke(&["--runner-build-digest", RUNNER_DIGEST]));
        let latest = fs::read(fixture.project.join("results/latest.json")).unwrap();
        if limit == "files" {
            fs::write(boundary.join("4095"), []).unwrap();
        } else {
            fs::OpenOptions::new()
                .write(true)
                .open(&boundary)
                .unwrap()
                .set_len(64 * 1024 * 1024 - 5)
                .unwrap();
        }
        let args = ["--runner-build-digest", RUNNER_DIGEST];
        for output in [fixture.invoke_reference(&args), fixture.invoke(&args)] {
            assert_eq!(output.status.code(), Some(70), "{limit}");
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .contains("project snapshot exceeds the size limit")
            );
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result["evidencePath"], Value::Null);
        }
        assert_eq!(
            fs::read(fixture.project.join("results/latest.json")).unwrap(),
            latest
        );
        assert_eq!(
            fs::read_to_string(fixture.project.join("README.md")).unwrap(),
            "alpha\n"
        );
        if limit == "files" {
            assert_eq!(fs::read_dir(boundary).unwrap().count(), 4096);
        } else {
            assert_eq!(fs::metadata(boundary).unwrap().len(), 64 * 1024 * 1024 - 5);
        }
    }
}

#[test]
fn explicit_digest_overrides_take_priority_without_replacing_real_git_provenance() {
    let fixture = Fixture::new();
    fixture.commit_project();
    fs::write(fixture.project.join("README.md"), "beta\n").unwrap();
    let override_digest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let runner_override = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    let retained = evidence(&fixture.invoke(&[
        "--runner-build-digest",
        RUNNER_DIGEST,
        "--runner-build-digest",
        runner_override,
        "--project-digest",
        override_digest,
    ]));
    assert_eq!(retained["runner"]["buildDigest"], runner_override);
    assert_eq!(
        retained["evaluationIdentity"]["dimensions"]["runnerBuildDigest"],
        runner_override
    );
    assert_eq!(
        retained["evaluationIdentity"]["dimensions"]["projectDigest"],
        override_digest
    );
    assert_eq!(
        retained["project"]["revision"],
        "118e3a42e2d7a59b599d2415e33d4a8e2a36e9a1"
    );
    assert_eq!(
        retained["project"]["dirtyPatchDigest"],
        "ae119db73211d4a4b8dc3cd50538fa481f4d8025c21abf21b312929b216b93fe"
    );
}

#[test]
fn unicode_project_paths_match_the_existing_utf16_ordering_vectors() {
    for (with_git, expected) in [
        (
            false,
            "9ecbe453e970f9db8253ed1d6846f7812f558ea7144e147d58c00625da779afa",
        ),
        (
            true,
            "576ae43551076788967c0756de9e3a4b66c73daeab43dfc34778165b2cc824cc",
        ),
    ] {
        let fixture = Fixture::new();
        if with_git {
            fixture.commit_project();
        }
        fs::write(fixture.project.join("\u{e000}.txt"), "private\n").unwrap();
        fs::write(fixture.project.join("😀.txt"), "face\n").unwrap();
        let retained = evidence(&fixture.invoke(&["--runner-build-digest", RUNNER_DIGEST]));
        assert_eq!(
            retained["evaluationIdentity"]["dimensions"]["projectDigest"],
            expected
        );
        if with_git {
            assert_eq!(
                retained["project"]["dirtyPatchDigest"],
                "9efa7db3f392a450be216dbf0d228533e8e8e316caa9531d819e7afc57c547c2"
            );
        }
    }
}

#[test]
fn tracked_files_inside_selected_storage_still_change_git_identity() {
    let fixture = Fixture::new();
    fixture.commit_project();
    fs::create_dir(fixture.project.join("results")).unwrap();
    fs::write(fixture.project.join("results/tracked.txt"), "original\n").unwrap();
    fixture.git(&["add", "results/tracked.txt"]);
    fixture.git(&[
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "Tracked storage fixture",
    ]);
    let args = ["--runner-build-digest", RUNNER_DIGEST];
    let first = evidence(&fixture.invoke(&args));
    let repeated = evidence(&fixture.invoke(&args));
    assert_eq!(first["project"]["dirtyPatchDigest"], Value::Null);
    assert_eq!(repeated["project"]["dirtyPatchDigest"], Value::Null);
    assert_eq!(
        first["evaluationIdentity"]["dimensions"]["projectDigest"],
        repeated["evaluationIdentity"]["dimensions"]["projectDigest"]
    );
    fs::write(fixture.project.join("results/tracked.txt"), "changed\n").unwrap();
    let changed = evidence(&fixture.invoke(&args));
    assert_ne!(changed["project"]["dirtyPatchDigest"], Value::Null);
    assert_eq!(changed["project"]["revision"], first["project"]["revision"]);
    assert_ne!(
        changed["evaluationIdentity"]["dimensions"]["projectDigest"],
        first["evaluationIdentity"]["dimensions"]["projectDigest"]
    );
    assert_eq!(
        fs::read_to_string(fixture.project.join("results/tracked.txt")).unwrap(),
        "changed\n"
    );
}

#[test]
fn untracked_git_symlinks_hash_the_target_text_without_following_it() {
    let fixture = Fixture::new();
    fixture.commit_project();
    fs::write(fixture.root.join("target"), "first outside bytes\n").unwrap();
    let link = fixture.project.join("link");
    std::os::unix::fs::symlink("../target", &link).unwrap();
    let args = ["--runner-build-digest", RUNNER_DIGEST];
    let mut observed = Vec::new();
    for step in 0..3 {
        if step == 1 {
            fs::write(fixture.root.join("target"), "changed outside bytes\n").unwrap();
        }
        if step == 2 {
            fs::remove_file(&link).unwrap();
            std::os::unix::fs::symlink("../other-target", &link).unwrap();
        }
        let baseline = evidence(&fixture.invoke_reference(&args));
        let retained = evidence(&fixture.invoke(&args));
        assert_eq!(retained["project"], baseline["project"]);
        let digest = retained["evaluationIdentity"]["dimensions"]["projectDigest"].clone();
        assert_eq!(
            digest,
            baseline["evaluationIdentity"]["dimensions"]["projectDigest"]
        );
        observed.push(digest);
    }
    assert_eq!(observed[0], observed[1]);
    assert_ne!(observed[1], observed[2]);
    assert_eq!(fs::read_link(&link).unwrap(), Path::new("../other-target"));
    assert_eq!(
        fs::read_to_string(fixture.root.join("target")).unwrap(),
        "changed outside bytes\n"
    );
}

#[test]
fn oversized_git_patch_and_untracked_bytes_refuse_without_changing_the_project() {
    for tracked in [true, false] {
        let fixture = Fixture::new();
        fixture.commit_project();
        let path = fixture
            .project
            .join(if tracked { "README.md" } else { "large.bin" });
        let mut bytes = vec![if tracked { b'x' } else { 0 }; 32 * 1024 * 1024 + 1];
        if tracked {
            *bytes.last_mut().unwrap() = b'\n';
        }
        fs::write(&path, &bytes).unwrap();
        let status = fixture.git(&["status", "--porcelain=v1"]);
        let revision = fixture.git(&["rev-parse", "HEAD"]);
        let args = ["--runner-build-digest", RUNNER_DIGEST];
        for output in [fixture.invoke_reference(&args), fixture.invoke(&args)] {
            assert_eq!(
                output.status.code(),
                Some(70),
                "tracked={tracked}: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .contains("Git identity exceeds the size limit")
            );
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result["evidencePath"], Value::Null);
        }
        assert_eq!(fixture.git(&["status", "--porcelain=v1"]), status);
        assert_eq!(fixture.git(&["rev-parse", "HEAD"]), revision);
        assert_eq!(fs::read(path).unwrap(), bytes);
        assert!(!fixture.project.join("results").exists());
    }
}

#[test]
fn unreadable_project_files_and_directories_preserve_prior_evidence() {
    for directory in [false, true] {
        let fixture = Fixture::new();
        let args = ["--runner-build-digest", RUNNER_DIGEST];
        evidence(&fixture.invoke(&args));
        let latest = fs::read(fixture.project.join("results/latest.json")).unwrap();
        let inaccessible = fixture.project.join("private");
        if directory {
            fs::create_dir(&inaccessible).unwrap();
            fs::write(inaccessible.join("content"), "private content\n").unwrap();
        } else {
            fs::write(&inaccessible, "private content\n").unwrap();
        }
        fs::set_permissions(&inaccessible, fs::Permissions::from_mode(0o000)).unwrap();
        let outputs = [fixture.invoke_reference(&args), fixture.invoke(&args)];
        assert_eq!(
            fs::metadata(&inaccessible).unwrap().permissions().mode() & 0o777,
            0
        );
        fs::set_permissions(&inaccessible, fs::Permissions::from_mode(0o700)).unwrap();
        for output in outputs {
            assert_eq!(
                output.status.code(),
                Some(70),
                "directory={directory}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result["evidencePath"], Value::Null);
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .to_lowercase()
                    .contains("permission denied")
            );
        }
        assert_eq!(
            fs::read(fixture.project.join("results/latest.json")).unwrap(),
            latest
        );
        let content = if directory {
            inaccessible.join("content")
        } else {
            inaccessible
        };
        assert_eq!(fs::read_to_string(content).unwrap(), "private content\n");
    }
}

#[test]
fn redirected_git_worktree_refuses_even_with_digest_override() {
    let fixture = Fixture::new();
    fixture.commit_project();
    let other = fixture.root.join("other-worktree");
    fs::create_dir(&other).unwrap();
    fs::write(other.join("outside"), "outside content\n").unwrap();
    fixture.git(&["config", "core.worktree", other.to_str().unwrap()]);
    let configuration = fs::read(fixture.project.join(".git/config")).unwrap();
    let head = fs::read(fixture.project.join(".git/HEAD")).unwrap();
    for override_digest in [false, true] {
        let mut args = vec!["--runner-build-digest", RUNNER_DIGEST];
        if override_digest {
            args.extend(["--project-digest", RUNNER_DIGEST]);
        }
        for output in [fixture.invoke_reference(&args), fixture.invoke(&args)] {
            assert_eq!(
                output.status.code(),
                Some(70),
                "override={override_digest}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .contains("project Git root does not match its repository entry")
            );
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result["evidencePath"], Value::Null);
        }
    }
    assert_eq!(
        fs::read(fixture.project.join(".git/config")).unwrap(),
        configuration
    );
    assert_eq!(fs::read(fixture.project.join(".git/HEAD")).unwrap(), head);
    assert_eq!(
        fs::read_to_string(other.join("outside")).unwrap(),
        "outside content\n"
    );
    assert!(!fixture.project.join("results").exists());
}

#[test]
fn unreadable_git_metadata_and_untracked_files_refuse_without_changes() {
    for metadata in [true, false] {
        let fixture = Fixture::new();
        fixture.commit_project();
        let private = fixture.project.join("private");
        fs::write(&private, "private content\n").unwrap();
        let restricted = if metadata { &fixture.project } else { &private };
        fs::set_permissions(
            restricted,
            fs::Permissions::from_mode(if metadata { 0o400 } else { 0o000 }),
        )
        .unwrap();
        let storage = fixture.root.join("evidence");
        let runtime = fixture.root.join("runtime.json");
        fs::write(&runtime, r#"{"format":"sevro.runtime.v1"}"#).unwrap();
        let args = [
            "--runner-build-digest",
            RUNNER_DIGEST,
            "--results-root",
            storage.to_str().unwrap(),
            "--runtime-config-file",
            runtime.to_str().unwrap(),
        ];
        let outputs = [fixture.invoke_reference(&args), fixture.invoke(&args)];
        fs::set_permissions(restricted, fs::Permissions::from_mode(0o700)).unwrap();
        for output in outputs {
            assert_eq!(
                output.status.code(),
                Some(70),
                "metadata={metadata}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result["evidencePath"], Value::Null);
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .to_lowercase()
                    .contains("permission denied")
            );
        }
        assert_eq!(
            fixture.git(&["rev-parse", "HEAD"]),
            "118e3a42e2d7a59b599d2415e33d4a8e2a36e9a1"
        );
        assert_eq!(fs::read_to_string(private).unwrap(), "private content\n");
        assert!(!storage.exists());
    }
}

#[test]
fn untracked_nested_git_repository_refuses_without_reading_its_contents() {
    let fixture = Fixture::new();
    fixture.commit_project();
    let nested = fixture.project.join("nested");
    fs::create_dir(&nested).unwrap();
    fixture.git(&["init", "--quiet", "--initial-branch=main", "nested"]);
    fs::write(nested.join("content"), "nested repository\n").unwrap();
    assert_eq!(
        fixture.git(&["ls-files", "--others", "--exclude-standard"]),
        "nested/"
    );
    let args = ["--runner-build-digest", RUNNER_DIGEST];
    for output in [fixture.invoke_reference(&args), fixture.invoke(&args)] {
        assert_eq!(
            output.status.code(),
            Some(70),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("Git checkout has an unsupported untracked entry")
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["evidencePath"], Value::Null);
    }
    assert_eq!(
        fs::read_to_string(nested.join("content")).unwrap(),
        "nested repository\n"
    );
    assert!(nested.join(".git/HEAD").is_file());
    assert!(!fixture.project.join("results").exists());
}

#[test]
fn git_uses_the_system_path_default_and_refuses_an_explicit_path_without_git() {
    let fixture = Fixture::new();
    fixture.commit_project();
    let bun = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|directory| directory.join("bun"))
        .find(|path| path.is_file())
        .map(|path| fs::canonicalize(path).unwrap())
        .expect("Bun reference CLI is installed");
    let empty_path = fixture.root.join("empty-bin");
    fs::create_dir(&empty_path).unwrap();
    let args = ["--runner-build-digest", RUNNER_DIGEST];
    for missing_git in [false, true] {
        let mut reference = Command::new(&bun);
        reference.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/cli.ts"));
        for mut command in [reference, Command::new(env!("CARGO_BIN_EXE_sevro"))] {
            if missing_git {
                command.env("PATH", &empty_path);
            } else {
                command.env_remove("PATH");
            }
            let output = fixture.invoke_command(command, &args);
            if missing_git {
                assert_eq!(
                    output.status.code(),
                    Some(70),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                assert!(
                    String::from_utf8_lossy(&output.stderr)
                        .to_lowercase()
                        .contains("git")
                );
                let result: Value = serde_json::from_slice(&output.stdout).unwrap();
                assert_eq!(result["evidencePath"], Value::Null);
            } else {
                let retained = evidence(&output);
                assert_eq!(
                    retained["evaluationIdentity"]["dimensions"]["projectDigest"],
                    "686e923b8f017cb31a9d9adae45155d0ef045e76ddc8fd991eb97648d9d50656"
                );
            }
        }
    }
    assert_eq!(
        fixture.git(&["rev-parse", "HEAD"]),
        "118e3a42e2d7a59b599d2415e33d4a8e2a36e9a1"
    );
    assert_eq!(
        fs::read_to_string(fixture.project.join("README.md")).unwrap(),
        "alpha\n"
    );
}

#[test]
fn temporary_git_metadata_is_ignored_only_for_an_empty_directory_on_linux() {
    for kind in ["empty directory", "nonempty directory", "file"] {
        let fixture = Fixture::new();
        let metadata = fixture.root.join(".git");
        if kind == "file" {
            fs::write(&metadata, "invalid Git metadata\n").unwrap();
        } else {
            fs::create_dir(&metadata).unwrap();
            if kind == "nonempty directory" {
                fs::write(metadata.join("sentinel"), "preserve metadata\n").unwrap();
            }
        }
        let mut reference = Command::new("bun");
        reference.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/cli.ts"));
        for mut command in [reference, Command::new(env!("CARGO_BIN_EXE_sevro"))] {
            command.env("TMPDIR", &fixture.root);
            let output = fixture.invoke_command(command, &["--runner-build-digest", RUNNER_DIGEST]);
            if cfg!(target_os = "linux") && kind == "empty directory" {
                let retained = evidence(&output);
                assert_eq!(retained["project"]["revision"], Value::Null);
                assert_eq!(retained["project"]["dirtyPatchDigest"], Value::Null);
                assert_eq!(
                    retained["evaluationIdentity"]["dimensions"]["projectDigest"],
                    "858d75592df9d4eb600d72b50440c1ca4be9eecd1a8cb7944cd92a6d1b74334f"
                );
            } else {
                assert_eq!(
                    output.status.code(),
                    Some(70),
                    "{kind}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                assert!(
                    String::from_utf8_lossy(&output.stderr).contains("Git identity is unavailable")
                );
                let result: Value = serde_json::from_slice(&output.stdout).unwrap();
                assert_eq!(result["evidencePath"], Value::Null);
                assert!(!fixture.project.join("results").exists());
            }
        }
        match kind {
            "file" => assert_eq!(
                fs::read_to_string(metadata).unwrap(),
                "invalid Git metadata\n"
            ),
            "nonempty directory" => assert_eq!(
                fs::read_to_string(metadata.join("sentinel")).unwrap(),
                "preserve metadata\n"
            ),
            _ => assert_eq!(fs::read_dir(metadata).unwrap().count(), 0),
        }
        assert_eq!(
            fs::read_to_string(fixture.project.join("README.md")).unwrap(),
            "alpha\n"
        );
    }
}
