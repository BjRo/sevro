use super::*;
use std::os::unix::fs::PermissionsExt;

const SELECTED: &str =
    "model = \"UNRELATED_CONFIG_MARKER\"\n[agents]\nmax_concurrent_threads_per_session = 7\n";
const PROJECT: &str = "[agents]\nmax_concurrent_threads_per_session = 3\n";
const AUTH: &str = "SYNTHETIC_CONFIG_IMPORT_AUTH\n";

fn native_fixture() -> Fixture {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("config/.codex/config.toml"), SELECTED).unwrap();
    fs::create_dir(fixture.root.join("project/.codex")).unwrap();
    fs::write(fixture.root.join("project/.codex/config.toml"), PROJECT).unwrap();
    fs::write(fixture.root.join("project/auth.json"), AUTH).unwrap();
    fs::set_permissions(
        fixture.root.join("project/auth.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    fs::create_dir(fixture.root.join("binary")).unwrap();
    let codex = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|directory| directory.join("codex"))
        .find(|path| path.is_file())
        .expect("native configuration integration requires the installed Codex CLI");
    let codex = fs::canonicalize(codex).unwrap();
    let script = r#"#!/bin/sh
umask 077
if [ "$1" = --version ]; then printf 'synthetic-config-oracle\n'; exit 0; fi
if [ "$1" = sandbox ]; then shift; exec @CODEX@ sandbox "$@"; fi
if [ "$1" != exec ]; then exit 99; fi
/bin/cat "$CODEX_HOME/config.toml" > @OBSERVED@ || exit 98
printf '%s\n' "$CODEX_HOME" "$HOME" "$TMPDIR" "$PWD" > @NATIVE_PATHS@
/usr/bin/grep -q '^max_concurrent_threads_per_session = 7$' "$CODEX_HOME/config.toml" || exit 97
if /usr/bin/grep -q UNRELATED_CONFIG_MARKER "$CODEX_HOME/config.toml"; then exit 96; fi
if [ "$(/bin/cat "$CODEX_HOME/auth.json")" != SYNTHETIC_CONFIG_IMPORT_AUTH ]; then exit 95; fi
if [ "$(/bin/cat)" != 'Return ready.' ]; then exit 94; fi
printf '%s\n' '{"type":"thread.started","thread_id":"config-oracle-thread"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
"#
    .replace("@CODEX@", &quote(&codex))
    .replace(
        "@OBSERVED@",
        &quote(&fixture.root.join("binary/profile-observed.toml")),
    )
    .replace(
        "@NATIVE_PATHS@",
        &quote(&fixture.root.join("binary/native-paths.txt")),
    );
    fs::write(fixture.root.join("binary/codex-wrapper"), script).unwrap();
    fs::set_permissions(
        fixture.root.join("binary/codex-wrapper"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    #[cfg(target_os = "linux")]
    std::os::unix::fs::symlink(codex, fixture.root.join("binary/codex-linux-sandbox")).unwrap();
    fixture
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\"'\"'"))
}

fn invoke(fixture: &Fixture, arguments: &[&str]) -> Output {
    let mut selected = vec![
        "--host",
        "codex",
        "--codex-bin",
        "binary/codex-wrapper",
        "--codex-auth-file",
        "project/auth.json",
        "--model",
        "synthetic-codex",
        "--effort",
        "low",
    ];
    selected.extend(arguments);
    fixture.invoke(&selected)
}

#[test]
fn imports_only_the_selected_codex_agent_limit() {
    let fixture = native_fixture();
    let output = invoke(&fixture, &[]);
    let (result, evidence) = retained(&output);
    assert_eq!(result["execution"], json!({"status":"completed"}));
    assert_eq!(result["grading"], json!({"status":"completed"}));
    assert_eq!(result["task"], json!({"verdict":"passed"}));
    assert_eq!(
        evidence["configuration"]["redacted"]["hostConfiguration"],
        json!({"candidate":{
            "sevro.codex.agent-concurrency-limit":7,
            "sevro.host.executable":fixture.root.join("binary/codex-wrapper")
        }})
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["agentConcurrencyLimit"],
        7
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["configRoot"],
        fixture.root.join("config").to_str().unwrap()
    );
    assert_eq!(
        evidence["configuration"]["digest"],
        evidence["evaluationIdentity"]["dimensions"]["configurationDigest"]
    );
    let usage = &evidence["trials"][0]["usage"];
    assert_eq!(usage["inputTokens"].as_f64(), Some(1.0));
    assert_eq!(usage["outputTokens"].as_f64(), Some(1.0));
    assert_eq!(usage["costUsd"], Value::Null);
    assert_eq!(usage["complete"], true);
    let profile = fs::read_to_string(fixture.root.join("binary/profile-observed.toml")).unwrap();
    assert!(profile.contains("\n[agents]\nmax_concurrent_threads_per_session = 7\n"));
    let paths = fs::read_to_string(fixture.root.join("binary/native-paths.txt")).unwrap();
    assert_eq!(paths.lines().count(), 4);
    for path in paths.lines() {
        assert!(!Path::new(path).exists(), "retained private state: {path}");
    }
    for (path, expected) in [
        ("config/.codex/config.toml", SELECTED),
        ("project/.codex/config.toml", PROJECT),
        ("project/auth.json", AUTH),
    ] {
        assert_eq!(
            fs::read_to_string(fixture.root.join(path)).unwrap(),
            expected
        );
    }
    for public in [
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        evidence.to_string(),
        profile,
    ] {
        assert!(!public.contains("UNRELATED_CONFIG_MARKER"));
        assert!(!public.contains(AUTH.trim()));
    }
}

#[test]
fn identity_tracks_the_limit_but_not_unrelated_settings_or_configuration_location() {
    let fixture = native_fixture();
    let (_, original) = retained(&invoke(&fixture, &["--dry"]));
    fs::write(
        fixture.root.join("config/.codex/config.toml"),
        "[agents]\nmax_concurrent_threads_per_session = 9\n",
    )
    .unwrap();
    let (_, changed) = retained(&invoke(&fixture, &["--dry"]));
    assert_eq!(
        changed["configuration"]["resolved"]["agentConcurrencyLimit"],
        9
    );
    assert_ne!(
        original["configuration"]["digest"],
        changed["configuration"]["digest"]
    );
    assert_ne!(
        original["evaluationIdentity"]["digest"],
        changed["evaluationIdentity"]["digest"]
    );
    fs::write(
        fixture.root.join("config/.codex/config.toml"),
        "[agents]\nmax_concurrent_threads_per_session = 7\n",
    )
    .unwrap();
    let (_, restored) = retained(&invoke(&fixture, &["--dry"]));
    fs::rename(fixture.root.join("config"), fixture.root.join("relocated")).unwrap();
    fs::write(
        fixture.root.join("relocated/.codex/config.toml"),
        "model = \"OTHER_IGNORED\"\n[agents]\nmax_concurrent_threads_per_session = 7\n",
    )
    .unwrap();
    let (_, moved) = retained(&invoke(&fixture, &["--dry", "--config-root", "relocated"]));
    for same in [&restored, &moved] {
        assert_eq!(
            original["configuration"]["digest"],
            same["configuration"]["digest"]
        );
        assert_eq!(
            original["evaluationIdentity"]["digest"],
            same["evaluationIdentity"]["digest"]
        );
    }
    assert_eq!(
        moved["configuration"]["resolved"]["configRoot"],
        fixture.root.join("relocated").to_str().unwrap()
    );
    assert!(!fixture.root.join("binary/native-paths.txt").exists());
}

#[test]
fn snapshots_the_limit_across_trials_and_reloads_on_the_next_invocation() {
    let fixture = native_fixture();
    let binary = fixture.root.join("binary/codex-wrapper");
    let observed = fixture.root.join("binary/snapshot-limits.txt");
    let configuration = fixture.root.join("config/.codex/config.toml");
    let script = fs::read_to_string(&binary).unwrap().replace(
        "/usr/bin/grep -q '^max_concurrent_threads_per_session = 7$' \"$CODEX_HOME/config.toml\" || exit 97",
        &format!(
            "/usr/bin/grep '^max_concurrent_threads_per_session = ' \"$CODEX_HOME/config.toml\" >> {}\nprintf '[agents]\\nmax_concurrent_threads_per_session = 9\\n' > {}",
            quote(&observed),
            quote(&configuration),
        ),
    );
    fs::write(binary, script).unwrap();
    let (result, evidence) = retained(&invoke(&fixture, &["--trials", "2", "--jobs", "1"]));
    assert_eq!(result["task"]["verdict"], "passed");
    assert_eq!(evidence["trials"].as_array().unwrap().len(), 2);
    assert_eq!(
        evidence["configuration"]["resolved"]["agentConcurrencyLimit"],
        7
    );
    assert_eq!(
        evidence["configuration"]["redacted"]["hostConfiguration"]["candidate"]["sevro.codex.agent-concurrency-limit"],
        7
    );
    assert_eq!(
        fs::read_to_string(&observed).unwrap(),
        "max_concurrent_threads_per_session = 7\nmax_concurrent_threads_per_session = 7\n"
    );
    let (next_result, next) = retained(&invoke(&fixture, &[]));
    assert_eq!(next_result["task"]["verdict"], "passed");
    assert_eq!(
        next["configuration"]["resolved"]["agentConcurrencyLimit"],
        9
    );
    assert_eq!(
        next["configuration"]["redacted"]["hostConfiguration"]["candidate"]["sevro.codex.agent-concurrency-limit"],
        9
    );
    assert_eq!(
        fs::read_to_string(observed).unwrap(),
        "max_concurrent_threads_per_session = 7\nmax_concurrent_threads_per_session = 7\nmax_concurrent_threads_per_session = 9\n"
    );
    assert_eq!(
        fs::read_to_string(configuration).unwrap(),
        "[agents]\nmax_concurrent_threads_per_session = 9\n"
    );
}
