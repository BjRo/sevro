use super::{RepositoryFixture, boundaries, git};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn in_owned_namespace(test: &str) -> bool {
    if !cfg!(target_os = "linux")
        || std::env::var("SEVRO_REPOSITORY_MUTATION_ISOLATED").as_deref() == Ok(test)
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
        .env("SEVRO_REPOSITORY_MUTATION_ISOLATED", test)
        .output()
        .expect("repository retention tests require the documented Linux bubblewrap setup");
    assert!(
        output.status.success(),
        "isolated repository mutation test failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

fn namespace(fixture: &RepositoryFixture) -> PathBuf {
    if cfg!(target_os = "linux") {
        PathBuf::from("/var/tmp/sevro-workspaces-private")
    } else {
        fixture.root.join("tmp/sevro-workspaces-private")
    }
}

fn advancing_extension(fixture: &RepositoryFixture) {
    fixture.extension(
        json!({"kind":"repository","sourceRef":"fixture-repo"}),
        json!({"artifacts":[],"requestedInstrumentation":[],"extensionData":{}}),
        json!([]),
    );
    let program = fixture.root.join("setup-extension.mjs");
    let mutation = format!(
        r#"if (request.method === 'prepare') {{
const env = {{...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null',
GIT_AUTHOR_NAME:'Sevro Fixture', GIT_AUTHOR_EMAIL:'fixture@sevro.invalid',
GIT_COMMITTER_NAME:'Sevro Fixture', GIT_COMMITTER_EMAIL:'fixture@sevro.invalid',
GIT_AUTHOR_DATE:'2000-01-01T00:00:00+00:00', GIT_COMMITTER_DATE:'2000-01-01T00:00:00+00:00'}};
writeFileSync({source} + '/README.md', 'advanced by preparation\n');
execFileSync('git', ['add','README.md'], {{cwd:{source},env}});
execFileSync('git', ['-c','commit.gpgsign=false','commit','--quiet','-m','Advance during preparation'], {{cwd:{source},env}});
writeFileSync({marker}, 'prepared\n');
}}
const results="#,
        source = json!(fixture.source),
        marker = json!(fixture.root.join("prepared")),
    );
    let original = fs::read_to_string(&program).unwrap();
    fs::write(
        program,
        format!(
            "import {{writeFileSync}} from 'node:fs';\nimport {{execFileSync}} from 'node:child_process';\n{}",
            original.replace("const results=", &mutation)
        ),
    )
    .unwrap();
}

#[test]
fn refuses_repository_revision_changed_during_extension_preparation() {
    if in_owned_namespace(
        "preparation_mutation::refuses_repository_revision_changed_during_extension_preparation",
    ) {
        return;
    }
    let fixture = RepositoryFixture::new();
    assert!(!namespace(&fixture).exists());
    assert_eq!(
        git(&fixture.source, &["rev-parse", "HEAD"]),
        "f4d351b20b90e67f9e9092777856c0135110b023"
    );
    advancing_extension(&fixture);
    let output = fixture
        .command(&[
            "--extension-command-file",
            "setup-command.json",
            "--extension-source-file",
            "setup-extension.mjs",
            "--case-id",
            "repository-setup",
        ])
        .arg("--results-root")
        .arg(fixture.root.join("results"))
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(70),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        boundaries::failure(70, "repository source changed during run")
    );
    assert_eq!(
        fs::read(fixture.root.join("prepared")).unwrap(),
        b"prepared\n"
    );
    assert_eq!(
        fs::read(fixture.source.join("README.md")).unwrap(),
        b"advanced by preparation\n"
    );
    assert_eq!(
        git(&fixture.source, &["rev-parse", "HEAD"]),
        "75dd20f9ddd25b0c985a44f01bc865a813bb2f32"
    );
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert!(!fixture.root.join("native-invocations").exists());
    let workspaces = fs::read_dir(namespace(&fixture))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(workspaces.len(), 1);
    assert_eq!(fs::read_dir(&workspaces[0]).unwrap().count(), 0);
    let results = fixture.root.join("results");
    assert!(!results.join("latest.json").exists());
    for entry in fs::read_dir(results).unwrap() {
        for name in ["run.json", "result.json", "trial-1.json"] {
            assert!(!entry.as_ref().unwrap().path().join(name).exists());
        }
    }
}

#[test]
fn retains_the_reserved_workspace_when_preparation_removes_repository_head() {
    if in_owned_namespace(
        "preparation_mutation::retains_the_reserved_workspace_when_preparation_removes_repository_head",
    ) {
        return;
    }
    let fixture = RepositoryFixture::new();
    assert!(!namespace(&fixture).exists());
    let index = fs::read(fixture.source.join(".git/index")).unwrap();
    let reference = fs::read(fixture.source.join(".git/refs/heads/main")).unwrap();
    fixture.extension(
        json!({"kind":"repository","sourceRef":"fixture-repo"}),
        json!({"artifacts":[],"requestedInstrumentation":[],"extensionData":{}}),
        json!([]),
    );
    let program = fixture.root.join("setup-extension.mjs");
    let mutation = format!(
        "if (request.method === 'prepare') {{ unlinkSync({head}); writeFileSync({marker}, 'prepared\\n'); }}\nconst results=",
        head = json!(fixture.source.join(".git/HEAD")),
        marker = json!(fixture.root.join("prepared")),
    );
    let original = fs::read_to_string(&program).unwrap();
    fs::write(
        program,
        format!(
            "import {{unlinkSync,writeFileSync}} from 'node:fs';\n{}",
            original.replace("const results=", &mutation)
        ),
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
        ])
        .arg("--results-root")
        .arg(fixture.root.join("results"))
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        boundaries::failure(70, "repository fixture Git operation failed")
    );
    assert_eq!(
        fs::read(fixture.root.join("prepared")).unwrap(),
        b"prepared\n"
    );
    assert_eq!(
        fs::read(fixture.source.join("README.md")).unwrap(),
        b"repository fixture\n"
    );
    assert!(!fixture.source.join(".git/HEAD").exists());
    assert_eq!(fs::read(fixture.source.join(".git/index")).unwrap(), index);
    assert_eq!(
        fs::read(fixture.source.join(".git/refs/heads/main")).unwrap(),
        reference
    );
    assert!(!fixture.root.join("native-invocations").exists());
    let workspaces = fs::read_dir(namespace(&fixture))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(workspaces.len(), 1);
    assert_eq!(fs::read_dir(&workspaces[0]).unwrap().count(), 0);
    let results = fixture.root.join("results");
    assert!(!results.join("latest.json").exists());
    for entry in fs::read_dir(results).unwrap() {
        for name in ["run.json", "result.json", "trial-1.json"] {
            assert!(!entry.as_ref().unwrap().path().join(name).exists());
        }
    }
}
