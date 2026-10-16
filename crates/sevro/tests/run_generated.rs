use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const OBSERVER: &str = r#"import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export default {
  id:'example.generated-observer', model:'observer-v1', effort:'none',
  async run({workspace}) {
    const git=(...args)=>execFileSync('git',args,{cwd:workspace,encoding:'utf8'});
    return {complete:true, finalMessage:JSON.stringify({
      head:git('rev-parse','HEAD').trim(),
      branch:git('symbolic-ref','--short','HEAD').trim(),
      messages:git('log','--format=%s').trimEnd(),
      author:git('log','-1','--format=%an <%ae>|%at|%cn <%ce>|%ct').trimEnd(),
      committed:git('show','HEAD:README.md'),
      staged:git('show',':README.md'),
      working:readFileSync(join(workspace,'README.md'),'utf8'),
      status:git('status','--porcelain=v1').trimEnd(),
    })};
  }
};
"#;

struct GeneratedFixture(PathBuf);

impl GeneratedFixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("sevro-rust-generated-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir(root.join("project")).unwrap();
        fs::create_dir(root.join("temporary")).unwrap();
        fs::write(root.join("observer.mjs"), OBSERVER).unwrap();
        let fixture = Self(root);
        fixture.set_declaration(declaration());
        fixture
    }

    fn set_declaration(&self, declaration: Value) {
        fs::write(
            self.0.join("case.json"),
            serde_json::to_vec(&json!({
                "id":"generated-history", "prompt":"Inspect the declared history and index.",
                "fixture":declaration,
                "checks":[{"id":"receipt","grader":"sevro.output","configuration":{"validJson":true}}],
                "requiredEvidence":[]
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn invoke(&self, extra: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_sevro"))
            .current_dir(&self.0)
            .env("TMPDIR", self.0.join("temporary"))
            .env("GIT_AUTHOR_NAME", "Caller author")
            .env("GIT_AUTHOR_EMAIL", "caller@example.invalid")
            .env("GIT_COMMITTER_NAME", "Caller committer")
            .env("GIT_COMMITTER_EMAIL", "caller@example.invalid")
            .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00+00:00")
            .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00+00:00")
            .args([
                "run",
                "--json",
                "--case-file",
                "case.json",
                "--adapter-module",
                "observer.mjs",
                "--project-root",
                "project",
                "--results-root",
                "results",
                "--runner-build-digest",
            ])
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64))
            .args(extra)
            .output()
            .unwrap()
    }
}

impl Drop for GeneratedFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn declaration() -> Value {
    json!({
        "kind":"generated",
        "commits":[{"message":"chore: initialize","files":{"README.md":"fixture\n"}}],
        "files":{"README.md":"staged\n"},
        "staged":["README.md"]
    })
}

fn read_json(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn prepares_generated_history_and_staged_overlay() {
    let fixture = GeneratedFixture::new();
    let output = fixture.invoke(&[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout).lines().count(), 1);
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"]["status"], "completed");
    assert_eq!(result["grading"]["status"], "completed");
    assert_eq!(result["task"]["verdict"], "passed");
    let evidence_path = Path::new(result["evidencePath"].as_str().unwrap());
    let evidence = read_json(evidence_path);
    assert_eq!(evidence["result"], result);
    assert_eq!(
        read_json(evidence_path.with_file_name("result.json")),
        result
    );
    assert_eq!(read_json(fixture.0.join("results/latest.json")), result);
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        "228cfbfcbecb0fed17176dd0e8cb08243a904d23352d77d428d68183574444ee"
    );
    let raw = url::Url::parse(evidence["trials"][0]["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(
        read_json(raw),
        json!({
            "head":"5bc31024b9c366e7f2cda7ea410571fd19acb472",
            "branch":"main", "messages":"chore: initialize",
        "author":"Sevro Fixture <fixture@sevro.invalid>|946684800|Sevro Fixture <fixture@sevro.invalid>|946684800",
            "committed":"fixture\n", "staged":"staged\n", "working":"staged\n", "status":"M  README.md"
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
    assert_eq!(fs::read_dir(fixture.0.join("project")).unwrap().count(), 0);
}

#[test]
fn rejects_generated_repository_metadata_before_run_admission() {
    let fixture = GeneratedFixture::new();
    let mut declaration = declaration();
    declaration["commits"][0]["files"] = json!({"nested/.GIT/config":"escape\n"});
    fixture.set_declaration(declaration);
    let output = fixture.invoke(&[]);
    assert_invalid(
        &fixture,
        &output,
        "generated fixture cannot write repository metadata",
    );
}

fn assert_invalid(fixture: &GeneratedFixture, output: &Output, issue: &str) {
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
            "format":"sevro.cli-result.v1", "runId":null,
            "execution":{"status":"not_run"}, "grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"}, "exitCode":64, "evidencePath":null, "cases":[],
            "diagnostic":{"code":"sevro.invocation.invalid", "message":format!(
                "resolved case file is unreadable or invalid at {}: invalid resolved case file: fixture: {issue}; correct the fixture declaration; supply --case-file with readable JSON and correct the named field",
                fixture.0.join("case.json").display()
            )}
        })
    );
    assert!(!fixture.0.join("results").exists());
}

#[test]
fn rejects_staging_paths_outside_generated_overlay_before_run_admission() {
    let fixture = GeneratedFixture::new();
    let mut declaration = declaration();
    declaration["staged"] = json!(["other.txt"]);
    fixture.set_declaration(declaration);
    let output = fixture.invoke(&[]);
    assert_invalid(&fixture, &output, "invalid generated fixture staging");
}

#[test]
fn gives_generated_trials_identical_history_and_fresh_working_trees() {
    let fixture = GeneratedFixture::new();
    let mut declaration = declaration();
    declaration["commits"].as_array_mut().unwrap().push(json!({
        "message":"feat: revise", "files":{"README.md":"second\n"}
    }));
    declaration["files"]["notes.txt"] = json!("untracked\n");
    fixture.set_declaration(declaration);
    fs::write(fixture.0.join("observer.mjs"), r#"import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default {
  id:'example.generated-observer',model:'observer-v1',effort:'none',
  async run({workspace}) {
    const git=(...args)=>execFileSync('git',args,{cwd:workspace,encoding:'utf8'});
    const receipt={head:git('rev-parse','HEAD').trim(),messages:git('log','--format=%s').trimEnd(),
      committed:git('show','HEAD:README.md'),staged:git('show',':README.md'),
      status:git('status','--porcelain=v1').trimEnd(),scratchPresent:existsSync(join(workspace,'scratch.txt'))};
    writeFileSync(join(workspace,'scratch.txt'),'trial scratch\n');
    return {complete:true,finalMessage:JSON.stringify(receipt)};
  }
};
"#).unwrap();
    let output = fixture.invoke(&["--trials", "2", "--jobs", "1"]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["task"]["verdict"], "passed");
    let evidence = read_json(result["evidencePath"].as_str().unwrap());
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        "50217b4d0d477e641093a6a6eeda8cdc707f93090b31d2598fe3e5cca6a83f93"
    );
    let trials = evidence["trials"].as_array().unwrap();
    assert_eq!(trials.len(), 2);
    let mut workspaces = Vec::new();
    for trial in trials {
        let raw = url::Url::parse(trial["rawResult"]["path"].as_str().unwrap())
            .unwrap()
            .to_file_path()
            .unwrap();
        assert_eq!(
            read_json(raw),
            json!({
                "head":"60af8ef9645c6689de225867adbc4f34beb622a0",
                "messages":"feat: revise\nchore: initialize", "committed":"second\n", "staged":"staged\n",
                "status":"M  README.md\n?? notes.txt", "scratchPresent":false
            })
        );
        let workspace = trial["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|observation| observation["id"] == "sevro.observation.workspaces")
            .unwrap()["data"]["candidate"]
            .as_str()
            .unwrap();
        assert!(!Path::new(workspace).exists());
        workspaces.push(workspace);
    }
    assert_ne!(workspaces[0], workspaces[1]);
}

#[test]
fn commits_generated_overlay_as_scaffolding_when_requested() {
    let fixture = GeneratedFixture::new();
    let mut declaration = declaration();
    declaration["commitFiles"] = json!(true);
    declaration["files"]["guide.txt"] = json!("scaffolding\n");
    declaration.as_object_mut().unwrap().remove("staged");
    fixture.set_declaration(declaration);
    let output = fixture.invoke(&[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["task"]["verdict"], "passed");
    let evidence = read_json(result["evidencePath"].as_str().unwrap());
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        "91d0af7436bf4b5b5d634f1a03370d6ea81aed55b8c820ee63327a59e95d12ce"
    );
    let raw = url::Url::parse(evidence["trials"][0]["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(
        read_json(raw),
        json!({
            "head":"4ef2f1bcdce700763c9b30a2fc1ba33d434f6928", "branch":"main",
            "messages":"Add evaluation scaffolding\nchore: initialize",
        "author":"Sevro Fixture <fixture@sevro.invalid>|946684800|Sevro Fixture <fixture@sevro.invalid>|946684800",
            "committed":"staged\n", "staged":"staged\n", "working":"staged\n", "status":""
        })
    );
}

#[test]
fn refuses_null_generated_options_instead_of_treating_them_as_absent() {
    let fixture = GeneratedFixture::new();
    let mut declaration = declaration();
    declaration["commitFiles"] = Value::Null;
    fixture.set_declaration(declaration);
    let output = fixture.invoke(&[]);
    assert_invalid(&fixture, &output, "invalid generated fixture");
}
