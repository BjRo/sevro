use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use uuid::Uuid;

#[path = "run_repository/isolation.rs"]
mod isolation;
#[path = "run_repository/overlay.rs"]
mod overlay;
#[path = "run_repository/preparation.rs"]
mod preparation;
#[path = "run_repository/preparation_edges.rs"]
mod preparation_edges;
#[path = "run_repository/preparation_mutation.rs"]
mod preparation_mutation;

struct RepositoryFixture {
    root: PathBuf,
    source: PathBuf,
}

impl RepositoryFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("sevro-rust-repository-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let source = root.join("sources/example");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir(root.join("tmp")).unwrap();
        fs::write(source.join("README.md"), "repository fixture\n").unwrap();
        git(&source, &["init", "--quiet", "--initial-branch=main"]);
        git(&source, &["add", "README.md"]);
        git(
            &source,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "Create fixture",
            ],
        );
        fs::write(
            root.join("native"),
            "#!/bin/sh\nprintf invoked >> \"$SEVRO_NATIVE_MARKER\"\nexit 98\n",
        )
        .unwrap();
        fs::set_permissions(root.join("native"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("auth.json"), "PRIVATE_DRY_CREDENTIAL").unwrap();
        write_json(
            &root.join("case.json"),
            &json!({
                "id":"repository-dry", "prompt":"Return ready.",
                "fixture":{"sourceRef":"fixture-repo"},
                "checks":[{"id":"answer","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
                "requiredEvidence":["example.receipt"]
            }),
        );
        write_json(
            &root.join("source-map.json"),
            &json!({
                "fixture-repo":url::Url::from_file_path(&source).unwrap().as_str()
            }),
        );
        Self { root, source }
    }

    fn invoke(&self) -> Output {
        self.invoke_source(&["--case-file", "case.json"])
    }

    fn invoke_source(&self, source_arguments: &[&str]) -> Output {
        self.command(source_arguments).output().unwrap()
    }

    fn command(&self, source_arguments: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_sevro"));
        command
            .current_dir(&self.root)
            .env("TMPDIR", self.root.join("tmp"))
            .env("SEVRO_NATIVE_MARKER", self.root.join("native-invocations"))
            .env("SEVRO_SETUP_PRIVATE_MARKER", "must-not-reach-setup")
            .args([
                "run",
                "--json",
                "--dry",
                "--host",
                "codex",
                "--codex-bin",
                "./native",
                "--codex-auth-file",
                "auth.json",
                "--model",
                "synthetic",
                "--effort",
                "low",
                "--runner-build-digest",
            ])
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64))
            .arg("--case-source-root")
            .arg(self.root.join("sources"))
            .args(["--case-source-map-file", "source-map.json"])
            .args(source_arguments);
        command
    }

    fn setup_extension(&self, command: &str) {
        self.setup_extension_with_fixture(
            command,
            json!({"kind":"repository","sourceRef":"fixture-repo"}),
        );
    }

    fn setup_extension_with_fixture(&self, command: &str, fixture: Value) {
        self.extension(
            fixture,
            json!({
                "artifacts":[],"requestedInstrumentation":[],"extensionData":{},
                "fixtureSetup":{"command":["/bin/sh","-c",command],"environment":{
                    "PROJECT_ROOT":"{{sevro.project}}","WORKSPACE":"{{sevro.workspace}}"
                }}
            }),
            json!(["sevro.fixture.setup"]),
        );
    }

    fn extension(&self, fixture: Value, preparation: Value, required_capabilities: Value) {
        let results = json!({
            "describe":{
                "extension":{"id":"example.setup","version":"1.0.0"},
                "protocols":["sevro.extension.v1"],"requiredCapabilities":required_capabilities,
                "optionalCapabilities":[],"graders":[],"taskVerdictPolicies":[]
            },
            "resolve":{"cases":[{
                "id":"repository-setup","prompt":"Return ready.",
                "fixture":fixture,
                "checks":[],"requiredEvidence":[],"extensionData":{}
            }]},
            "prepare":preparation,
            "evaluate":{"checks":[],"metrics":[]}
        });
        let program = format!(
            "import {{ readFileSync }} from 'node:fs';\nconst request=JSON.parse(readFileSync(0,'utf8'));\nconst results={results};\nprocess.stdout.write(JSON.stringify({{protocol:request.protocol,id:request.id,method:request.method,result:results[request.method]}}));\n"
        );
        fs::write(self.root.join("setup-extension.mjs"), program).unwrap();
        fs::write(
            self.root.join("setup-extension"),
            "#!/bin/sh\nexec node \"$@\"\n",
        )
        .unwrap();
        fs::set_permissions(
            self.root.join("setup-extension"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        write_json(
            &self.root.join("setup-command.json"),
            &json!([
                self.root.join("setup-extension"),
                self.root.join("setup-extension.mjs")
            ]),
        );
    }
}

#[test]
fn retains_verified_preparation_artifacts_after_fixture_cleanup() {
    let fixture = RepositoryFixture::new();
    fixture.extension(
        json!({"kind":"repository","sourceRef":"fixture-repo"}),
        json!({"artifacts":[{
            "id":"generated-file","relativePath":"generated/data.txt",
            "sha256":"738fb5667d1f1ac841e87be5a842e667ef9ff77e7f06f59141a7d59c4caa5d8f",
            "contentBase64":"cHJlcGFyZWQgZGF0YQo="
        }],"requestedInstrumentation":[],"extensionData":{}}),
        json!([]),
    );
    let output = fixture.invoke_source(&[
        "--extension-command-file",
        "setup-command.json",
        "--extension-source-file",
        "setup-extension.mjs",
        "--case-id",
        "repository-setup",
    ]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"not_run"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    let evidence: Value =
        serde_json::from_slice(&fs::read(result["evidencePath"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!(evidence["result"], result);
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        "4af1116098c1b2b6cf843d7b1fefffbdf495faeddd21a887c51c2847435ca18c"
    );
    let artifacts = evidence["trials"][0]["artifactRefs"].as_array().unwrap();
    assert_eq!(artifacts.len(), 1);
    let artifact = &artifacts[0];
    assert_eq!(artifact["id"], "generated-file");
    assert_eq!(
        artifact["sha256"],
        "738fb5667d1f1ac841e87be5a842e667ef9ff77e7f06f59141a7d59c4caa5d8f"
    );
    assert_eq!(artifact.as_object().unwrap().len(), 3);
    let retained = url::Url::parse(artifact["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(&retained).unwrap(), b"prepared data\n");
    assert_eq!(
        fs::metadata(&retained).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let workspace = evidence["trials"][0]["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert!(!Path::new(workspace["data"]["candidate"].as_str().unwrap()).exists());
    assert!(!fixture.source.join("generated").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert!(!fixture.root.join("native-invocations").exists());
}

#[test]
fn refuses_preparation_artifact_mount_through_a_setup_symlink() {
    let fixture = RepositoryFixture::new();
    let outside = fixture.root.join("artifact-outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("sentinel.txt"), "outside remains unchanged\n").unwrap();
    fixture.extension(
        json!({"kind":"repository","sourceRef":"fixture-repo"}),
        json!({"artifacts":[{
            "id":"generated-file","relativePath":"generated/data.txt",
            "sha256":"738fb5667d1f1ac841e87be5a842e667ef9ff77e7f06f59141a7d59c4caa5d8f",
            "contentBase64":"cHJlcGFyZWQgZGF0YQo="
        }],"requestedInstrumentation":[],"extensionData":{},"fixtureSetup":{
            "command":["/bin/sh","-c","ln -s \"$PROJECT_ROOT/artifact-outside\" generated"],
            "environment":{"PROJECT_ROOT":"{{sevro.project}}"}
        }}),
        json!(["sevro.fixture.setup"]),
    );
    let output = fixture.invoke_source(&[
        "--extension-command-file",
        "setup-command.json",
        "--extension-source-file",
        "setup-extension.mjs",
        "--case-id",
        "repository-setup",
    ]);
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,"execution":{"status":"not_run"},
            "grading":{"status":"not_requested"},"task":{"verdict":"not_assessed"},
            "exitCode":70,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.runner.error","message":"preparation artifact traverses a non-directory"}
        })
    );
    assert_eq!(
        fs::read_to_string(outside.join("sentinel.txt")).unwrap(),
        "outside remains unchanged\n"
    );
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
    assert!(!outside.join("data.txt").exists());
    assert!(!fixture.source.join("generated").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert_eq!(
        git(&fixture.source, &["rev-parse", "HEAD"]),
        "f4d351b20b90e67f9e9092777856c0135110b023"
    );
    assert!(!fixture.root.join("native-invocations").exists());
}

#[test]
fn applies_repository_overlays_before_successful_setup() {
    let fixture = RepositoryFixture::new();
    fixture.setup_extension_with_fixture(
        r#"set -eu
printf 'overlay fixture\n' | cmp - README.md
printf 'untracked\n' | cmp - notes.txt
git show HEAD:README.md | cmp - "$PROJECT_ROOT/sources/example/README.md"
[ "$(git rev-parse HEAD)" = f4d351b20b90e67f9e9092777856c0135110b023 ]
[ "$(git status --porcelain=v1)" = " M README.md
?? notes.txt" ]
[ -z "$(git diff --cached --name-only)" ]
[ -z "$(git remote)" ]
[ "$WORKSPACE" = "$PWD" ]
"#,
        json!({"kind":"repository","sourceRef":"fixture-repo","files":{
            "README.md":"overlay fixture\n","notes.txt":"untracked\n"
        }}),
    );
    let output = fixture.invoke_source(&[
        "--extension-command-file",
        "setup-command.json",
        "--extension-source-file",
        "setup-extension.mjs",
        "--case-id",
        "repository-setup",
    ]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"not_run"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    let evidence: Value =
        serde_json::from_slice(&fs::read(result["evidencePath"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!(evidence["result"], result);
    // Literal public values independently captured from the TypeScript CLI.
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        "d604b549559c9da8ac43b088070af0054fe7e406733b7025dc54bf48da3632ab"
    );
    assert_eq!(
        evidence["configuration"]["redacted"]["fixtureSetupDigest"],
        "9c0c5eccb42cbb37dc54786f8f0e13b06aef21f8a21335008754881e349316f6"
    );
    assert!(
        evidence["configuration"]["redacted"]
            .get("fixtureSetup")
            .is_none()
    );
    let workspace = evidence["trials"][0]["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert!(!Path::new(workspace["data"]["candidate"].as_str().unwrap()).exists());
    assert!(!fixture.root.join("native-invocations").exists());
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "repository fixture\n"
    );
    assert!(!fixture.source.join("notes.txt").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert_eq!(
        git(&fixture.source, &["rev-parse", "HEAD"]),
        "f4d351b20b90e67f9e9092777856c0135110b023"
    );
}

#[test]
fn refuses_repository_overlay_through_a_committed_symlink() {
    let fixture = RepositoryFixture::new();
    let outside = fixture.root.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("sentinel.txt"), "outside remains unchanged\n").unwrap();
    std::os::unix::fs::symlink(&outside, fixture.source.join("shortcut")).unwrap();
    git(&fixture.source, &["add", "shortcut"]);
    git(
        &fixture.source,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "Add external shortcut",
        ],
    );
    let original_revision = git(&fixture.source, &["rev-parse", "HEAD"]);
    let mut case: Value =
        serde_json::from_slice(&fs::read(fixture.root.join("case.json")).unwrap()).unwrap();
    case["fixture"]["files"] = json!({"shortcut/owned.txt":"must not escape\n"});
    write_json(&fixture.root.join("case.json"), &case);
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,"execution":{"status":"not_run"},
            "grading":{"status":"not_requested"},"task":{"verdict":"not_assessed"},
            "exitCode":70,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.runner.error","message":"repository fixture overlay traverses a non-directory"}
        })
    );
    assert_eq!(
        fs::read_to_string(outside.join("sentinel.txt")).unwrap(),
        "outside remains unchanged\n"
    );
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
    assert!(!outside.join("owned.txt").exists());
    assert_eq!(
        fs::read_link(fixture.source.join("shortcut")).unwrap(),
        outside
    );
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "repository fixture\n"
    );
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert_eq!(
        git(&fixture.source, &["rev-parse", "HEAD"]),
        original_revision
    );
    assert!(!fixture.root.join("native-invocations").exists());
}

impl Drop for RepositoryFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn write_json(path: &Path, value: &Value) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

fn git(root: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Sevro Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@sevro.invalid")
        .env("GIT_COMMITTER_NAME", "Sevro Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@sevro.invalid")
        .env("GIT_AUTHOR_DATE", "2000-01-01T00:00:00+00:00")
        .env("GIT_COMMITTER_DATE", "2000-01-01T00:00:00+00:00")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}

#[test]
fn prepares_clean_repository_dry_run() {
    let fixture = RepositoryFixture::new();
    // This commit and these public identity values were captured from the
    // baseline TypeScript CLI before changing the Rust implementation.
    assert_eq!(
        git(&fixture.source, &["rev-parse", "HEAD"]),
        "f4d351b20b90e67f9e9092777856c0135110b023"
    );
    let output = fixture.invoke();
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
    assert_eq!(result["execution"], json!({"status":"not_run"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    assert_eq!(result["exitCode"], 0);
    assert_eq!(result["cases"][0]["caseId"], "repository-dry");
    assert_eq!(result["cases"][0]["trials"][0]["checks"], json!([]));
    let evidence: Value =
        serde_json::from_slice(&fs::read(result["evidencePath"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!(evidence["result"], result);
    let dimensions = &evidence["evaluationIdentity"]["dimensions"];
    assert_eq!(
        dimensions["caseDigest"],
        "f7d9eabd83eb5c418f6f1f634b2b1a28552c83b2853984deb6b6244080eb60c5"
    );
    assert_eq!(
        dimensions["fixtureDigest"],
        "9af59f403dd73fd49ba50280345e50e0746c6cffd4a75f4872365e2865e1aa19"
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["caseSourceMapping"],
        true
    );
    assert_eq!(evidence["trials"][0]["executionMode"], "dry");
    assert_eq!(evidence["trials"][0]["artifactRefs"], json!([]));
    let workspace = evidence["trials"][0]["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert!(!Path::new(workspace["data"]["candidate"].as_str().unwrap()).exists());
    assert!(!fixture.root.join("native-invocations").exists());
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "repository fixture\n"
    );
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert_eq!(
        git(&fixture.source, &["rev-parse", "HEAD"]),
        "f4d351b20b90e67f9e9092777856c0135110b023"
    );
}

#[test]
fn runs_negotiated_setup_in_the_materialized_repository() {
    let fixture = RepositoryFixture::new();
    // The baseline CLI reports 17 only after this trusted setup observes the
    // actual clone. Every failed condition exits before that distinct sentinel.
    fixture.setup_extension(
        r#"set -eu
printf 'repository fixture\n' | cmp - README.md
git show HEAD:README.md | cmp - README.md
[ "$(git rev-parse HEAD)" = f4d351b20b90e67f9e9092777856c0135110b023 ]
[ -z "$(git status --porcelain=v1)" ]
[ -z "$(git remote)" ]
if git symbolic-ref -q HEAD; then exit 18; fi
[ "$WORKSPACE" = "$PWD" ]
[ "$PROJECT_ROOT/sources/example" != "$PWD" ]
[ "$HOME" = "$TMPDIR" ]
[ -z "${SEVRO_SETUP_PRIVATE_MARKER:-}" ]
exit 17
"#,
    );
    let output = fixture.invoke_source(&[
        "--extension-command-file",
        "setup-command.json",
        "--extension-source-file",
        "setup-extension.mjs",
        "--case-id",
        "repository-setup",
    ]);
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,"execution":{"status":"not_run"},
            "grading":{"status":"not_requested"},"task":{"verdict":"not_assessed"},
            "exitCode":70,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.runner.error","message":"fixture setup failed (17)"}
        })
    );
    assert!(!fixture.root.join("native-invocations").exists());
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "repository fixture\n"
    );
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert_eq!(
        git(&fixture.source, &["rev-parse", "HEAD"]),
        "f4d351b20b90e67f9e9092777856c0135110b023"
    );
}
#[path = "run_repository/artifacts.rs"]
mod artifacts;
#[path = "run_repository/boundaries.rs"]
mod boundaries;
#[path = "run_repository/setup.rs"]
mod setup;
