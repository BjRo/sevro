use super::{RepositoryFixture, git};
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const TOOL: &str = "#!/bin/sh\nprintf 'fixture tool\\n'\n";
const DECOY: &str = "#!/bin/sh\nprintf 'caller tool\\n'\n";
const SETUP: &str = r#"set -eu
[ "$(command -v fixture-probe)" = "$WORKSPACE/.git/fixture-bin/fixture-probe" ]
[ "$(fixture-probe)" = "fixture tool" ]
node -e 'const fs = require("node:fs");
const cp = require("node:child_process");
const path = require("node:path");
const workspace = process.cwd();
const directory = path.join(workspace,".git/fixture-bin");
const target = path.join(directory,"fixture-probe");
const git=(...args)=>cp.execFileSync("git",args,{encoding:"utf8"}).trim();
const receipt={
  firstPathEntry:path.relative(workspace,process.env.PATH.split(path.delimiter)[0]),
  toolContents:fs.readFileSync(target,"utf8"),
  toolMode:fs.statSync(target).mode&0o777,
  directoryMode:fs.statSync(directory).mode&0o777,
  output:cp.execFileSync("fixture-probe",[],{encoding:"utf8"}),
  head:git("rev-parse","HEAD"),
  status:git("status","--porcelain=v1"),
  committed:cp.execFileSync("git",["show","HEAD:README.md"],{encoding:"utf8"})
};
fs.writeFileSync(path.join(process.env.PROJECT_ROOT,"setup-bin-receipt.json"),JSON.stringify(receipt));'
"#;

fn invoke_bin(fixture: &RepositoryFixture, bin: Value, setup: &str) -> Output {
    fixture.setup_extension_with_fixture(
        setup,
        json!({
            "kind":"generated",
            "commits":[{"message":"chore: initialize","files":{"README.md":"fixture\n"}}],
            "bin":bin
        }),
    );
    fixture
        .command(&[
            "--extension-command-file",
            "setup-command.json",
            "--extension-source-file",
            "setup-extension.mjs",
            "--case-id",
            "repository-setup",
            "--results-root",
            "results",
        ])
        .output()
        .unwrap()
}

#[test]
fn refuses_escaping_executable_names_before_run_admission() {
    let fixture = RepositoryFixture::new();
    let output = invoke_bin(
        &fixture,
        json!({"../escape":"must remain uninstalled\n"}),
        "exit 0",
    );
    assert_eq!(
        output.status.code(),
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        super::boundaries::failure(
            64,
            "invalid resolved case file: fixture: invalid fixture binaries; correct the fixture declaration"
        )
    );
    assert!(!fixture.root.join("results").exists());
    assert!(!fixture.root.join("native-invocations").exists());
    assert!(!fixture.root.join("escape").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
}

fn dry_evidence(output: &Output) -> Value {
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
    evidence
}

#[test]
fn accepts_sixty_four_executables_and_refuses_the_next_at_the_protocol_boundary() {
    for count in [64, 65] {
        let fixture = RepositoryFixture::new();
        let bin = Value::Object(
            (0..count)
                .map(|index| (format!("tool-{index:03}"), json!("#!/bin/sh\nexit 0\n")))
                .collect(),
        );
        let output = invoke_bin(
            &fixture,
            bin,
            r#"node -e 'require("node:fs").writeFileSync(process.env.PROJECT_ROOT+"/bin-count.txt",String(require("node:fs").readdirSync(".git/fixture-bin").length))'"#,
        );
        if count == 64 {
            let evidence = dry_evidence(&output);
            assert_eq!(
                evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
                "a234783773490c8d46b3a1787a55e65736d67df863627a6ee66f45d99ebb0cb7"
            );
            assert_eq!(
                fs::read_to_string(fixture.root.join("bin-count.txt")).unwrap(),
                "64"
            );
        } else {
            assert_eq!(output.status.code(), Some(70));
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).unwrap(),
                super::boundaries::failure(70, "invalid extension response")
            );
            assert!(!fixture.root.join("results").exists());
            assert!(!fixture.root.join("bin-count.txt").exists());
        }
        assert!(!fixture.root.join("native-invocations").exists());
        assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    }
}

#[test]
fn bounds_executable_declarations_by_utf8_names_and_content_bytes() {
    for suffix in ["", "x"] {
        let fixture = RepositoryFixture::new();
        let content = format!("#!/bin/sh\n#{}{suffix}", "é".repeat(524280));
        let output = invoke_bin(
            &fixture,
            json!({"probe":content}),
            r#"node -e 'const fs=require("node:fs");const bytes=fs.readFileSync(".git/fixture-bin/probe");fs.writeFileSync(process.env.PROJECT_ROOT+"/bin-bytes.json",JSON.stringify({length:bytes.length,sha256:require("node:crypto").createHash("sha256").update(bytes).digest("hex")}))'"#,
        );
        if suffix.is_empty() {
            let evidence = dry_evidence(&output);
            assert_eq!(
                evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
                "d44f04e4fc98724cffab85566a328a87569fcff26ad09dddf058f65b13e60f51"
            );
            let receipt: Value =
                serde_json::from_slice(&fs::read(fixture.root.join("bin-bytes.json")).unwrap())
                    .unwrap();
            assert_eq!(
                receipt,
                json!({"length":1048571,"sha256":"64be5aa0f3e8bf0e09850ba50f145dbbe42d3630c09d55127766d9f21568480c"})
            );
        } else {
            assert_eq!(output.status.code(), Some(64));
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).unwrap(),
                super::boundaries::failure(
                    64,
                    "invalid resolved case file: fixture: invalid fixture binaries; correct the fixture declaration"
                )
            );
            assert!(!fixture.root.join("results").exists());
            assert!(!fixture.root.join("bin-bytes.json").exists());
        }
        assert!(!fixture.root.join("native-invocations").exists());
        assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    }
}

fn in_owned_namespace(test: &str) -> bool {
    if !cfg!(target_os = "linux")
        || std::env::var("SEVRO_FIXTURE_BIN_ISOLATED").as_deref() == Ok(test)
    {
        return false;
    }
    let output = Command::new("/usr/bin/bwrap")
        .args([
            "--unshare-user",
            "--bind",
            "/",
            "/",
            "--dev-bind",
            "/dev",
            "/dev",
            "--proc",
            "/proc",
            "--tmpfs",
            "/var/tmp",
            "--",
        ])
        .arg(std::env::current_exe().unwrap())
        .args([test, "--exact"])
        .env("SEVRO_FIXTURE_BIN_ISOLATED", test)
        .output()
        .expect("fixture retention tests require the documented Linux bubblewrap setup");
    assert!(
        output.status.success(),
        "isolated fixture-bin test failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

#[test]
fn refuses_a_setup_created_executable_directory_symlink_and_retains_the_workspace() {
    if in_owned_namespace(
        "fixture_bin::refuses_a_setup_created_executable_directory_symlink_and_retains_the_workspace",
    ) {
        return;
    }
    let fixture = RepositoryFixture::new();
    let output = invoke_bin(
        &fixture,
        json!({"fixture-probe":TOOL}),
        r#"set -eu
printf '%s' "$WORKSPACE" > "$PROJECT_ROOT/retained-workspace.txt"
mv .git/fixture-bin "$PROJECT_ROOT/original-bin"
mkdir "$PROJECT_ROOT/outside"
printf 'outside untouched\n' > "$PROJECT_ROOT/outside/sentinel"
ln -s "$PROJECT_ROOT/outside" .git/fixture-bin
"#,
    );
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        super::boundaries::failure(70, "fixture binary directory is invalid")
    );
    let workspace =
        PathBuf::from(fs::read_to_string(fixture.root.join("retained-workspace.txt")).unwrap());
    assert_eq!(
        fs::read_to_string(workspace.join("README.md")).unwrap(),
        "fixture\n"
    );
    assert_eq!(
        fs::read_link(workspace.join(".git/fixture-bin")).unwrap(),
        fixture.root.join("outside")
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("outside/sentinel")).unwrap(),
        "outside untouched\n"
    );
    assert_eq!(
        fs::read_dir(fixture.root.join("outside")).unwrap().count(),
        1
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("original-bin/fixture-probe")).unwrap(),
        TOOL
    );
    assert!(!fixture.root.join("native-invocations").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
}

#[test]
fn refuses_a_binary_directory_reached_through_redirected_git_metadata() {
    if in_owned_namespace(
        "fixture_bin::refuses_a_binary_directory_reached_through_redirected_git_metadata",
    ) {
        return;
    }
    let fixture = RepositoryFixture::new();
    let output = invoke_bin(
        &fixture,
        json!({"fixture-probe":TOOL}),
        r#"set -eu
printf '%s' "$WORKSPACE" > "$PROJECT_ROOT/retained-workspace.txt"
mv .git "$PROJECT_ROOT/original-git"
mkdir "$PROJECT_ROOT/outside"
mkdir "$PROJECT_ROOT/outside/fixture-bin"
printf 'outside untouched\n' > "$PROJECT_ROOT/outside/sentinel"
ln -s "$PROJECT_ROOT/outside" .git
"#,
    );
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        super::boundaries::failure(70, "fixture binary directory escapes the workspace")
    );
    let workspace =
        PathBuf::from(fs::read_to_string(fixture.root.join("retained-workspace.txt")).unwrap());
    assert_eq!(
        fs::read_to_string(workspace.join("README.md")).unwrap(),
        "fixture\n"
    );
    assert_eq!(
        fs::read_link(workspace.join(".git")).unwrap(),
        fixture.root.join("outside")
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("outside/sentinel")).unwrap(),
        "outside untouched\n"
    );
    assert_eq!(
        fs::read_dir(fixture.root.join("outside/fixture-bin"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("original-git/fixture-bin/fixture-probe")).unwrap(),
        TOOL
    );
    assert!(!fixture.root.join("native-invocations").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
}

#[test]
fn installs_declared_executables_before_setup_and_prepends_their_path() {
    let fixture = RepositoryFixture::new();
    fixture.setup_extension_with_fixture(
        SETUP,
        json!({
            "kind":"generated",
            "commits":[{"message":"chore: initialize","files":{"README.md":"fixture\n"}}],
            "bin":{"fixture-probe":TOOL}
        }),
    );
    let extension = fs::read(fixture.root.join("setup-extension.mjs")).unwrap();
    let decoy = fixture.root.join("decoy-bin");
    fs::create_dir(&decoy).unwrap();
    fs::write(decoy.join("fixture-probe"), DECOY).unwrap();
    fs::set_permissions(
        decoy.join("fixture-probe"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let inherited = std::env::var_os("PATH").unwrap();
    let path = std::env::join_paths(
        std::iter::once(decoy.clone()).chain(std::env::split_paths(&inherited)),
    )
    .unwrap();
    let output = fixture
        .command(&[
            "--extension-command-file",
            "setup-command.json",
            "--extension-source-file",
            "setup-extension.mjs",
            "--case-id",
            "repository-setup",
            "--results-root",
            "results",
        ])
        .env("PATH", path)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
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
        "404bb56b18df86c7ffb876fa3c7395205e02784b6a21c93171f43c4aa3d7edbb"
    );
    assert_eq!(
        evidence["configuration"]["redacted"]["fixtureSetupDigest"],
        "9d224ac0b1fdc2894c48dce0e3d360fbe6762e5842dcf1f0f569888d7846bcd3"
    );
    let receipt: Value =
        serde_json::from_slice(&fs::read(fixture.root.join("setup-bin-receipt.json")).unwrap())
            .unwrap();
    assert_eq!(
        receipt,
        json!({
            "firstPathEntry":".git/fixture-bin", "toolContents":TOOL,
            "toolMode":493, "directoryMode":448, "output":"fixture tool\n",
            "head":"5bc31024b9c366e7f2cda7ea410571fd19acb472", "status":"", "committed":"fixture\n"
        })
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
        fs::read(fixture.root.join("setup-extension.mjs")).unwrap(),
        extension
    );
    assert_eq!(
        fs::read_to_string(decoy.join("fixture-probe")).unwrap(),
        DECOY
    );
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
