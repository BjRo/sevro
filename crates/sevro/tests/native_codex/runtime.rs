use super::*;

#[test]
fn applies_selected_empty_runtime_and_retains_evidence() {
    let fixture = runtime_fixture();
    fs::write(
        fixture.root.join("project/runtime.json"),
        "{\"format\":\"sevro.runtime.v1\"}\n",
    )
    .unwrap();
    let output = fixture
        .command()
        .env_remove("UV_OFFLINE")
        .env_remove("PYTHONDONTWRITEBYTECODE")
        .args(["--runtime-config-file", "runtime.json"])
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"]["status"], "completed");
    assert_eq!(result["grading"]["status"], "completed");
    assert_eq!(result["task"]["verdict"], "passed");
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = &evidence["trials"][0];
    assert_eq!(
        fs::read(artifact_path(&trial["rawResult"]["path"])).unwrap(),
        b"uv=1;py=1"
    );
    assert_eq!(
        trial["rawResult"]["sha256"],
        "de0a58092a1234b49f85f03fe2f88017b85af1e76fe6d734fb75461dbd9698b7"
    );
    assert_eq!(
        evidence["configuration"]["redacted"]["runtimePolicy"],
        json!({"format":"sevro.runtime.v1", "environment":{}, "readOnlyRoots":[],
            "discovery":[], "skippedOptionalReadOnlyRoots":[], "seeds":[],
            "hooks":{"nativeGoal":false,"plugins":[]}})
    );
    let observations = trial["observations"].as_array().unwrap();
    let runtime = observations
        .iter()
        .find(|row| row["id"] == "sevro.host.runtime")
        .unwrap();
    assert_eq!(
        runtime,
        &json!({"id":"sevro.host.runtime", "source":"sevro.host.codex",
            "completeness":"complete", "data":{
                "method":"runner_configuration", "role":"candidate",
                "policyDigest":"020bd151fdaee9ab5143114da14ff91278577c0af71901ff7f35f0d5c765036c",
                "environmentNames":[], "readOnlyRoots":[], "discovery":[],
                "skippedOptionalReadOnlyRoots":[], "seeds":[]}})
    );
    let workspace = observations
        .iter()
        .find(|row| row["id"] == "sevro.observation.workspaces")
        .unwrap()["data"]["candidate"]
        .as_str()
        .unwrap();
    assert!(!Path::new(workspace).exists());
    assert_private_cleanup(&fixture, Path::new(workspace));
}

#[test]
fn absent_policy_keeps_defaults_and_runtime_evidence_unavailable() {
    let fixture = runtime_fixture();
    let output = fixture
        .command()
        .env_remove("UV_OFFLINE")
        .env_remove("PYTHONDONTWRITEBYTECODE")
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(4),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"]["status"], "completed");
    assert_eq!(result["grading"]["status"], "unavailable");
    assert_eq!(result["task"]["verdict"], "failed");
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    assert!(
        evidence["configuration"]["redacted"]
            .get("runtimePolicy")
            .is_none()
    );
    let trial = &evidence["trials"][0];
    assert_eq!(
        fs::read(artifact_path(&trial["rawResult"]["path"])).unwrap(),
        b"uv=;py="
    );
    assert_eq!(
        trial["rawResult"]["sha256"],
        "c30740aa61aa22015678ff3c0f12c4ac920f39bd48a157e4b1c6e594ba3cb483"
    );
    let observations = trial["observations"].as_array().unwrap();
    assert!(
        !observations
            .iter()
            .any(|row| row["id"] == "sevro.host.runtime")
    );
    let workspace = observations
        .iter()
        .find(|row| row["id"] == "sevro.observation.workspaces")
        .unwrap()["data"]["candidate"]
        .as_str()
        .unwrap();
    assert!(Path::new(workspace).is_dir());
    assert_private_cleanup(&fixture, Path::new(workspace));
    fs::remove_dir_all(workspace).unwrap();
}

fn runtime_fixture() -> Fixture {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("project/case.json"),
        serde_json::to_vec(&json!({
            "id":"empty-runtime-policy", "prompt":"Run the runtime environment probe.",
            "fixture":{"files":{"probe.sh":PROBE}},
            "checks":[{"id":"runtime-output", "grader":"sevro.output",
                "configuration":{"expectExact":"uv=1;py=1"}}],
            "requiredEvidence":["sevro.host.runtime"]
        }))
        .unwrap(),
    )
    .unwrap();
    let wrapper = WRAPPER
        .replace("@CODEX@", &quote(&installed_codex()))
        .replace("@AUTH@", &quote(&fixture.root.join("project/auth.json")))
        .replace(
            "@STATE@",
            &quote(&fixture.root.join("binary/native-state-paths")),
        )
        .replace(
            "@COMMAND@",
            &quote(&fixture.root.join("binary/command-state-paths")),
        );
    fs::write(fixture.root.join("binary/codex-wrapper"), wrapper).unwrap();
    fixture
}

fn assert_private_cleanup(fixture: &Fixture, workspace: &Path) {
    assert_state_removed(fixture);
    let paths = fs::read_to_string(fixture.root.join("binary/command-state-paths")).unwrap();
    let paths: Vec<_> = paths.lines().collect();
    assert_eq!(paths.len(), 3);
    for path in &paths {
        assert!(
            !Path::new(path).exists(),
            "private command state survived: {path}"
        );
        assert!(!Path::new(path).starts_with(workspace));
    }
    assert_eq!(paths[2], format!("{}/", paths[1]));
    assert_eq!(
        fs::read(fixture.root.join("project/auth.json")).unwrap(),
        b"FAKE_NATIVE_TEST_CREDENTIAL\n"
    );
}

const PROBE: &str = r#"#!/bin/sh
set -eu
printf '%s\n' "$HOME" "$TMPDIR" "${TMPPREFIX-}" > runtime-private-paths
printf owned-home > "$HOME/runtime-home-marker"
printf owned-temp > "$TMPDIR/runtime-temp-marker"
test "$(/bin/cat "$HOME/runtime-home-marker")" = owned-home
test "$(/bin/cat "$TMPDIR/runtime-temp-marker")" = owned-temp
for protected in "$@"; do
  if /bin/cat "$protected" >/dev/null 2>&1; then exit 89; fi
done
printf 'uv=%s;py=%s' "${UV_OFFLINE-}" "${PYTHONDONTWRITEBYTECODE-}"
"#;

const WRAPPER: &str = r#"#!/bin/sh
if [ "$1" = --version ]; then printf 'synthetic-runtime-oracle\n'; exit 0; fi
if [ "$1" = sandbox ]; then shift; exec @CODEX@ sandbox "$@"; fi
if [ "$1" != exec ]; then exit 99; fi
if [ -n "${SEVRO_NATIVE_PRIVATE_SENTINEL-}" ]; then exit 97; fi
/bin/cat >/dev/null
printf '%s\n' "$CODEX_HOME" "$HOME" "$TMPDIR" > @STATE@
profile=$(/usr/bin/sed -n 's/^default_permissions = "\(.*\)"/\1/p' "$CODEX_HOME/config.toml")
answer=$(@CODEX@ sandbox -P "$profile" -C "$PWD" -- /bin/sh ./probe.sh @AUTH@ "$CODEX_HOME/auth.json" "$CODEX_HOME/config.toml" 2>"$PWD/sandbox-error") || exit 92
/bin/cp "$PWD/runtime-private-paths" @COMMAND@
printf '%s\n' '{"type":"thread.started","thread_id":"runtime-oracle-thread"}'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\n' "$answer"
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":4}}'
"#;
