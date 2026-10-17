use super::{RepositoryFixture, git, write_json};
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output};

const HOOK: &str = "#!/bin/sh\necho 'hook blocked commit' >&2\nexit 1\n";
const SOURCE_HOOK: &str = "#!/bin/sh\necho 'source hook should not run' >&2\nexit 97\n";
const HEAD: &str = "46c49149aa29880bc2e54ffeb5270c7bc97329b6";
const OBSERVER: &str = r#"import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
export default {
  id: 'example.repository-hooks-observer', model: 'observer-v1', effort: 'none',
  async run({ workspace }) {
    const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' });
    const headBefore = git('rev-parse', 'HEAD').trim();
    const hookPath = join(workspace, '.git', 'hooks', 'pre-commit');
    const hook = lstatSync(hookPath);
    git('add', 'READY.txt');
    const commit = spawnSync('git', ['-c', 'user.name=Candidate', '-c', 'user.email=candidate@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Try to commit'], { cwd: workspace, encoding: 'utf8', timeout: 10000 });
    if (commit.error) throw commit.error;
    return { complete: true, finalMessage: JSON.stringify({
      headBefore, headAfter: git('rev-parse', 'HEAD').trim(),
      branch: git('rev-parse', '--abbrev-ref', 'HEAD').trim(),
      messages: git('log', '--format=%s').trimEnd(),
      author: git('log', '-1', '--format=%an <%ae>|%at|%cn <%ce>|%ct').trimEnd(),
      commitCode: commit.status, commitSignal: commit.signal,
      commitStdout: commit.stdout, commitStderr: commit.stderr,
      hookContent: readFileSync(hookPath, 'utf8'),
      hookMode: (hook.mode & 0o777).toString(8),
      hookRegularFile: hook.isFile(), hookSymlink: hook.isSymbolicLink(),
      status: git('status', '--porcelain=v1').trimEnd(),
      committed: git('show', 'HEAD:README.md'), staged: git('show', ':READY.txt'),
      working: readFileSync(join(workspace, 'READY.txt'), 'utf8'),
    }) };
  },
};
"#;

fn fixture() -> RepositoryFixture {
    let fixture = RepositoryFixture::new();
    fs::write(fixture.source.join("README.md"), "source\n").unwrap();
    git(&fixture.source, &["add", "README.md"]);
    git(
        &fixture.source,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--amend",
            "--quiet",
            "-m",
            "Initialize",
        ],
    );
    let source_hook = fixture.source.join(".git/hooks/pre-commit");
    fs::write(&source_hook, SOURCE_HOOK).unwrap();
    fs::set_permissions(source_hook, fs::Permissions::from_mode(0o700)).unwrap();
    fs::create_dir(fixture.root.join("project")).unwrap();
    fs::write(fixture.root.join("observer.mjs"), OBSERVER).unwrap();
    write_case(&fixture, declaration());
    fixture
}

fn declaration() -> Value {
    json!({"sourceRef":"fixture-repo", "files":{"READY.txt":"new\n"}, "hooks":{"pre-commit":HOOK}})
}

fn write_case(fixture: &RepositoryFixture, declaration: Value) {
    write_json(
        &fixture.root.join("case.json"),
        &json!({
            "id":"repository-hooks", "prompt":"Attempt a candidate commit and report its observable outcome.",
            "fixture":declaration, "requiredEvidence":[],
            "checks":[{"id":"receipt","grader":"sevro.output","configuration":{"validJson":true}}]
        }),
    );
}

fn command(fixture: &RepositoryFixture) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "umask 077; exec \"$@\"", "sevro-repository-hooks"])
        .arg(env!("CARGO_BIN_EXE_sevro"))
        .current_dir(&fixture.root)
        .env("TMPDIR", fixture.root.join("tmp"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args([
            "run",
            "--json",
            "--case-file",
            "case.json",
            "--adapter-module",
            "observer.mjs",
            "--case-source-map-file",
            "source-map.json",
            "--case-source-root",
        ])
        .arg(fixture.root.join("sources"))
        .args([
            "--project-root",
            "project",
            "--results-root",
            "results",
            "--runner-build-digest",
        ])
        .arg("a".repeat(64))
        .arg("--project-digest")
        .arg("b".repeat(64));
    command
}

fn read_json(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
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
    let evidence = read_json(result["evidencePath"].as_str().unwrap());
    assert_eq!(evidence["result"], result);
    evidence
}

fn source_snapshot(fixture: &RepositoryFixture) -> Value {
    let hook = fixture.source.join(".git/hooks/pre-commit");
    json!({
        "head":git(&fixture.source, &["rev-parse", "HEAD"]),
        "status":git(&fixture.source, &["status", "--porcelain=v1"]),
        "branch":git(&fixture.source, &["symbolic-ref", "--short", "HEAD"]),
        "readme":fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "hook":fs::read_to_string(&hook).unwrap(),
        "hookMode":format!("{:o}", fs::symlink_metadata(hook).unwrap().permissions().mode() & 0o777),
        "overlayPresent":fixture.source.join("READY.txt").exists()
    })
}

#[test]
fn installs_declared_repository_hooks_without_changing_the_source() {
    let fixture = fixture();
    let original = json!({"head":HEAD, "status":"", "branch":"main", "readme":"source\n",
        "hook":SOURCE_HOOK, "hookMode":"700", "overlayPresent":false});
    assert_eq!(source_snapshot(&fixture), original);
    let evidence = completed_evidence(&command(&fixture).output().unwrap());
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        "da1686026d0d5de6860a04901afe1ad669a835085c3bb742cb325a2fb49ee0e7"
    );
    let raw = url::Url::parse(evidence["trials"][0]["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(
        read_json(raw),
        json!({
            "headBefore":HEAD, "headAfter":HEAD, "branch":"HEAD", "messages":"Initialize",
            "author":"Sevro Fixture <fixture@sevro.invalid>|946684800|Sevro Fixture <fixture@sevro.invalid>|946684800",
            "commitCode":1, "commitSignal":null, "commitStdout":"", "commitStderr":"hook blocked commit\n",
            "hookContent":HOOK, "hookMode":"755", "hookRegularFile":true, "hookSymlink":false,
            "status":"A  READY.txt", "committed":"source\n", "staged":"new\n", "working":"new\n"
        })
    );
    let workspace = evidence["trials"][0]["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|observation| observation["id"] == "sevro.observation.workspaces")
        .unwrap()["data"]["candidate"]
        .as_str()
        .unwrap();
    assert!(!Path::new(workspace).exists());
    assert_eq!(source_snapshot(&fixture), original);
}

fn simple_observer(fixture: &RepositoryFixture) {
    fs::write(fixture.root.join("observer.mjs"),
        "export default {id:'example.repository-hooks-observer',model:'observer-v1',effort:'none',async run(){return {complete:true,finalMessage:'{}'}}};\n").unwrap();
}

fn assert_invalid(fixture: &RepositoryFixture, output: &Output) {
    assert_eq!(
        output.status.code(),
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({
            "format":"sevro.cli-result.v1", "runId":null,
            "execution":{"status":"not_run"}, "grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"}, "exitCode":64, "evidencePath":null, "cases":[],
            "diagnostic":{"code":"sevro.invocation.invalid", "message":format!(
                "resolved case file is unreadable or invalid at {}: invalid resolved case file: fixture: invalid fixture hooks; correct the fixture declaration; supply --case-file with readable JSON and correct the named field",
                fixture.root.join("case.json").display())}
        })
    );
    assert!(!fixture.root.join("results").exists());
}

#[test]
fn refuses_null_repository_hooks_before_run_admission() {
    let fixture = fixture();
    let original = source_snapshot(&fixture);
    let mut declaration = declaration();
    declaration["hooks"] = Value::Null;
    write_case(&fixture, declaration);
    simple_observer(&fixture);
    assert_invalid(&fixture, &command(&fixture).output().unwrap());
    assert_eq!(source_snapshot(&fixture), original);
}

#[test]
fn refuses_escaping_repository_hook_names_before_run_admission() {
    let fixture = fixture();
    let original = source_snapshot(&fixture);
    let mut declaration = declaration();
    declaration["hooks"] = json!({"../escape":"x"});
    write_case(&fixture, declaration);
    simple_observer(&fixture);
    assert_invalid(&fixture, &command(&fixture).output().unwrap());
    assert_eq!(source_snapshot(&fixture), original);
}

#[test]
fn names_malformed_repository_hook_maps_before_run_admission() {
    for hooks in [json!([]), json!({"pre-commit":1})] {
        let fixture = fixture();
        let original = source_snapshot(&fixture);
        let mut declaration = declaration();
        declaration["hooks"] = hooks;
        write_case(&fixture, declaration);
        simple_observer(&fixture);
        assert_invalid(&fixture, &command(&fixture).output().unwrap());
        assert_eq!(source_snapshot(&fixture), original);
    }
}

#[test]
fn distinguishes_omitted_and_empty_repository_hooks_in_fixture_identity() {
    for (hooks, digest) in [
        (
            None,
            "fc8232ab9de233211674a7b5e43b716fccd4425db6e042c97185ff717d28e5e7",
        ),
        (
            Some(json!({})),
            "0f7c88ebe06f7dc5b3ef7b56e5162d5e3f538b12c3757da407d2c06d92baa353",
        ),
    ] {
        let fixture = fixture();
        let original = source_snapshot(&fixture);
        let mut declaration = declaration();
        declaration.as_object_mut().unwrap().remove("hooks");
        if let Some(hooks) = hooks {
            declaration["hooks"] = hooks;
        }
        write_case(&fixture, declaration);
        simple_observer(&fixture);
        let evidence = completed_evidence(&command(&fixture).output().unwrap());
        assert_eq!(
            evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
            digest
        );
        assert_eq!(source_snapshot(&fixture), original);
    }
}
