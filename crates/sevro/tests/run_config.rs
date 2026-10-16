use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use uuid::Uuid;

#[path = "run_config/native_codex.rs"]
mod native_codex;

#[path = "run_config/validation.rs"]
mod validation;

const UNSELECTED_CODEX_CONFIGURATION: &str = "[agents\nPRIVATE_UNRELATED_CONFIG_MARKER\n";

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("sevro-rust-config-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        for name in ["project", "config", "home", "tmp"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        fs::create_dir(root.join("config/.codex")).unwrap();
        fs::write(
            root.join("config/.codex/config.toml"),
            UNSELECTED_CODEX_CONFIGURATION,
        )
        .unwrap();
        fs::write(
            root.join("project/case.json"),
            serde_json::to_vec(&json!({
                "id":"config-ready", "prompt":"Return ready.",
                "fixture":{"files":{"README.md":"fixture\n"}},
                "checks":[{"id":"ready","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
                "requiredEvidence":[]
            }))
            .unwrap(),
        )
        .unwrap();
        Self { root }
    }

    fn invoke(&self, selected: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_sevro"))
            .args([
                "run",
                "--json",
                "--case-file",
                "project/case.json",
                "--project-root",
                "project",
                "--config-root",
                "config",
                "--results-root",
                "results",
                "--runner-build-digest",
            ])
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64))
            .args(selected)
            .current_dir(&self.root)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("HOME", self.root.join("home"))
            .env("TMPDIR", self.root.join("tmp"))
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn retained(output: &Output) -> (Value, Value) {
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout).lines().count(), 1);
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let evidence: Value = serde_json::from_slice(
        &fs::read(Path::new(result["evidencePath"].as_str().unwrap())).unwrap(),
    )
    .unwrap();
    assert_eq!(evidence["result"], result);
    (result, evidence)
}

#[test]
fn ignores_codex_configuration_on_an_adapter_route() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("adapter.ts"),
        format!(
            "import {{appendFileSync}} from 'node:fs';\nexport default {{id:'example.host.config',model:'synthetic',effort:'none',configuration:{{'example.setting':'kept'}},async run(){{appendFileSync({},'run\\n');return {{finalMessage:'ready',complete:true}}}}}};\n",
            json!(fixture.root.join("adapter-called").to_str().unwrap())
        ),
    )
    .unwrap();
    let output = fixture.invoke(&["--adapter-module", "adapter.ts"]);
    let (result, evidence) = retained(&output);
    assert_eq!(result["execution"], json!({"status":"completed"}));
    assert_eq!(result["grading"], json!({"status":"completed"}));
    assert_eq!(result["task"], json!({"verdict":"passed"}));
    assert_eq!(result["exitCode"], 0);
    assert_eq!(
        evidence["configuration"]["redacted"]["hostConfiguration"],
        json!({"candidate":{"example.setting":"kept"}})
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["agentConcurrencyLimit"],
        Value::Null
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["configRoot"],
        fixture.root.join("config").to_str().unwrap()
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("adapter-called")).unwrap(),
        "run\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("config/.codex/config.toml")).unwrap(),
        UNSELECTED_CODEX_CONFIGURATION
    );
    for public in [
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        evidence.to_string(),
    ] {
        assert!(!public.contains("PRIVATE_UNRELATED_CONFIG_MARKER"));
    }
}

#[test]
fn ignores_codex_configuration_on_a_claude_dry_route() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("native"),
        "#!/bin/sh\nprintf called > \"$0.called\"\nexit 97\n",
    )
    .unwrap();
    fs::set_permissions(
        fixture.root.join("native"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    fs::write(
        fixture.root.join("credential.json"),
        "SYNTHETIC_DRY_CREDENTIAL\n",
    )
    .unwrap();
    let output = fixture.invoke(&[
        "--dry",
        "--host",
        "claude",
        "--claude-bin",
        "./native",
        "--claude-credential-file",
        "credential.json",
        "--model",
        "synthetic",
        "--effort",
        "low",
    ]);
    let (result, evidence) = retained(&output);
    assert_eq!(result["execution"], json!({"status":"not_run"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    assert_eq!(result["exitCode"], 0);
    assert_eq!(
        evidence["configuration"]["redacted"]["hostConfiguration"],
        json!({"candidate":{"sevro.host.executable":fixture.root.join("native")}})
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["agentConcurrencyLimit"],
        Value::Null
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["configRoot"],
        fixture.root.join("config").to_str().unwrap()
    );
    assert!(!fixture.root.join("native.called").exists());
    assert!(!fixture.root.join("home/.claude").exists());
    assert_eq!(
        fs::read_to_string(fixture.root.join("config/.codex/config.toml")).unwrap(),
        UNSELECTED_CODEX_CONFIGURATION
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("credential.json")).unwrap(),
        "SYNTHETIC_DRY_CREDENTIAL\n"
    );
    for public in [
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        evidence.to_string(),
    ] {
        assert!(!public.contains("PRIVATE_UNRELATED_CONFIG_MARKER"));
        assert!(!public.contains("SYNTHETIC_DRY_CREDENTIAL"));
    }
}
