#[path = "native_claude/fixture.rs"]
mod fixture;

use fixture::{Fixture, artifact_path, assert_no_response, failed_run, read_json};
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

#[test]
fn executes_passive_claude_with_private_credentials() {
    let fixture = Fixture::new();
    let output = fixture.command().output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"completed"}));
    assert_eq!(result["grading"], json!({"status":"completed"}));
    assert_eq!(result["task"], json!({"verdict":"passed"}));
    assert_eq!(
        result["cases"][0]["trials"][0]["checks"][0]["status"],
        "passed"
    );
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trial = &evidence["trials"][0];
    assert_eq!(
        trial["routes"][0],
        json!({"role":"candidate","host":"sevro.host.claude","model":"sonnet","effort":"low"})
    );
    assert_eq!(trial["usage"]["inputTokens"].as_f64(), Some(1.0));
    assert_eq!(trial["usage"]["outputTokens"].as_f64(), Some(2.0));
    assert_eq!(trial["usage"]["costUsd"].as_f64(), Some(0.01));
    assert_eq!(trial["usage"]["complete"], true);
    assert_eq!(
        fs::read_to_string(artifact_path(&trial["rawResult"]["path"])).unwrap(),
        "ready"
    );
    assert_eq!(
        trial["rawResult"]["sha256"],
        "b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6"
    );
    let artifacts = trial["artifactRefs"].as_array().unwrap();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0]["id"], "sevro.claude.events");
    assert_eq!(
        artifacts[0]["sha256"],
        "141bc2c7552bd20c2450c12e8095c2e2f4c3c37d98f3a9257eccdfa82e270e07"
    );
    let events = artifact_path(&artifacts[0]["path"]);
    assert_eq!(
        fs::read_to_string(&events).unwrap(),
        "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"ready\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2},\"total_cost_usd\":0.01}\n"
    );
    assert_eq!(
        fs::metadata(events).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let probe = read_json(&fixture.root.join("binary/capture.json"));
    for (name, value) in probe["checks"].as_object().unwrap() {
        assert_eq!(value, true, "native fixture check: {name}");
    }
    let environment = probe["environment"].as_object().unwrap();
    assert_eq!(
        environment.keys().map(String::as_str).collect::<Vec<_>>(),
        vec![
            "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
            "CLAUDE_CONFIG_DIR",
            "HOME",
            "LANG",
            "NO_COLOR",
            "PATH",
            "TMPDIR"
        ]
    );
    for path in probe["privatePaths"].as_object().unwrap().values() {
        assert!(
            !Path::new(path.as_str().unwrap()).exists(),
            "private state survived: {path}"
        );
    }
    assert!(!Path::new(probe["cwd"].as_str().unwrap()).exists());
    assert_eq!(
        fs::read_to_string(fixture.root.join("project/credential.json")).unwrap(),
        "{\"test\":\"SYNTHETIC_CLAUDE_LOGIN\"}"
    );
    for text in [
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        evidence.to_string(),
    ] {
        for secret in [
            "SYNTHETIC_CLAUDE_LOGIN",
            "SYNTHETIC_CALLER_API_SENTINEL",
            "SYNTHETIC_CALLER_OAUTH_SENTINEL",
        ] {
            assert!(!text.contains(secret));
        }
    }
}

#[test]
fn rejects_whitespace_credential_without_authentication_fallback() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("project/credential.json"), " \n\t").unwrap();
    let failure = failed_run(&fixture);
    assert_no_response(&failure.trial);
    assert!(!fixture.root.join("binary/capture.json").exists());
    assert_eq!(
        fs::read_to_string(fixture.root.join("project/credential.json")).unwrap(),
        " \n\t"
    );
    fixture.assert_private_state_removed();
}

#[test]
fn rejects_nonexecutable_claude_binary_before_launch() {
    let fixture = Fixture::new();
    fs::set_permissions(
        fixture.root.join("binary/claude-wrapper"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let failure = failed_run(&fixture);
    assert_no_response(&failure.trial);
    assert!(!fixture.root.join("binary/capture.json").exists());
    assert_eq!(
        fs::read_to_string(fixture.root.join("project/credential.json")).unwrap(),
        "{\"test\":\"SYNTHETIC_CLAUDE_LOGIN\"}"
    );
    fixture.assert_private_state_removed();
}

#[test]
fn retains_ready_response_but_invalidates_usage_after_malformed_tail() {
    let fixture = Fixture::new();
    fixture.append_native_source("\nprocess.stdout.write(\"null\\n\");\n");
    let failure = failed_run(&fixture);
    assert_retained_response(
        &failure.trial,
        concat!(
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"ready\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2},\"total_cost_usd\":0.01}\n",
            "null\n"
        ),
        "31f105bb5e2442472890632a0883ec1918f799cca379cdf4ffb6d4148f27938d",
    );
    assert_eq!(
        failure.trial["usage"],
        json!({"inputTokens":null,"outputTokens":null,"costUsd":null,"complete":false})
    );
    fixture.assert_failed_state(&failure);
}

#[test]
fn retains_measured_evidence_when_claude_exits_nonzero() {
    let fixture = Fixture::new();
    fixture.append_native_source("\nprocess.exitCode = 7;\n");
    let failure = failed_run(&fixture);
    assert_retained_response(
        &failure.trial,
        "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"ready\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2},\"total_cost_usd\":0.01}\n",
        "141bc2c7552bd20c2450c12e8095c2e2f4c3c37d98f3a9257eccdfa82e270e07",
    );
    assert_eq!(failure.trial["usage"]["inputTokens"].as_f64(), Some(1.0));
    assert_eq!(failure.trial["usage"]["outputTokens"].as_f64(), Some(2.0));
    assert_eq!(failure.trial["usage"]["costUsd"].as_f64(), Some(0.01));
    assert_eq!(failure.trial["usage"]["complete"], true);
    fixture.assert_failed_state(&failure);
}

#[test]
fn rejects_stderr_overflow_and_stops_owned_descendant() {
    let fixture = Fixture::new();
    let binary = fixture.root.join("binary/claude-wrapper");
    let marker = fixture.root.join("binary/child-ready.json");
    let child_script = format!(
        "require(\"node:fs\").writeFileSync({},JSON.stringify({{pid:process.pid}}));setInterval(()=>{{}},1000);",
        serde_json::to_string(&marker).unwrap()
    );
    let script = fs::read_to_string(&binary).unwrap();
    let (prefix, _) = script.rsplit_once("process.stdout.write(").unwrap();
    fs::write(&binary, format!(r#"{prefix}
const child = Bun.spawn([process.execPath, "-e", {child_script}], {{stdin:"ignore", stdout:"inherit", stderr:"inherit"}});
const childReady = {marker};
const readinessDeadline = Date.now() + 5000;
while (!(await Bun.file(childReady).exists())) {{
  if (Date.now() > readinessDeadline) throw new Error("child did not start");
  await Bun.sleep(5);
}}
await new Promise(resolve => process.stderr.write(Buffer.alloc(65537, 120), resolve));
setInterval(() => {{}}, 1000);
"#, child_script = serde_json::to_string(&child_script).unwrap(), marker = serde_json::to_string(&marker).unwrap())).unwrap();
    let failure = failed_run(&fixture);
    assert_no_response(&failure.trial);
    fixture.assert_failed_state(&failure);
    let child = read_json(&marker);
    let pid = child["pid"].as_u64().unwrap();
    assert!(pid > 0);
    let state = Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8(state.stdout).unwrap();
    assert!(
        state.trim().is_empty() || state.trim().starts_with('Z'),
        "owned descendant survived stderr overflow: {state}"
    );
}

fn assert_retained_response(trial: &Value, expected_events: &str, event_hash: &str) {
    let raw = artifact_path(&trial["rawResult"]["path"]);
    assert_eq!(fs::read_to_string(&raw).unwrap(), "ready");
    assert_eq!(
        trial["rawResult"]["sha256"],
        "b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6"
    );
    assert_eq!(
        fs::metadata(raw).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let artifacts = trial["artifactRefs"].as_array().unwrap();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0]["id"], "sevro.claude.events");
    assert_eq!(artifacts[0]["sha256"], event_hash);
    let events = artifact_path(&artifacts[0]["path"]);
    assert_eq!(fs::read_to_string(&events).unwrap(), expected_events);
    assert_eq!(
        fs::metadata(events).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
