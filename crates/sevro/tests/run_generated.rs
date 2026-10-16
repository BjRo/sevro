use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
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
        self.command().args(extra).output().unwrap()
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_sevro"));
        command
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
            .arg("b".repeat(64));
        command
    }
}

impl Drop for GeneratedFixture {
    fn drop(&mut self) {
        if let Ok(workspace) = fs::read_to_string(self.0.join("workspace")) {
            let workspace = Path::new(&workspace);
            if fs::read_to_string(workspace.join(".git/sevro-test-owner"))
                .ok()
                .as_deref()
                == self.0.to_str()
            {
                let _ = fs::remove_dir_all(workspace);
            }
        }
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

const HOOK: &str = "#!/bin/sh\necho 'hook blocked commit' >&2\nexit 1\n";

const HOOK_OBSERVER: &str = r#"import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
export default {
  id: 'example.generated-hooks-observer', model: 'observer-v1', effort: 'none',
  async run({ workspace }) {
    const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' });
    const headBefore = git('rev-parse', 'HEAD').trim();
    const hookPath = join(workspace, '.git', 'hooks', 'pre-commit');
    const hook = lstatSync(hookPath);
    git('add', 'READY.txt');
    const commit = spawnSync('git', ['-c', 'user.name=Candidate', '-c', 'user.email=candidate@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Try to commit'], { cwd: workspace, encoding: 'utf8', timeout: 10000 });
    if (commit.error) throw commit.error;
    return { complete: true, finalMessage: JSON.stringify({
      headBefore,
      headAfter: git('rev-parse', 'HEAD').trim(),
      branch: git('symbolic-ref', '--short', 'HEAD').trim(),
      messages: git('log', '--format=%s').trimEnd(),
      author: git('log', '-1', '--format=%an <%ae>|%at|%cn <%ce>|%ct').trimEnd(),
      commitCode: commit.status, commitSignal: commit.signal,
      commitStdout: commit.stdout, commitStderr: commit.stderr,
      hookContent: readFileSync(hookPath, 'utf8'),
      hookMode: (hook.mode & 0o777).toString(8),
      hookRegularFile: hook.isFile(), hookSymlink: hook.isSymbolicLink(),
      status: git('status', '--porcelain=v1').trimEnd(),
      committed: git('show', 'HEAD:README.md'),
      staged: git('show', ':READY.txt'),
      working: readFileSync(join(workspace, 'READY.txt'), 'utf8'),
    }) };
  },
};
"#;

fn hook_declaration() -> Value {
    json!({
        "kind":"generated",
        "commits":[{"message":"Initialize","files":{"README.md":"source\n"}}],
        "files":{"READY.txt":"new\n"}, "hooks":{"pre-commit":HOOK}
    })
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

fn raw_receipt(evidence: &Value) -> Value {
    read_json(
        url::Url::parse(evidence["trials"][0]["rawResult"]["path"].as_str().unwrap())
            .unwrap()
            .to_file_path()
            .unwrap(),
    )
}

#[test]
fn installs_generated_hooks_after_history_and_blocks_candidate_commits() {
    let fixture = GeneratedFixture::new();
    fixture.set_declaration(hook_declaration());
    fs::write(fixture.0.join("observer.mjs"), HOOK_OBSERVER).unwrap();
    let evidence = completed_evidence(&fixture.invoke(&[]));
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        "1a071c1a0a3422f7611c5c6350137f0f5b4a8683eeca18d0fe9b7e6489bffb3c"
    );
    assert_eq!(
        raw_receipt(&evidence),
        json!({
            "headBefore":"46c49149aa29880bc2e54ffeb5270c7bc97329b6",
            "headAfter":"46c49149aa29880bc2e54ffeb5270c7bc97329b6",
            "branch":"main", "messages":"Initialize",
            "author":"Sevro Fixture <fixture@sevro.invalid>|946684800|Sevro Fixture <fixture@sevro.invalid>|946684800",
            "commitCode":1, "commitSignal":null, "commitStdout":"", "commitStderr":"hook blocked commit\n",
            "hookContent":HOOK, "hookMode":"755", "hookRegularFile":true, "hookSymlink":false,
            "status":"A  READY.txt", "committed":"source\n", "staged":"new\n", "working":"new\n"
        })
    );
}

#[test]
fn rejects_hook_names_that_escape_the_hooks_directory_before_admission() {
    let fixture = GeneratedFixture::new();
    let mut declaration = declaration();
    declaration["hooks"] = json!({"../escape":"exit 1\n"});
    fixture.set_declaration(declaration);
    assert_invalid(&fixture, &fixture.invoke(&[]), "invalid fixture hooks");
}

#[test]
fn bounds_generated_hooks_to_thirty_two_entries() {
    for count in [32, 33] {
        let fixture = GeneratedFixture::new();
        let mut declaration = declaration();
        declaration["hooks"] = Value::Object(
            (0..count)
                .map(|index| (format!("hook-{index}"), json!("x")))
                .collect(),
        );
        fixture.set_declaration(declaration);
        let output = fixture.invoke(&[]);
        if count == 32 {
            completed_evidence(&output);
        } else {
            assert_invalid(&fixture, &output, "invalid fixture hooks");
        }
    }
}

#[test]
fn bounds_hook_names_and_contents_by_utf8_bytes() {
    for suffix in ["x", "xx"] {
        let fixture = GeneratedFixture::new();
        let mut declaration = declaration();
        declaration["hooks"] =
            json!({"ready":format!("{}{suffix}", "é".repeat((1024 * 1024 - 6) / 2))});
        fixture.set_declaration(declaration);
        let output = fixture.invoke(&[]);
        if suffix == "x" {
            let evidence = completed_evidence(&output);
            assert_eq!(
                evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
                "3e9e0d79b79177b4fd3b2e1168cf2ba3cf7397574dae35816a7710dcd725e8ab"
            );
        } else {
            assert_invalid(&fixture, &output, "invalid fixture hooks");
        }
    }
}

#[test]
fn rejects_empty_hook_contents_before_admission() {
    let fixture = GeneratedFixture::new();
    let mut declaration = declaration();
    declaration["hooks"] = json!({"pre-commit":""});
    fixture.set_declaration(declaration);
    assert_invalid(&fixture, &fixture.invoke(&[]), "invalid fixture hooks");
}

#[test]
fn rejects_nul_in_hook_contents_before_admission() {
    let fixture = GeneratedFixture::new();
    let mut declaration = declaration();
    declaration["hooks"] = json!({"pre-commit":"a\0b"});
    fixture.set_declaration(declaration);
    assert_invalid(&fixture, &fixture.invoke(&[]), "invalid fixture hooks");
}

#[test]
fn refuses_null_hooks_instead_of_treating_them_as_omitted() {
    let fixture = GeneratedFixture::new();
    let mut declaration = declaration();
    declaration["hooks"] = Value::Null;
    fixture.set_declaration(declaration);
    assert_invalid(&fixture, &fixture.invoke(&[]), "invalid fixture hooks");
}

#[test]
fn reports_invalid_hook_map_shapes_at_the_named_case_boundary() {
    let fixture = GeneratedFixture::new();
    let mut declaration = declaration();
    declaration["hooks"] = json!([]);
    fixture.set_declaration(declaration);
    assert_invalid(&fixture, &fixture.invoke(&[]), "invalid fixture hooks");
}

#[test]
fn reports_nonstring_hook_contents_at_the_named_case_boundary() {
    let fixture = GeneratedFixture::new();
    let mut declaration = declaration();
    declaration["hooks"] = json!({"pre-commit":1});
    fixture.set_declaration(declaration);
    assert_invalid(&fixture, &fixture.invoke(&[]), "invalid fixture hooks");
}

#[test]
fn preserves_distinct_identities_for_omitted_and_empty_hooks() {
    for (hooks, digest) in [
        (
            None,
            "228cfbfcbecb0fed17176dd0e8cb08243a904d23352d77d428d68183574444ee",
        ),
        (
            Some(json!({})),
            "99be14c6cdb918e72fc864fc0681a91fc72ffcbc5229b719af20e826930042cb",
        ),
    ] {
        let fixture = GeneratedFixture::new();
        let mut declaration = declaration();
        if let Some(hooks) = hooks {
            declaration["hooks"] = hooks;
        }
        fixture.set_declaration(declaration);
        let evidence = completed_evidence(&fixture.invoke(&[]));
        assert_eq!(
            evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
            digest
        );
        assert_eq!(
            raw_receipt(&evidence)["head"],
            "5bc31024b9c366e7f2cda7ea410571fd19acb472"
        );
    }
}

#[test]
fn accepts_only_bounded_lowercase_hook_names() {
    for name in [
        "a".repeat(64),
        "a".repeat(65),
        "Pre-commit".into(),
        String::new(),
    ] {
        let fixture = GeneratedFixture::new();
        let mut declaration = declaration();
        declaration["hooks"] = json!({name.clone():"x"});
        fixture.set_declaration(declaration);
        let output = fixture.invoke(&[]);
        if name == "a".repeat(64) {
            let evidence = completed_evidence(&output);
            assert_eq!(
                evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
                "a853ecf9843ed0bf204385d94a4b998f4a6245d16d1499d08d3b1b08f3ab1101"
            );
        } else {
            assert_invalid(&fixture, &output, "invalid fixture hooks");
        }
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

impl GeneratedFixture {
    fn invoke_with_git_boundary(&self, mutation: &str) -> Output {
        let git = Command::new("/bin/sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap();
        assert!(
            git.status.success(),
            "{}",
            String::from_utf8_lossy(&git.stderr)
        );
        let git = String::from_utf8(git.stdout).unwrap();
        let bin = self.0.join("bin");
        fs::create_dir(&bin).unwrap();
        fs::create_dir(self.0.join("external")).unwrap();
        fs::write(self.0.join("external/original.txt"), "original bytes").unwrap();
        let wrapper = format!(
            "#!/bin/sh\nset -eu\nfor argument do\n if [ \"$argument\" = init ]; then\n  {git} \"$@\"\n  printf '%s' \"$PWD\" > {marker}\n  printf '%s' {owner} > .git/sevro-test-owner\n  {mutation}\n  exit 0\n fi\ndone\nexec {git} \"$@\"\n",
            git = shell_quote(git.trim()),
            marker = shell_quote(self.0.join("workspace").to_str().unwrap()),
            owner = shell_quote(self.0.to_str().unwrap()),
        );
        let source = self.0.join("git-source");
        fs::write(&source, wrapper).unwrap();
        let copied = Command::new("/bin/cp")
            .arg(&source)
            .arg(bin.join("git"))
            .output()
            .unwrap();
        assert!(
            copied.status.success(),
            "copy Git wrapper: {}",
            String::from_utf8_lossy(&copied.stderr)
        );
        fs::set_permissions(bin.join("git"), fs::Permissions::from_mode(0o755)).unwrap();
        let command = self.command();
        let mut private_command = Command::new("/bin/sh");
        private_command
            .args(["-c", "umask 077; exec \"$@\"", "sevro-hook-test"])
            .arg(command.get_program())
            .args(command.get_args())
            .current_dir(&self.0);
        for (name, value) in command.get_envs() {
            if let Some(value) = value {
                private_command.env(name, value);
            }
        }
        let mut paths = vec![bin];
        paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
        private_command
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap()
    }

    fn boundary_workspace(&self) -> PathBuf {
        let workspace = PathBuf::from(fs::read_to_string(self.0.join("workspace")).unwrap());
        assert_eq!(
            fs::read_to_string(workspace.join(".git/sevro-test-owner")).unwrap(),
            self.0.to_str().unwrap()
        );
        workspace
    }
}

#[test]
fn replaces_existing_hooks_after_runner_commits_and_sets_mode_under_private_umask() {
    let fixture = GeneratedFixture::new();
    fixture.set_declaration(hook_declaration());
    fs::write(fixture.0.join("observer.mjs"), HOOK_OBSERVER).unwrap();
    let output = fixture.invoke_with_git_boundary(
        "printf '#!/bin/sh\\nexit 78\\n' > .git/hooks/pre-commit\nchmod 700 .git/hooks/pre-commit",
    );
    let evidence = completed_evidence(&output);
    let receipt = raw_receipt(&evidence);
    assert_eq!(
        receipt["headBefore"],
        "46c49149aa29880bc2e54ffeb5270c7bc97329b6"
    );
    assert_eq!(receipt["headAfter"], receipt["headBefore"]);
    assert_eq!(receipt["messages"], "Initialize");
    assert_eq!(receipt["commitCode"], 1);
    assert_eq!(receipt["commitStderr"], "hook blocked commit\n");
    assert_eq!(receipt["hookMode"], "755");
    assert_eq!(receipt["hookContent"], HOOK);
    assert_eq!(receipt["hookRegularFile"], true);
    assert_eq!(receipt["hookSymlink"], false);
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        "1a071c1a0a3422f7611c5c6350137f0f5b4a8683eeca18d0fe9b7e6489bffb3c"
    );
    assert!(!Path::new(&fs::read_to_string(fixture.0.join("workspace")).unwrap()).exists());
}

fn assert_installation_failure(
    fixture: &GeneratedFixture,
    output: &Output,
    message: &str,
) -> PathBuf {
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({
            "format":"sevro.cli-result.v1", "runId":null, "execution":{"status":"not_run"},
            "grading":{"status":"not_requested"}, "task":{"verdict":"not_assessed"},
            "exitCode":70, "evidencePath":null, "cases":[],
            "diagnostic":{"code":"sevro.runner.error", "message":message}
        })
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join("external/original.txt")).unwrap(),
        "original bytes"
    );
    assert!(!fixture.0.join("results/latest.json").exists());
    fixture.boundary_workspace()
}

#[test]
fn refuses_a_symlink_hook_target_without_replacing_its_destination() {
    let fixture = GeneratedFixture::new();
    fixture.set_declaration(hook_declaration());
    let external = fixture.0.join("external/original.txt");
    let output = fixture.invoke_with_git_boundary(&format!(
        "ln -s {} .git/hooks/pre-commit",
        shell_quote(external.to_str().unwrap())
    ));
    let workspace =
        assert_installation_failure(&fixture, &output, "fixture Git hook target is invalid");
    assert_eq!(
        fs::read_link(workspace.join(".git/hooks/pre-commit")).unwrap(),
        external
    );
}

#[test]
fn refuses_a_directory_hook_target_without_removing_its_contents() {
    let fixture = GeneratedFixture::new();
    fixture.set_declaration(hook_declaration());
    let output = fixture.invoke_with_git_boundary(
        "mkdir .git/hooks/pre-commit\nprintf 'original bytes' > .git/hooks/pre-commit/original.txt",
    );
    let workspace =
        assert_installation_failure(&fixture, &output, "fixture Git hook target is invalid");
    assert_eq!(
        fs::read_to_string(workspace.join(".git/hooks/pre-commit/original.txt")).unwrap(),
        "original bytes"
    );
}

#[test]
fn refuses_a_regular_file_in_place_of_the_hooks_directory() {
    let fixture = GeneratedFixture::new();
    fixture.set_declaration(hook_declaration());
    let output =
        fixture.invoke_with_git_boundary("rm -rf .git/hooks\nprintf 'original bytes' > .git/hooks");
    let workspace =
        assert_installation_failure(&fixture, &output, "fixture Git hooks directory is invalid");
    assert_eq!(
        fs::read_to_string(workspace.join(".git/hooks")).unwrap(),
        "original bytes"
    );
}

#[test]
fn refuses_a_symlink_hooks_directory_without_writing_outside_the_workspace() {
    let fixture = GeneratedFixture::new();
    fixture.set_declaration(hook_declaration());
    let external = fixture.0.join("external");
    let output = fixture.invoke_with_git_boundary(&format!(
        "rm -rf .git/hooks\nln -s {} .git/hooks",
        shell_quote(external.to_str().unwrap())
    ));
    let workspace =
        assert_installation_failure(&fixture, &output, "fixture Git hooks directory is invalid");
    assert_eq!(
        fs::read_link(workspace.join(".git/hooks")).unwrap(),
        external
    );
    assert_eq!(fs::read_dir(external).unwrap().count(), 1);
}
