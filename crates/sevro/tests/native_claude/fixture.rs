use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard};
use uuid::Uuid;

pub(super) struct Run {
    pub(super) trial: Value,
    workspace: PathBuf,
}

impl Drop for Run {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.workspace);
    }
}

pub(super) fn failed_run(fixture: &Fixture) -> Run {
    let output = fixture.command().output().unwrap();
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = evidence["trials"][0].clone();
    let workspace = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|observation| observation["id"] == "sevro.observation.workspaces")
        .unwrap()["data"]["candidate"]
        .as_str()
        .unwrap()
        .into();
    let failure = Run { trial, workspace };
    assert_eq!(output.status.code(), Some(2), "{result}");
    assert_eq!(result["execution"], json!({"status":"failed"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    assert_eq!(
        result["diagnostic"],
        json!({"code":"sevro.host.failed","message":"host execution did not complete"})
    );
    assert_eq!(result["cases"][0]["trials"][0]["checks"], json!([]));
    assert!(failure.workspace.is_dir());
    for text in [
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        evidence.to_string(),
    ] {
        assert!(
            !text.contains(&"x".repeat(128)),
            "private stderr overflow leaked"
        );
        for secret in [
            "SYNTHETIC_CLAUDE_LOGIN",
            "SYNTHETIC_CALLER_API_SENTINEL",
            "SYNTHETIC_CALLER_OAUTH_SENTINEL",
        ] {
            assert!(!text.contains(secret));
        }
    }
    failure
}

pub(super) fn completed_run(fixture: &Fixture) -> Run {
    let output = fixture.command().output().unwrap();
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = evidence["trials"][0].clone();
    let workspace = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|observation| observation["id"] == "sevro.observation.workspaces")
        .unwrap()["data"]["candidate"]
        .as_str()
        .unwrap()
        .into();
    let run = Run { trial, workspace };
    assert_eq!(output.status.code(), Some(0), "{result}");
    assert_eq!(result["execution"], json!({"status":"completed"}));
    assert_eq!(result["grading"], json!({"status":"completed"}));
    assert_eq!(result["task"], json!({"verdict":"passed"}));
    assert_eq!(
        result["cases"][0]["trials"][0]["checks"][0]["status"],
        "passed"
    );
    assert!(!run.workspace.exists());
    let probe = read_json(&fixture.root.join("binary/capture.json"));
    for (name, value) in probe["checks"].as_object().unwrap() {
        assert_eq!(value, true, "native fixture check: {name}");
    }
    for path in probe["privatePaths"].as_object().unwrap().values() {
        assert!(
            !Path::new(path.as_str().unwrap()).exists(),
            "private state survived: {path}"
        );
    }
    assert_eq!(
        fs::read_to_string(fixture.root.join("project/credential.json")).unwrap(),
        "{\"test\":\"SYNTHETIC_CLAUDE_LOGIN\"}"
    );
    fixture.assert_private_state_removed();
    for text in [
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        evidence.to_string(),
    ] {
        for secret in [
            "SYNTHETIC_CLAUDE_LOGIN",
            "SYNTHETIC_CALLER_API_SENTINEL",
            "SYNTHETIC_CALLER_OAUTH_SENTINEL",
            "private commentary",
        ] {
            assert!(!text.contains(secret));
        }
    }
    run
}

pub(super) fn assert_no_response(trial: &Value) {
    assert_eq!(
        trial["rawResult"],
        json!({"source":"sevro.host.claude","path":null,"sha256":null})
    );
    assert_eq!(trial["artifactRefs"], json!([]));
    assert_eq!(
        trial["usage"],
        json!({"inputTokens":null,"outputTokens":null,"costUsd":null,"complete":false})
    );
}

static NATIVE_STATE: Mutex<()> = Mutex::new(());

pub(super) struct Fixture {
    pub(super) root: PathBuf,
    namespace: PathBuf,
    existing_states: BTreeSet<PathBuf>,
    _guard: MutexGuard<'static, ()>,
}

impl Fixture {
    pub(super) fn new() -> Self {
        let guard = NATIVE_STATE.lock().unwrap();
        let root = std::env::temp_dir().join(format!("sevro-rust-claude-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        for name in ["project", "binary", "temporary", "caller-home"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        fs::write(
            root.join("project/credential.json"),
            "{\"test\":\"SYNTHETIC_CLAUDE_LOGIN\"}",
        )
        .unwrap();
        fs::set_permissions(
            root.join("project/credential.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        fs::write(root.join("project/case.json"), serde_json::to_vec(&json!({
            "id":"native-claude-ready", "prompt":"Return ready.",
            "fixture":{"files":{"README.md":"fixture\n"}},
            "checks":[{"id":"final-ready","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
            "requiredEvidence":["sevro.claude.events"]
        })).unwrap()).unwrap();
        let bun = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|path| path.join("bun"))
            .find(|path| path.is_file())
            .expect("native Claude fixture requires Bun");
        let script = format!("#!{}\n{}", bun.display(), WRAPPER)
            .replace(
                "@PROJECT@",
                &serde_json::to_string(&root.join("project")).unwrap(),
            )
            .replace(
                "@RESULTS@",
                &serde_json::to_string(&root.join("project/results")).unwrap(),
            )
            .replace(
                "@CAPTURE@",
                &serde_json::to_string(&root.join("binary/capture.json")).unwrap(),
            );
        fs::write(root.join("binary/claude-wrapper"), script).unwrap();
        fs::set_permissions(
            root.join("binary/claude-wrapper"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        #[cfg(target_os = "linux")]
        let namespace = PathBuf::from("/var/tmp/sevro-native-private");
        #[cfg(not(target_os = "linux"))]
        let namespace = root.join("temporary/sevro-native-private");
        let existing_states = claude_states(&namespace);
        Self {
            root,
            namespace,
            existing_states,
            _guard: guard,
        }
    }

    pub(super) fn assert_private_state_removed(&self) {
        assert_eq!(claude_states(&self.namespace), self.existing_states);
    }

    pub(super) fn append_native_source(&self, suffix: &str) {
        let binary = self.root.join("binary/claude-wrapper");
        let mut script = fs::read_to_string(&binary).unwrap();
        script.push_str(suffix);
        fs::write(binary, script).unwrap();
    }

    pub(super) fn replace_native_source(&self, from: &str, to: &str) {
        let binary = self.root.join("binary/claude-wrapper");
        let script = fs::read_to_string(&binary).unwrap();
        assert_eq!(script.matches(from).count(), 1);
        fs::write(binary, script.replace(from, to)).unwrap();
    }

    pub(super) fn assert_failed_state(&self, failure: &Run) {
        let probe = read_json(&self.root.join("binary/capture.json"));
        for (name, value) in probe["checks"].as_object().unwrap() {
            assert_eq!(value, true, "native fixture check: {name}");
        }
        assert_eq!(Path::new(probe["cwd"].as_str().unwrap()), failure.workspace);
        for key in [
            "stateRoot",
            "privateRoot",
            "configRoot",
            "credential",
            "settingsPath",
        ] {
            assert!(
                !Path::new(probe["privatePaths"][key].as_str().unwrap()).exists(),
                "private state survived: {key}"
            );
        }
        for key in ["home", "temp"] {
            assert!(Path::new(probe["privatePaths"][key].as_str().unwrap()).is_dir());
        }
        assert_eq!(
            fs::read_to_string(self.root.join("project/credential.json")).unwrap(),
            "{\"test\":\"SYNTHETIC_CLAUDE_LOGIN\"}"
        );
        self.assert_private_state_removed();
    }

    pub(super) fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_sevro"));
        command
            .current_dir(self.root.join("project"))
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("LANG", "C")
            .env("HOME", self.root.join("caller-home"))
            .env("TMPDIR", self.root.join("temporary"))
            .env("ANTHROPIC_API_KEY", "SYNTHETIC_CALLER_API_SENTINEL")
            .env("CLAUDE_CODE_OAUTH_TOKEN", "SYNTHETIC_CALLER_OAUTH_SENTINEL")
            .env(
                "CLAUDE_CONFIG_DIR",
                self.root.join("caller-home/caller-claude"),
            )
            .env("CODEX_HOME", self.root.join("caller-home/caller-codex"))
            .env("DARROW_CACHE_DIR", "SYNTHETIC_CALLER_CACHE_SENTINEL")
            .env(
                "SEVRO_NATIVE_PRIVATE_SENTINEL",
                "SYNTHETIC_CALLER_PRIVATE_SENTINEL",
            )
            .args([
                "run",
                "--json",
                "--case-file",
                "case.json",
                "--project-root",
                ".",
                "--results-root",
                "results",
                "--host",
                "claude",
                "--claude-bin",
            ])
            .arg(self.root.join("binary/claude-wrapper"))
            .args([
                "--claude-credential-file",
                "credential.json",
                "--model",
                "sonnet",
                "--effort",
                "low",
                "--runner-build-digest",
            ])
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64));
        if let Some(profile) = std::env::var_os("LLVM_PROFILE_FILE") {
            command.env("LLVM_PROFILE_FILE", profile);
        }
        command
    }
}

fn claude_states(namespace: &Path) -> BTreeSet<PathBuf> {
    match fs::read_dir(namespace) {
        Ok(entries) => entries
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("claude-")
            })
            .collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeSet::new(),
        Err(error) => panic!("native state namespace unavailable: {error}"),
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub(super) fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
pub(super) fn artifact_path(value: &Value) -> PathBuf {
    url::Url::parse(value.as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap()
}

const WRAPPER: &str = r#"import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
const argv = process.argv.slice(2);
const settingsPath = argv[argv.indexOf("--settings") + 1];
const settings = JSON.parse(await readFile(settingsPath, "utf8"));
const configRoot = process.env.CLAUDE_CONFIG_DIR;
const credential = join(configRoot, ".credentials.json");
const privateRoot = dirname(configRoot);
const stateRoot = dirname(privateRoot);
const credentialBytes = await readFile(credential);
const mode = async (path) => (await stat(path)).mode & 0o777;
const inside = (root, path) => {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix));
};
const protectedPaths = [@PROJECT@, @RESULTS@, privateRoot, stateRoot];
const filesystem = settings.sandbox.filesystem;
const checks = {
  explicitCredentialCopied: credentialBytes.toString() === '{"test":"SYNTHETIC_CLAUDE_LOGIN"}',
  copiedCredentialPrivate: await mode(credential) === 0o600,
  settingsPrivate: await mode(settingsPath) === 0o600,
  configPrivate: await mode(configRoot) === 0o700,
  statePrivate: await mode(stateRoot) === 0o700,
  privateRootPrivate: await mode(privateRoot) === 0o700,
  homePrivate: await mode(process.env.HOME) === 0o700,
  tempPrivate: await mode(process.env.TMPDIR) === 0o700,
  homeInsideGitPrivateRuntime: inside(join(process.cwd(), ".git", "sevro-runtime", "candidate"), process.env.HOME),
  tempInsideGitPrivateRuntime: inside(join(process.cwd(), ".git", "sevro-runtime", "candidate"), process.env.TMPDIR),
  selectedSettingsPrivate: dirname(settingsPath) === privateRoot,
  hooksDisabled: settings.disableAllHooks === true,
  sandboxRequired: settings.sandbox.enabled === true && settings.sandbox.allowUnsandboxedCommands === false && settings.sandbox.failIfUnavailable === true,
  credentialFileDenied: settings.sandbox.credentials.files.some((item) => item.path === credential && item.mode === "deny"),
  credentialEnvironmentDenied: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].every((name) => settings.sandbox.credentials.envVars.some((item) => item.name === name && item.mode === "deny")),
  protectedReadsConfigured: protectedPaths.every((path) => filesystem.denyRead.some((root) => inside(root, path))),
  protectedWritesConfigured: [@PROJECT@, @RESULTS@, privateRoot].every((path) => filesystem.denyWrite.some((root) => inside(root, path))),
  noWriteTool: !settings.permissions.allow.includes("Write"),
  explicitFileOverridesCallerCredentials: !Object.hasOwn(process.env, "ANTHROPIC_API_KEY") && !Object.hasOwn(process.env, "CLAUDE_CODE_OAUTH_TOKEN"),
  callerOverridesExcluded: ["SEVRO_NATIVE_PRIVATE_SENTINEL", "DARROW_CACHE_DIR", "CODEX_HOME"].every((name) => !Object.hasOwn(process.env, name)),
  subprocessScrubbingEnabled: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === "1",
  environmentNoColor: process.env.NO_COLOR === "1",
  stdinIgnored: await Bun.stdin.text() === "",
  preparedFixtureReadable: await readFile("README.md", "utf8") === "fixture\n",
};
const expectedArgv = ["-p", "Return ready.", "--output-format", "stream-json", "--verbose", "--model", "sonnet", "--effort", "low", "--permission-mode", "dontAsk", "--tools", "Bash,Read,Edit,Skill,Agent", "--setting-sources", "", "--settings", settingsPath, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-chrome"];
checks.exactArguments = JSON.stringify(argv) === JSON.stringify(expectedArgv);
await writeFile(@CAPTURE@, JSON.stringify({argv, settingsPath, settings, cwd:process.cwd(), environment:process.env, checks,
  privatePaths:{stateRoot, privateRoot, configRoot, credential, settingsPath, home:process.env.HOME, temp:process.env.TMPDIR},
  credentialSha256:createHash("sha256").update(credentialBytes).digest("hex")}, null, 2));
if (!Object.values(checks).every(Boolean)) process.exit(90);
process.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"ready","usage":{"input_tokens":1,"output_tokens":2},"total_cost_usd":0.01}\n');
"#;
