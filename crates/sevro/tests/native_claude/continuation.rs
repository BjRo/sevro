use super::fixture::{Fixture, artifact_path, completed_run, failed_run, read_json};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use uuid::Uuid;

#[test]
fn resumes_original_session_and_grades_second_response() {
    let fixture = continuation_fixture();
    let run = completed_run(&fixture);
    let session = assert_session_reuse(&fixture);
    assert_eq!(run.trial["usage"]["inputTokens"].as_f64(), Some(4.0));
    assert_eq!(run.trial["usage"]["outputTokens"].as_f64(), Some(6.0));
    assert_eq!(run.trial["usage"]["costUsd"].as_f64(), Some(0.03));
    assert_eq!(run.trial["usage"]["complete"], true);
    assert_continuation(&run.trial, &session, "complete");
    assert_phase_evidence(&run.trial, &session, &session);
}

#[test]
fn rejects_foreign_follow_up_without_claiming_usage_or_complete_continuation() {
    let fixture = continuation_fixture();
    fixture.replace_native_source(
        "session_id:session",
        "session_id:resumed ? \"00000000-0000-0000-0000-000000000000\" : session",
    );
    let failure = failed_run(&fixture);
    let session = assert_session_reuse(&fixture);
    assert_eq!(
        failure.trial["usage"],
        json!({"inputTokens":null,"outputTokens":null,"costUsd":null,"complete":false})
    );
    assert_continuation(&failure.trial, &session, "partial");
    assert_phase_evidence(
        &failure.trial,
        &session,
        "00000000-0000-0000-0000-000000000000",
    );
    fixture.assert_failed_state(&failure);
}

#[test]
fn retains_stderr_when_initial_failure_prevents_resume() {
    let fixture = continuation_fixture();
    fixture.replace_native_source(
        "subtype:\"success\", is_error:false",
        "subtype:\"error_during_execution\", is_error:true",
    );
    fixture.append_native_source("\nawait new Promise(resolve => process.stderr.write(\"  synthetic Claude failure stderr\\n\\n\", resolve));\n");
    let failure = failed_run(&fixture);
    assert_eq!(
        fs::read_to_string(fixture.root.join("binary/launches.txt")).unwrap(),
        "initial\n"
    );
    assert!(!fixture.root.join("binary/resume-capture.json").exists());
    let probe = read_json(&fixture.root.join("binary/initial-capture.json"));
    let argv = probe["argv"].as_array().unwrap();
    assert_eq!(argv[argv.len() - 2], "--session-id");
    let session = argv.last().unwrap().as_str().unwrap();
    assert_eq!(Uuid::parse_str(session).unwrap().get_version_num(), 4);
    assert!(
        !failure.trial["observations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == "sevro.claude.continuation")
    );
    assert_eq!(failure.trial["usage"]["inputTokens"].as_f64(), Some(1.0));
    assert_eq!(failure.trial["usage"]["outputTokens"].as_f64(), Some(2.0));
    assert_eq!(failure.trial["usage"]["costUsd"].as_f64(), Some(0.01));
    assert_eq!(failure.trial["usage"]["complete"], true);
    let raw = artifact_path(&failure.trial["rawResult"]["path"]);
    assert_eq!(fs::read_to_string(&raw).unwrap(), "waiting");
    assert_eq!(
        failure.trial["rawResult"]["sha256"],
        "80cfa3e7f28dde4df64436b652230aff28d7779116d1369c21ef2bbf37261d71"
    );
    assert_eq!(
        fs::metadata(raw).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let expected_events = format!(
        "{{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"session_id\":\"{session}\",\"result\":\"waiting\",\"usage\":{{\"input_tokens\":1,\"output_tokens\":2}},\"total_cost_usd\":0.01}}\n"
    );
    let artifacts = failure.trial["artifactRefs"].as_array().unwrap();
    assert_eq!(artifacts.len(), 2);
    for (id, expected, hash) in [
        (
            "sevro.claude.events",
            expected_events.clone(),
            format!("{:x}", Sha256::digest(expected_events.as_bytes())),
        ),
        (
            "sevro.claude.stderr",
            "  synthetic Claude failure stderr\n\n".into(),
            "6444d62871a699a300d949c07419f77cc5d2f48f15cc15ffd25f8ebccae51ffd".into(),
        ),
    ] {
        let artifact = artifacts.iter().find(|item| item["id"] == id).unwrap();
        let path = artifact_path(&artifact["path"]);
        assert_eq!(fs::read_to_string(&path).unwrap(), expected);
        assert_eq!(artifact["sha256"], hash);
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    fixture.assert_failed_state(&failure);
}

fn continuation_fixture() -> Fixture {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("project/case.json"), serde_json::to_vec(&json!({
        "id":"native-claude-follow-up", "prompt":"Return waiting.",
        "followUpPrompt":"Resume the same task and return ready.",
        "fixture":{"files":{"README.md":"fixture\n"}},
        "checks":[{"id":"final-ready","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
        "requiredEvidence":["sevro.claude.events","sevro.claude.initial-events","sevro.claude.follow-up-events","sevro.claude.continuation"]
    })).unwrap()).unwrap();
    fixture.replace_native_source(
        "import { readFile, stat, writeFile }",
        "import { appendFile, readFile, stat, writeFile }",
    );
    fixture.replace_native_source("const argv = process.argv.slice(2);", r#"const argv = process.argv.slice(2);
const resumed = argv.includes("--resume");
const sessionOption = resumed ? "--resume" : "--session-id";
const session = argv[argv.indexOf(sessionOption) + 1];
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(session)) process.exit(9);
"#);
    fixture.replace_native_source(
        "\"-p\", \"Return ready.\"",
        "\"-p\", resumed ? \"Resume the same task and return ready.\" : \"Return waiting.\"",
    );
    fixture.replace_native_source(
        "\"--no-chrome\"];",
        "\"--no-chrome\", sessionOption, session];",
    );
    fixture.replace_native_source("await writeFile(", &format!(r#"const proof = JSON.stringify({{session, cwd:process.cwd(), environment:process.env, settingsPath, settings, credentialSha256:createHash("sha256").update(credentialBytes).digest("hex")}});
checks.sameSessionState = resumed ? await readFile(".git/session-proof", "utf8") === proof : true;
if (!resumed) await writeFile(".git/session-proof", proof);
await appendFile({}, resumed ? "resume\n" : "initial\n");
await writeFile("#, serde_json::to_string(&fixture.root.join("binary/launches.txt")).unwrap()));
    fixture.replace_native_source("if (!Object.values(checks).every(Boolean))", &format!(r#"await writeFile(join({}, resumed ? "resume-capture.json" : "initial-capture.json"), await readFile({}));
if (!Object.values(checks).every(Boolean))"#, serde_json::to_string(&fixture.root.join("binary")).unwrap(), serde_json::to_string(&fixture.root.join("binary/capture.json")).unwrap()));
    let binary = fixture.root.join("binary/claude-wrapper");
    let script = fs::read_to_string(&binary).unwrap();
    let (prefix, _) = script.rsplit_once("process.stdout.write(").unwrap();
    fs::write(binary, format!(r#"{prefix}const event = {{type:"result", subtype:"success", is_error:false,
session_id:session, result:resumed ? "ready" : "waiting",
usage:{{input_tokens:resumed ? 3 : 1, output_tokens:resumed ? 4 : 2}}, total_cost_usd:resumed ? 0.02 : 0.01}};
process.stdout.write(JSON.stringify(event) + "\n");
"#)).unwrap();
    fixture
}

fn assert_session_reuse(fixture: &Fixture) -> String {
    assert_eq!(
        fs::read_to_string(fixture.root.join("binary/launches.txt")).unwrap(),
        "initial\nresume\n"
    );
    let initial = read_json(&fixture.root.join("binary/initial-capture.json"));
    let resumed = read_json(&fixture.root.join("binary/resume-capture.json"));
    for probe in [&initial, &resumed] {
        for (name, value) in probe["checks"].as_object().unwrap() {
            assert_eq!(value, true, "native continuation fixture check: {name}");
        }
    }
    for key in [
        "cwd",
        "settingsPath",
        "settings",
        "environment",
        "credentialSha256",
        "privatePaths",
    ] {
        assert_eq!(initial[key], resumed[key], "session state changed: {key}");
    }
    let first = initial["argv"].as_array().unwrap();
    let second = resumed["argv"].as_array().unwrap();
    assert_eq!(first[first.len() - 2], "--session-id");
    assert_eq!(second[second.len() - 2], "--resume");
    let session = first.last().unwrap().as_str().unwrap();
    assert_eq!(Uuid::parse_str(session).unwrap().get_version_num(), 4);
    assert_eq!(second.last().unwrap(), session);
    session.into()
}

fn assert_continuation(trial: &Value, session: &str, completeness: &str) {
    let observation = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.claude.continuation")
        .unwrap();
    assert_eq!(
        *observation,
        json!({"id":"sevro.claude.continuation", "source":"sevro.host.claude", "completeness":completeness,
        "data":{"method":"same_session_resume", "sessionId":session, "preFollowUpWorktreeUnchanged":true}})
    );
}

fn assert_phase_evidence(trial: &Value, initial_session: &str, final_session: &str) {
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
    let initial = format!(
        "{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"{initial_session}\",\"result\":\"waiting\",\"usage\":{{\"input_tokens\":1,\"output_tokens\":2}},\"total_cost_usd\":0.01}}\n"
    );
    let resumed = format!(
        "{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"{final_session}\",\"result\":\"ready\",\"usage\":{{\"input_tokens\":3,\"output_tokens\":4}},\"total_cost_usd\":0.02}}\n"
    );
    let artifacts = trial["artifactRefs"].as_array().unwrap();
    assert_eq!(artifacts.len(), 3);
    for (id, expected) in [
        ("sevro.claude.events", format!("{initial}{resumed}")),
        ("sevro.claude.initial-events", initial),
        ("sevro.claude.follow-up-events", resumed),
    ] {
        let artifact = artifacts.iter().find(|item| item["id"] == id).unwrap();
        let path = artifact_path(&artifact["path"]);
        assert_eq!(fs::read_to_string(&path).unwrap(), expected);
        assert_eq!(
            artifact["sha256"],
            format!("{:x}", Sha256::digest(expected.as_bytes()))
        );
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
