use super::*;
use std::os::unix::fs::PermissionsExt;

fn fixture() -> Fixture {
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
    fs::write(fixture.root.join("auth.json"), "SYNTHETIC_AUTH\n").unwrap();
    fixture
}

fn invoke(fixture: &Fixture) -> Output {
    fixture.invoke(&[
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
    ])
}

fn refused(fixture: &Fixture, message: &str) {
    let output = invoke(fixture);
    assert_eq!(
        output.status.code(),
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout).lines().count(), 1);
    assert_eq!(result["exitCode"], 64);
    assert_eq!(
        result["diagnostic"],
        json!({"code":"sevro.invocation.invalid","message":message})
    );
    assert_eq!(result["execution"], json!({"status":"not_run"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    assert_eq!(result["evidencePath"], Value::Null);
    assert!(!fixture.root.join("native.called").exists());
    assert!(!fixture.root.join("results").exists());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("PRIVATE_PARSE_MARKER"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("PRIVATE_PARSE_MARKER"));
}

#[test]
fn malformed_toml_and_non_table_agents_are_preparation_errors() {
    let fixture = fixture();
    let path = fixture.root.join("config/.codex/config.toml");
    for (contents, prefix) in [
        (
            "[agents\nPRIVATE_PARSE_MARKER",
            "Invalid Codex configuration: ",
        ),
        ("agents=5", "Expected an agents table in "),
    ] {
        fs::write(&path, contents).unwrap();
        refused(&fixture, &format!("{prefix}{}", path.display()));
        assert_eq!(fs::read_to_string(&path).unwrap(), contents);
    }
}

#[test]
fn requires_a_positive_safe_toml_integer() {
    let fixture = fixture();
    let path = fixture.root.join("config/.codex/config.toml");
    for value in ["0", "-1", "1.5", "5.0", "\"5\"", "true", "9007199254740992"] {
        let contents = format!("[agents]\nmax_concurrent_threads_per_session = {value}\n");
        fs::write(&path, &contents).unwrap();
        refused(
            &fixture,
            &format!(
                "Expected a positive integer for agents.max_concurrent_threads_per_session in {}",
                path.display()
            ),
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), contents);
    }
    for value in [1_u64, 9_007_199_254_740_991] {
        fs::write(
            &path,
            format!("[agents]\nmax_concurrent_threads_per_session = {value}\n"),
        )
        .unwrap();
        let (_, evidence) = retained(&invoke(&fixture));
        assert_eq!(
            evidence["configuration"]["resolved"]["agentConcurrencyLimit"],
            value
        );
        assert_eq!(
            evidence["configuration"]["redacted"]["hostConfiguration"]["candidate"]["sevro.codex.agent-concurrency-limit"],
            value
        );
    }
    assert!(!fixture.root.join("native.called").exists());
}

#[test]
fn refuses_linked_or_nonregular_configuration_files() {
    let fixture = fixture();
    let path = fixture.root.join("config/.codex/config.toml");
    let target = fixture.root.join("config/target.toml");
    fs::write(
        &target,
        "[agents]\nmax_concurrent_threads_per_session = 7\n",
    )
    .unwrap();
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    let message = format!("Cannot read Codex configuration: {}", path.display());
    refused(&fixture, &message);
    assert_eq!(fs::read_link(&path).unwrap(), target);
    fs::remove_file(&target).unwrap();
    refused(&fixture, &message);
    assert!(fs::symlink_metadata(&path).unwrap().is_symlink());
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    refused(&fixture, &message);
    assert!(path.is_dir());
}

#[test]
fn bounds_configuration_files_to_64_kib() {
    let fixture = fixture();
    let path = fixture.root.join("config/.codex/config.toml");
    let oversized = format!("#{}", "x".repeat(64 * 1024));
    fs::write(&path, &oversized).unwrap();
    refused(
        &fixture,
        &format!("Cannot read Codex configuration: {}", path.display()),
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), oversized);
    fs::write(&path, &oversized[..64 * 1024]).unwrap();
    let (_, evidence) = retained(&invoke(&fixture));
    assert_eq!(
        evidence["configuration"]["resolved"]["agentConcurrencyLimit"],
        Value::Null
    );
}

#[test]
fn distinguishes_absent_settings_from_an_unusable_configuration_directory() {
    let fixture = fixture();
    let directory = fixture.root.join("config/.codex");
    let path = directory.join("config.toml");
    fs::remove_file(&path).unwrap();
    fs::remove_dir(&directory).unwrap();
    std::os::unix::fs::symlink(fixture.root.join("missing"), &directory).unwrap();
    let message = format!("Cannot read Codex configuration: {}", path.display());
    refused(&fixture, &message);
    fs::remove_file(&directory).unwrap();
    fs::write(&directory, "not a directory").unwrap();
    refused(&fixture, &message);
    fs::remove_file(&directory).unwrap();
    let (_, absent_directory) = retained(&invoke(&fixture));
    assert_eq!(
        absent_directory["configuration"]["resolved"]["agentConcurrencyLimit"],
        Value::Null
    );
    fs::create_dir(&directory).unwrap();
    let (_, absent_file) = retained(&invoke(&fixture));
    assert_eq!(
        absent_file["configuration"]["resolved"]["agentConcurrencyLimit"],
        Value::Null
    );
    for contents in ["", "model=\"ignored\"\n", "[agents]\nenabled=true\n"] {
        fs::write(&path, contents).unwrap();
        let (_, evidence) = retained(&invoke(&fixture));
        assert_eq!(
            evidence["configuration"]["resolved"]["agentConcurrencyLimit"],
            Value::Null
        );
        assert_eq!(
            evidence["configuration"]["redacted"]["hostConfiguration"]["candidate"]["sevro.codex.agent-concurrency-limit"],
            Value::Null
        );
    }
}

#[test]
fn requires_configuration_containment_but_allows_a_contained_directory_link() {
    let fixture = fixture();
    let directory = fixture.root.join("config/.codex");
    let path = directory.join("config.toml");
    fs::remove_file(&path).unwrap();
    fs::remove_dir(&directory).unwrap();
    let outside = fixture.root.join("outside");
    fs::create_dir(&outside).unwrap();
    let contents = "[agents]\nmax_concurrent_threads_per_session = 7\n";
    fs::write(outside.join("config.toml"), contents).unwrap();
    std::os::unix::fs::symlink(&outside, &directory).unwrap();
    refused(
        &fixture,
        &format!("Cannot read Codex configuration: {}", path.display()),
    );
    assert_eq!(
        fs::read_to_string(outside.join("config.toml")).unwrap(),
        contents
    );
    fs::remove_file(&directory).unwrap();
    let inside = fixture.root.join("config/inside");
    fs::rename(&outside, &inside).unwrap();
    std::os::unix::fs::symlink(&inside, &directory).unwrap();
    let (_, evidence) = retained(&invoke(&fixture));
    assert_eq!(
        evidence["configuration"]["resolved"]["agentConcurrencyLimit"],
        7
    );
    assert_eq!(fs::read_link(&directory).unwrap(), inside);
    assert_eq!(fs::read_to_string(&path).unwrap(), contents);
}

#[test]
fn classifies_a_large_integer_as_an_invalid_limit() {
    let fixture = fixture();
    let path = fixture.root.join("config/.codex/config.toml");
    let contents = "[agents]\nmax_concurrent_threads_per_session = 9223372036854775808\n";
    fs::write(&path, contents).unwrap();
    refused(
        &fixture,
        &format!(
            "Expected a positive integer for agents.max_concurrent_threads_per_session in {}",
            path.display()
        ),
    );
    assert_eq!(fs::read_to_string(path).unwrap(), contents);
}

#[test]
fn ignores_an_unrelated_large_integer() {
    let fixture = fixture();
    let path = fixture.root.join("config/.codex/config.toml");
    let contents =
        "unrelated=9223372036854775808\n[agents]\nmax_concurrent_threads_per_session = 7\n";
    fs::write(&path, contents).unwrap();
    let (_, evidence) = retained(&invoke(&fixture));
    assert_eq!(
        evidence["configuration"]["resolved"]["agentConcurrencyLimit"],
        7
    );
    assert_eq!(
        evidence["configuration"]["redacted"]["hostConfiguration"]["candidate"]["sevro.codex.agent-concurrency-limit"],
        7
    );
    assert!(!evidence.to_string().contains("9223372036854775808"));
    assert_eq!(fs::read_to_string(path).unwrap(), contents);
    assert!(!fixture.root.join("native.called").exists());
}
