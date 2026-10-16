use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const BASE_REVISION: &str = "5c3b5472713da769681c6e25442b7c35cad8d9af";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("sevro-rust-git-head-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir(root.join("temporary")).unwrap();
        fs::write(
            root.join("case.json"),
            serde_json::to_vec(&json!({
                "id":"head-unchanged",
                "prompt":"Leave the repository unchanged and return ready.",
                "fixture":{"kind":"generated","commits":[
                    {"message":"chore: initialize","files":{"README.md":"first\n"}},
                    {"message":"feat: revise","files":{"README.md":"second\n"}}
                ]},
                "checks":[{"id":"head-unchanged","grader":"sevro.git-head","configuration":{"kind":"unchanged"}}],
                "requiredEvidence":["sevro.observation.git-head"]
            })).unwrap(),
        ).unwrap();
        fs::write(
            root.join("adapter.ts"),
            r#"import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
export default {
  id:'sevro.host.synthetic',model:'synthetic-v1',effort:'none',
  async run({workspace}) {
    const head=execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8'}).trim();
    await writeFile(new URL('./observed-head',import.meta.url),head);
    return {finalMessage:'ready',complete:true};
  }
};
"#,
        )
        .unwrap();
        Self(root)
    }

    fn transition(&self, mode: &str, action: &str) {
        let path = self.0.join("case.json");
        let mut case = read_json(&path);
        case["id"] = json!(format!("head-{mode}"));
        case["checks"] = json!([
            {"id":"head-changed","grader":"sevro.git-head","configuration":{"kind":"changed"}},
            {"id":"base-ancestor","grader":"sevro.git-head","configuration":{"kind":"base-ancestor"}}
        ]);
        fs::write(path, serde_json::to_vec(&case).unwrap()).unwrap();
        fs::write(self.0.join("adapter.ts"), r#"import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export default {id:'sevro.host.synthetic',model:'synthetic-v1',effort:'none',async run({workspace}) {
 const git=(...args)=>execFileSync('git',args,{cwd:workspace,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Sevro Fixture',GIT_AUTHOR_EMAIL:'fixture@sevro.invalid',GIT_COMMITTER_NAME:'Sevro Fixture',GIT_COMMITTER_EMAIL:'fixture@sevro.invalid',GIT_AUTHOR_DATE:'2000-01-01T00:00:00+00:00',GIT_COMMITTER_DATE:'2000-01-01T00:00:00+00:00'}});
 ACTION
 await writeFile(new URL('./observed-head',import.meta.url),git('rev-parse','HEAD').trim());
 return {finalMessage:'ready',complete:true};
}};
"#.replace("ACTION", action)).unwrap();
    }

    fn invoke(&self) -> Output {
        Command::new(env!("CARGO_BIN_EXE_sevro"))
            .current_dir(&self.0)
            .env("TMPDIR", self.0.join("temporary"))
            .args([
                "run",
                "--json",
                "--case-file",
                "case.json",
                "--adapter-module",
                "adapter.ts",
                "--project-root",
                ".",
                "--results-root",
                "results",
                "--runner-build-digest",
            ])
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64))
            .args(["--trials", "1", "--threshold", "1", "--jobs", "1"])
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn assert_transition(fixture: &Fixture, exit: i32, current: &str, ancestor: bool) -> Value {
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(exit),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let case = &result["cases"][0];
    let trial = &case["trials"][0];
    for assessment in [&result, case, trial] {
        assert_eq!(assessment["execution"]["status"], "completed");
        assert_eq!(assessment["grading"]["status"], "completed");
        assert_eq!(
            assessment["task"]["verdict"],
            if exit == 0 { "passed" } else { "failed" }
        );
    }
    assert_eq!(result["exitCode"], exit);
    assert_eq!(
        trial["checks"],
        json!([
            {"id":"head-changed","grader":"sevro.git-head","status":"passed",
             "detail":"candidate did not create the expected commit",
             "evidenceRefs":["sevro.observation.git-head"]},
            {"id":"base-ancestor","grader":"sevro.git-head","status":if ancestor {"passed"} else {"failed"},
             "detail":"candidate replaced or diverged from the fixture history",
             "evidenceRefs":["sevro.observation.git-head"]}
        ])
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join("observed-head")).unwrap(),
        current
    );
    let path = Path::new(result["evidencePath"].as_str().unwrap());
    let evidence = read_json(path);
    assert_eq!(evidence["result"], result);
    assert_eq!(
        read_json(Path::new(trial["artifactPath"].as_str().unwrap()))["result"],
        *trial
    );
    assert_eq!(
        read_json(&path.parent().unwrap().join("result.json")),
        result
    );
    assert_eq!(read_json(&fixture.0.join("results/latest.json")), result);
    let retained = &evidence["trials"][0];
    let observations = retained["observations"].as_array().unwrap();
    let git = observations
        .iter()
        .find(|value| value["id"] == "sevro.observation.git-head")
        .unwrap();
    assert_eq!(
        git,
        &json!({
            "id":"sevro.observation.git-head","source":"sevro.git-head","completeness":"complete",
            "data":{"baseRevision":BASE_REVISION,"currentRevision":current,"baseAncestor":ancestor}
        })
    );
    let raw = url::Url::parse(retained["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(raw).unwrap(), b"ready");
    assert_eq!(
        retained["rawResult"]["sha256"],
        "b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6"
    );
    let workspace = Path::new(
        observations
            .iter()
            .find(|value| value["id"] == "sevro.observation.workspaces")
            .unwrap()["data"]["candidate"]
            .as_str()
            .unwrap(),
    );
    assert!(workspace.starts_with(fixture.0.join("temporary")));
    assert_eq!(workspace.exists(), exit != 0);
    evidence
}

#[test]
fn git_head_advance_preserves_the_base_and_passes_changed_and_ancestry() {
    let fixture = Fixture::new();
    fixture.transition("advance", "await writeFile(join(workspace,'README.md'),'third\\n'); git('add','README.md'); git('commit','-m','feat: advance');");
    assert_transition(
        &fixture,
        0,
        "a647de244b9760c795ce5af931a3517dd3c30a90",
        true,
    );
}

#[test]
fn git_head_rewind_changes_head_but_fails_ancestry_with_retained_evidence() {
    let fixture = Fixture::new();
    fixture.transition("rewind", "git('reset','--hard','HEAD~1');");
    let evidence = assert_transition(
        &fixture,
        1,
        "6c4776f37d408fe0c21ee516ea7ea91d117d5266",
        false,
    );
    let workspace = Path::new(
        evidence["trials"][0]["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["id"] == "sevro.observation.workspaces")
            .unwrap()["data"]["candidate"]
            .as_str()
            .unwrap(),
    );
    assert_eq!(
        fs::read_to_string(workspace.join("README.md")).unwrap(),
        "first\n"
    );
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn git_head_unchanged_passes_with_runner_owned_base() {
    let fixture = Fixture::new();
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let case = &result["cases"][0];
    let trial = &case["trials"][0];
    for assessment in [&result, case, trial] {
        assert_eq!(assessment["execution"]["status"], "completed");
        assert_eq!(assessment["grading"]["status"], "completed");
        assert_eq!(assessment["task"]["verdict"], "passed");
    }
    assert_eq!(result["exitCode"], 0);
    assert_eq!(
        trial["checks"],
        json!([{
            "id":"head-unchanged","grader":"sevro.git-head","status":"passed",
            "detail":"candidate created or switched to a different commit",
            "evidenceRefs":["sevro.observation.git-head"]
        }])
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join("observed-head")).unwrap(),
        BASE_REVISION
    );
    let path = Path::new(result["evidencePath"].as_str().unwrap());
    let evidence = read_json(path);
    assert_eq!(evidence["result"], result);
    assert_eq!(
        read_json(Path::new(trial["artifactPath"].as_str().unwrap()))["result"],
        *trial
    );
    assert_eq!(
        read_json(&path.parent().unwrap().join("result.json")),
        result
    );
    assert_eq!(read_json(&fixture.0.join("results/latest.json")), result);
    let retained = &evidence["trials"][0];
    let observations = retained["observations"].as_array().unwrap();
    let git = observations
        .iter()
        .find(|value| value["id"] == "sevro.observation.git-head")
        .unwrap();
    assert_eq!(
        git,
        &json!({
            "id":"sevro.observation.git-head","source":"sevro.git-head","completeness":"complete",
            "data":{"baseRevision":BASE_REVISION,"currentRevision":BASE_REVISION,"baseAncestor":true}
        })
    );
    let raw = url::Url::parse(retained["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(raw).unwrap(), b"ready");
    assert_eq!(
        retained["rawResult"]["sha256"],
        "b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6"
    );
    let workspace = Path::new(
        observations
            .iter()
            .find(|value| value["id"] == "sevro.observation.workspaces")
            .unwrap()["data"]["candidate"]
            .as_str()
            .unwrap(),
    );
    assert!(workspace.starts_with(fixture.0.join("temporary")));
    assert!(!workspace.exists());
}
