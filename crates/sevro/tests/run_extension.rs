use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::Pid;
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

const EXTENSION: &str = r#"import { appendFileSync, readFileSync } from 'node:fs';
const raw = readFileSync(0);
const request = JSON.parse(raw.toString('utf8'));
appendFileSync(process.argv[2], JSON.stringify({pid:process.pid,request})+'\n');
const results = {
 describe: {
  extension:{id:'example.extension',version:'1.0.0'},
  protocols:['sevro.extension.v1'],
  requiredCapabilities:['sevro.host.exec','sevro.case.host-route'],
  optionalCapabilities:['example.unknown'],graders:[],taskVerdictPolicies:[]
 },
 resolve:{cases:[{
  id:'extension-case',prompt:'Return ready',
  fixture:{kind:'inline',files:{'README.txt':'fixture only\n'}},
  checks:[],requiredEvidence:[],extensionData:{'example.extension':{marker:'resolved'}}
 }]},
 prepare:{artifacts:[],requestedInstrumentation:[],extensionData:{'example.extension':{marker:'prepared'}}}
};
if (!Object.hasOwn(results,request.method)) process.exit(97);
process.stdout.write(JSON.stringify({protocol:request.protocol,id:request.id,method:request.method,result:results[request.method]}));
"#;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "sevro-rust-extension-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir(root.join("tmp")).unwrap();
        fs::write(root.join("extension.mjs"), EXTENSION).unwrap();
        for (name, body) in [
            ("extension", "#!/bin/sh\nexec node \"$@\"\n"),
            (
                "native",
                "#!/bin/sh\nprintf invoked >> \"$SEVRO_NATIVE_MARKER\"\nexit 98\n",
            ),
        ] {
            fs::write(root.join(name), body).unwrap();
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        write_json(
            &root.join("command.json"),
            &json!([
                root.join("extension"),
                root.join("extension.mjs"),
                root.join("requests.jsonl")
            ]),
        );
        fs::write(root.join("auth.json"), "PRIVATE_DRY_CREDENTIAL").unwrap();
        Self { root }
    }

    fn invoke(&self, extra: &[&str]) -> Output {
        self.command(extra).output().unwrap()
    }

    fn command(&self, extra: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_sevro"));
        command
            .current_dir(&self.root)
            .env("TMPDIR", self.root.join("tmp"))
            .env("SEVRO_NATIVE_MARKER", self.root.join("native-invocations"))
            .args([
                "run",
                "--json",
                "--dry",
                "--host",
                "codex",
                "--model",
                "fixture-model",
                "--effort",
                "low",
                "--codex-bin",
                "./native",
                "--codex-auth-file",
                "auth.json",
                "--extension-command-file",
                "command.json",
                "--extension-source-file",
                "extension.mjs",
                "--case-id",
                "extension-case",
                "--runner-build-digest",
            ])
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64))
            .args(extra);
        command
    }

    fn requests(&self) -> Vec<Value> {
        fs::read_to_string(self.root.join("requests.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn response_program(&self, program: &str) {
        let (prefix, _) = EXTENSION.split_once("process.stdout.write").unwrap();
        fs::write(
            self.root.join("extension.mjs"),
            format!("{prefix}\n{program}\n"),
        )
        .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn write_json(path: &Path, value: &Value) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn explicit_extension_selection_replaces_saved_case_and_source_lists() {
    for settings in [
        json!({"case-file":"not-selected-case.json"}),
        json!({
            "extension-command-file":"not-selected-command.json",
            "extension-source-file":["not-selected-source.js"],
            "case-id":"not-selected"
        }),
    ] {
        let fixture = Fixture::new();
        write_json(
            &fixture.root.join("saved.json"),
            &json!({"format":"sevro.run.v1","settings":settings}),
        );
        let output = fixture.invoke(&["--run-manifest-file", "saved.json"]);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
        let resolved = &evidence["configuration"]["resolved"];
        assert_eq!(resolved["caseFile"], Value::Null);
        assert_eq!(resolved["caseId"], "extension-case");
        assert_eq!(
            resolved["extensionCommandFile"],
            json!(fixture.root.join("command.json"))
        );
        assert_eq!(resolved["extensionSourceFileCount"], 1);
        assert_eq!(fixture.requests().len(), 3);
    }
}

#[test]
fn refuses_invalid_command_files_before_launching_discovery() {
    for (content, diagnostic) in [
        (
            Some("{ private-command-marker"),
            "extension command file is unreadable or invalid",
        ),
        (None, "extension command file is unreadable or invalid"),
        (
            Some("[]"),
            "extension command must be an absolute argv array",
        ),
        (
            Some("[\"/usr/bin/false\",\"\"]"),
            "extension command must be an absolute argv array",
        ),
        (
            Some("[\"false\"]"),
            "extension command must be an absolute argv array",
        ),
        (
            Some("[7]"),
            "extension command must be an absolute argv array",
        ),
        (
            Some("{}"),
            "extension command must be an absolute argv array",
        ),
    ] {
        let fixture = Fixture::new();
        if let Some(content) = content {
            fs::write(fixture.root.join("invalid-command.json"), content).unwrap();
        }
        let output = fixture.invoke(&["--extension-command-file", "invalid-command.json"]);
        assert_eq!(output.status.code(), Some(64));
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(diagnostic), "{stderr}");
        assert!(!stderr.contains("private-command-marker"));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        assert!(!fixture.root.join("requests.jsonl").exists());
    }
}

#[test]
fn refuses_invalid_configurations_without_exposing_file_contents() {
    for (private, redacted, diagnostic) in [
        (
            Some("[]"),
            Some("{private-configuration-marker"),
            "redacted extension configuration file is unreadable or invalid",
        ),
        (
            None,
            Some("{}"),
            "extension configuration file is unreadable or invalid",
        ),
        (
            Some("{private-configuration-marker"),
            Some("{}"),
            "extension configuration file is unreadable or invalid",
        ),
        (
            Some("[]"),
            Some("{}"),
            "extension configuration must be JSON objects",
        ),
        (
            Some("{}"),
            None,
            "redacted extension configuration file is unreadable or invalid",
        ),
        (
            Some("{}"),
            Some("{private-configuration-marker"),
            "redacted extension configuration file is unreadable or invalid",
        ),
        (
            Some("{}"),
            Some("null"),
            "extension configuration must be JSON objects",
        ),
    ] {
        let fixture = Fixture::new();
        for (name, value) in [("private.json", private), ("redacted.json", redacted)] {
            if let Some(value) = value {
                fs::write(fixture.root.join(name), value).unwrap();
            }
        }
        let output = fixture.invoke(&[
            "--extension-configuration-file",
            "private.json",
            "--extension-redacted-configuration-file",
            "redacted.json",
        ]);
        assert_eq!(output.status.code(), Some(64));
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(diagnostic), "{stderr}");
        assert!(!stderr.contains("private-configuration-marker"));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        assert!(!fixture.root.join("requests.jsonl").exists());
    }
}

#[test]
fn negotiates_supported_optional_capabilities_once_in_declared_order() {
    let fixture = Fixture::new();
    fixture.response_program("results.describe.optionalCapabilities=['sevro.host.exec','sevro.host.continuation','example.unknown']; process.stdout.write(JSON.stringify({protocol:request.protocol,id:request.id,method:request.method,result:results[request.method]}));");
    let output = fixture.invoke(&[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    assert_eq!(
        evidence["extension"]["capabilities"],
        json!([
            "sevro.host.exec",
            "sevro.case.host-route",
            "sevro.host.continuation"
        ])
    );
    assert_eq!(fixture.requests().len(), 3);
}

#[test]
fn refuses_uncorrelated_or_invalid_preparation_before_retaining_evidence() {
    for (mutation, code, diagnostic, calls) in [
        (
            "if(request.method==='describe'){response.protocol='sevro.extension.v1';response.method='prepare';delete response.result;response.error={code:'example.failure',message:'private-secret-marker'};}",
            70,
            "extension response does not match request",
            1,
        ),
        (
            "results.resolve.cases=[];",
            64,
            "extension did not resolve the selected case",
            2,
        ),
        (
            "results.prepare.extensionData=[];",
            70,
            "invalid extension response",
            3,
        ),
        (
            "delete results.resolve.cases[0].extensionData;",
            70,
            "invalid extension response",
            2,
        ),
    ] {
        let fixture = Fixture::new();
        fixture.response_program(&format!("const response={{protocol:request.protocol,id:request.id,method:request.method,result:results[request.method]}};{mutation} process.stdout.write(JSON.stringify(response));"));
        let output = fixture.invoke(&[]);
        assert_eq!(
            output.status.code(),
            Some(code),
            "{mutation}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["diagnostic"]["message"], diagnostic);
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("private-secret-marker"));
        assert_eq!(fixture.requests().len(), calls);
    }
}

#[test]
fn refuses_instrumentation_the_native_host_does_not_support() {
    let fixture = Fixture::new();
    fixture.response_program("results.prepare.requestedInstrumentation=[{id:'example.missing',configuration:{}}]; process.stdout.write(JSON.stringify({protocol:request.protocol,id:request.id,method:request.method,result:results[request.method]}));");
    let output = fixture.invoke(&[]);
    assert_eq!(output.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result["diagnostic"]["message"],
        "extension preparation requested unsupported instrumentation"
    );
    assert_eq!(result["evidencePath"], Value::Null);
    assert_eq!(result["cases"], json!([]));
    assert_eq!(fixture.requests().len(), 3);
    assert!(!fixture.root.join("native-invocations").exists());
}

#[test]
fn enforces_declared_source_closure_and_request_schema() {
    for (arguments, diagnostic, calls) in [
        (
            vec![
                "--extension-source-file".to_string(),
                "extension.mjs".to_string(),
            ],
            "extension source files must be unique absolute paths",
            0,
        ),
        (
            vec![
                "--extension-source-file".to_string(),
                "missing.mjs".to_string(),
            ],
            "declared extension source is unreadable",
            0,
        ),
        (
            vec!["--case-id".to_string(), "x".repeat(129)],
            "invalid extension request",
            1,
        ),
    ] {
        let fixture = Fixture::new();
        let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
        let output = fixture.invoke(&arguments);
        assert_eq!(output.status.code(), Some(70));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["diagnostic"]["message"], diagnostic);
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        if calls == 0 {
            assert!(!fixture.root.join("requests.jsonl").exists());
        } else {
            assert_eq!(fixture.requests().len(), calls);
        }
    }
    let fixture = Fixture::new();
    let ordinary = fixture.invoke(&[]);
    assert_eq!(ordinary.status.code(), Some(0));
    let ordinary: Value = serde_json::from_slice(&ordinary.stdout).unwrap();
    let before = read_json(Path::new(ordinary["evidencePath"].as_str().unwrap()));
    let explicit_executable = fixture.invoke(&["--extension-source-file", "extension"]);
    assert_eq!(explicit_executable.status.code(), Some(0));
    let explicit: Value = serde_json::from_slice(&explicit_executable.stdout).unwrap();
    let after = read_json(Path::new(explicit["evidencePath"].as_str().unwrap()));
    assert_eq!(
        before["extension"]["sourceDigest"],
        after["extension"]["sourceDigest"]
    );
    assert_eq!(
        after["configuration"]["resolved"]["extensionSourceFileCount"],
        2
    );
}

#[test]
fn accepts_a_leading_utf8_bom_but_refuses_one_inside_the_json_document() {
    for (prefix, code) in [("\\ufeff", 0), (" \\ufeff", 70)] {
        let fixture = Fixture::new();
        fixture.response_program(&format!("process.stdout.write('{prefix}'+JSON.stringify({{protocol:request.protocol,id:request.id,method:request.method,result:results[request.method]}}));"));
        let output = fixture.invoke(&[]);
        assert_eq!(
            output.status.code(),
            Some(code),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        if code == 0 {
            assert_eq!(result["cases"][0]["caseId"], "extension-case");
            assert_eq!(fixture.requests().len(), 3);
        } else {
            assert_eq!(
                result["diagnostic"]["message"],
                "extension did not return one UTF-8 JSON response"
            );
            assert_eq!(result["evidencePath"], Value::Null);
            assert_eq!(fixture.requests().len(), 1);
        }
    }
}

#[test]
fn rejects_output_overflow_while_the_extension_leaves_its_request_unread() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("extension.mjs"), r#"import {existsSync,readFileSync,appendFileSync} from 'node:fs';
if(existsSync(process.argv[2])) {
 process.stdout.write(Buffer.alloc(8*1024*1024+1,32));
 setInterval(()=>{},1000);
} else {
 const request=JSON.parse(readFileSync(0,'utf8'));
 appendFileSync(process.argv[2],JSON.stringify({pid:process.pid,request})+'\n');
 const result={extension:{id:'example.extension',version:'1.0.0'},protocols:['sevro.extension.v1'],requiredCapabilities:[],optionalCapabilities:[],graders:[],taskVerdictPolicies:[]};
 process.stdout.write(JSON.stringify({protocol:request.protocol,id:request.id,method:request.method,result}));
}
"#).unwrap();
    write_json(
        &fixture.root.join("private.json"),
        &json!({"large":"x".repeat(1024*1024)}),
    );
    write_json(&fixture.root.join("redacted.json"), &json!({}));
    let output = fixture.invoke(&[
        "--extension-configuration-file",
        "private.json",
        "--extension-redacted-configuration-file",
        "redacted.json",
    ]);
    assert_eq!(output.status.code(), Some(70));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result["diagnostic"]["message"],
        "extension message exceeds 8 MiB"
    );
    assert_eq!(result["evidencePath"], Value::Null);
    assert_eq!(result["cases"], json!([]));
    assert_eq!(fixture.requests().len(), 1);
    assert!(!fixture.root.join("native-invocations").exists());
}

#[test]
fn reports_an_extension_signal_exit_using_the_baseline_exit_code() {
    let fixture = Fixture::new();
    fixture.response_program("process.kill(process.pid,'SIGTERM');");
    let output = fixture.invoke(&[]);
    assert_eq!(output.status.code(), Some(70));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result["diagnostic"]["message"],
        "extension exited with code 143"
    );
    assert_eq!(result["evidencePath"], Value::Null);
    assert_eq!(result["cases"], json!([]));
    assert_eq!(fixture.requests().len(), 1);
}

#[test]
fn refuses_a_readable_command_that_cannot_be_executed() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("not-executable"),
        "private-executable-marker",
    )
    .unwrap();
    fs::set_permissions(
        fixture.root.join("not-executable"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    write_json(
        &fixture.root.join("command.json"),
        &json!([fixture.root.join("not-executable")]),
    );
    let output = fixture.invoke(&[]);
    assert_eq!(output.status.code(), Some(70));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result["diagnostic"]["message"],
        "could not start extension process"
    );
    assert_eq!(result["evidencePath"], Value::Null);
    assert_eq!(result["cases"], json!([]));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("private-executable-marker"));
    assert!(!fixture.root.join("requests.jsonl").exists());
}

#[test]
fn resolves_and_prepares_a_real_extension_for_a_native_dry_run() {
    let fixture = Fixture::new();
    let output = fixture.invoke(&[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"not_run"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    assert_eq!(result["cases"][0]["caseId"], "extension-case");
    assert_eq!(result["cases"][0]["trials"][0]["checks"], json!([]));
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    assert_eq!(evidence["result"], result);
    assert_eq!(evidence["extension"]["id"], "example.extension");
    assert_eq!(evidence["extension"]["version"], "1.0.0");
    assert_eq!(evidence["extension"]["protocol"], "sevro.extension.v1");
    assert_eq!(
        evidence["extension"]["capabilities"],
        json!(["sevro.host.exec", "sevro.case.host-route"])
    );
    assert_eq!(
        evidence["extension"]["replacements"],
        json!({"graders":[],"taskVerdictPolicy":null})
    );
    let dimensions = &evidence["evaluationIdentity"]["dimensions"];
    assert_eq!(
        dimensions["extensionDigest"],
        evidence["extension"]["sourceDigest"]
    );
    assert_eq!(dimensions["extensionProtocol"], "sevro.extension.v1");
    assert_eq!(
        dimensions["caseDigest"],
        "4cf28d7fdc547a43737903300dc3a51e57713794dde293339d0960c0250f968c"
    );
    assert_eq!(
        dimensions["fixtureDigest"],
        "31820210105118df696df6d1209929737e7ff4fcd1e06ac5ef23a16e8b384558"
    );
    for field in ["sourceDigest", "configurationDigest"] {
        let digest = evidence["extension"][field].as_str().unwrap();
        assert_eq!(digest.len(), 64);
        assert!(
            digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
    }
    assert_eq!(
        evidence["configuration"]["redacted"]["extensionConfiguration"],
        json!({})
    );
    assert_eq!(
        evidence["configuration"]["redacted"]["extensionConfigurationDigest"],
        evidence["extension"]["configurationDigest"]
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["caseFile"],
        Value::Null
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["extensionCommandFile"],
        json!(fixture.root.join("command.json"))
    );
    assert_eq!(
        evidence["configuration"]["resolved"]["extensionSourceFileCount"],
        1
    );
    assert!(!fixture.root.join("native-invocations").exists());
    let requests = fixture.requests();
    assert_eq!(requests.len(), 3);
    let host_capabilities = json!([
        "sevro.host.continuation",
        "sevro.host.runtime",
        "sevro.host.native-transcripts",
        "sevro.host.hooks",
        "sevro.host.skill-activations",
        "sevro.codex.plugin-marketplace",
        "sevro.codex.explicit-invocation",
        "sevro.codex.repository-invocation",
        "sevro.codex.native-calls",
        "sevro.host.native-controls"
    ]);
    for (index, method) in ["describe", "resolve", "prepare"].iter().enumerate() {
        assert_eq!(requests[index]["request"]["method"], *method);
        assert_eq!(
            requests[index]["request"]["protocol"],
            if index == 0 {
                "sevro.discovery.v1"
            } else {
                "sevro.extension.v1"
            }
        );
        for previous in &requests[..index] {
            assert_ne!(requests[index]["pid"], previous["pid"]);
            assert_ne!(requests[index]["request"]["id"], previous["request"]["id"]);
        }
    }
    assert_eq!(
        requests[0]["request"]["params"],
        json!({
            "protocols":["sevro.extension.v1"],
            "engineCapabilities":["sevro.host.exec","sevro.fixture.setup","sevro.case.host-route"],
            "hostCapabilities":host_capabilities
        })
    );
    assert_eq!(
        requests[1]["request"]["params"]["selectors"],
        json!({"caseIds":["extension-case"]})
    );
    assert_eq!(
        requests[1]["request"]["params"]["projectRoot"],
        format!("file://{}", fixture.root.display())
    );
    assert_eq!(
        requests[1]["request"]["params"]["host"],
        json!({
            "id":"sevro.host.codex","model":"fixture-model","effort":"low","capabilities":host_capabilities
        })
    );
    assert_eq!(requests[2]["request"]["params"]["condition"], "passive");
    assert_eq!(
        requests[2]["request"]["params"]["case"]["extensionData"],
        json!({"example.extension":{"marker":"resolved"}})
    );
}

#[test]
fn refuses_duplicate_resolved_case_ids_before_preparation() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("extension.mjs"),
        EXTENSION.replace(
            "if (!Object.hasOwn",
            "results.resolve.cases.push(results.resolve.cases[0]);\nif (!Object.hasOwn",
        ),
    )
    .unwrap();
    let output = fixture.invoke(&[]);
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result["diagnostic"],
        json!({"code":"sevro.runner.error","message":"extension resolved duplicate case IDs"})
    );
    assert_eq!(result["evidencePath"], Value::Null);
    assert_eq!(result["cases"], json!([]));
    assert_eq!(fixture.requests().len(), 2);
}

#[test]
fn rejects_invalid_protocol_responses_without_exposing_private_diagnostics() {
    for (mutation, expected, calls) in [
        (
            "process.stdout.write('not JSON'); process.exit(0);",
            "extension did not return one UTF-8 JSON response",
            1,
        ),
        (
            "process.stdout.write(Buffer.from([255])); process.exit(0);",
            "extension did not return one UTF-8 JSON response",
            1,
        ),
        (
            "process.stdout.write('{}{}'); process.exit(0);",
            "extension did not return one UTF-8 JSON response",
            1,
        ),
        (
            "process.stdout.write(raw); process.exit(0);",
            "invalid extension response",
            1,
        ),
        ("response.result=[];", "invalid extension response", 1),
        (
            "response.extra='private-secret-marker';",
            "invalid extension response",
            1,
        ),
        (
            "response.protocol='sevro.extension.v1';",
            "invalid extension response",
            1,
        ),
        (
            "response.id='foreign-request';",
            "extension response does not match request",
            1,
        ),
        (
            "response.result.protocols=['sevro.extension.v2'];",
            "extension has no compatible protocol",
            1,
        ),
        (
            "response.result.requiredCapabilities=['example.missing'];",
            "unsupported required capability: example.missing",
            1,
        ),
        (
            "delete response.result; response.error={code:'example.refusal',message:'private-secret-marker'};",
            "extension reported example.refusal",
            1,
        ),
        (
            "if(request.method==='resolve'){delete response.result; response.method='prepare'; response.error={code:'example.refusal',message:'private-secret-marker'};}",
            "extension response does not match request",
            2,
        ),
        ("process.exitCode=7;", "extension exited with code 7", 1),
    ] {
        let fixture = Fixture::new();
        fixture.response_program(&format!(
            "const response={{protocol:request.protocol,id:request.id,method:request.method,result:results[request.method]}};\n{mutation}\nprocess.stderr.write('private-diagnostic-marker');\nprocess.stdout.write(JSON.stringify(response));"
        ));
        let output = fixture.invoke(&[]);
        assert_eq!(
            output.status.code(),
            Some(70),
            "{mutation}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            result["diagnostic"],
            json!({"code":"sevro.runner.error","message":expected}),
            "{mutation}"
        );
        assert_eq!(result["runId"], Value::Null);
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        for stream in [&output.stdout, &output.stderr] {
            let text = String::from_utf8_lossy(stream);
            assert!(!text.contains("private-secret-marker"));
            assert!(!text.contains("private-diagnostic-marker"));
        }
        assert_eq!(fixture.requests().len(), calls, "{mutation}");
    }
}

#[test]
fn refuses_declared_source_changes_during_discovery_or_resolution() {
    for (method, expected, calls) in [
        ("describe", "extension source changed during discovery", 1),
        ("resolve", "extension source changed during run", 2),
    ] {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("declared.txt"), "stable source").unwrap();
        write_json(
            &fixture.root.join("command.json"),
            &json!([
                fixture.root.join("extension"),
                fixture.root.join("extension.mjs"),
                fixture.root.join("requests.jsonl"),
                fixture.root.join("declared.txt")
            ]),
        );
        fs::write(fixture.root.join("extension.mjs"), format!(
            "{}\nif(request.method==='{method}') writeFileSync(process.argv[3],'changed source');\n",
            EXTENSION.replace("appendFileSync, readFileSync", "appendFileSync, readFileSync, writeFileSync")
        )).unwrap();
        let output = fixture.invoke(&["--extension-source-file", "declared.txt"]);
        assert_eq!(
            output.status.code(),
            Some(70),
            "{method}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            result["diagnostic"],
            json!({"code":"sevro.runner.error","message":expected})
        );
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(fixture.requests().len(), calls);
        assert_eq!(
            fs::read_to_string(fixture.root.join("declared.txt")).unwrap(),
            "changed source"
        );
    }
}

#[test]
fn refuses_a_declared_source_that_becomes_unreadable_after_discovery() {
    let fixture = Fixture::new();
    fixture.response_program(r#"if(request.method==='describe') {
  const {unlinkSync}=await import('node:fs');
  unlinkSync(new URL(import.meta.url));
}
process.stdout.write(JSON.stringify({protocol:request.protocol,id:request.id,method:request.method,result:results[request.method]}));"#);
    let output = fixture.invoke(&[]);
    assert_eq!(output.status.code(), Some(70));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({
            "format":"sevro.cli-result.v1","runId":null,
            "execution":{"status":"not_run"},"grading":{"status":"not_requested"},
            "task":{"verdict":"not_assessed"},"exitCode":70,"evidencePath":null,"cases":[],
            "diagnostic":{"code":"sevro.runner.error","message":"declared extension source is unreadable"}
        })
    );
    let requests = fixture.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["request"]["method"], "describe");
    assert!(!fixture.root.join("extension.mjs").exists());
    assert!(!fixture.root.join("native-invocations").exists());
    assert_eq!(
        fs::read_to_string(fixture.root.join("auth.json")).unwrap(),
        "PRIVATE_DRY_CREDENTIAL"
    );
}

#[test]
fn bounds_stdout_messages_while_accepting_boundary_whitespace_and_draining_stderr() {
    for (length, expected_code) in [(8 * 1024 * 1024, 0), (8 * 1024 * 1024 + 1, 70)] {
        let fixture = Fixture::new();
        fixture.response_program(&format!(
            "const response=JSON.stringify({{protocol:request.protocol,id:request.id,method:request.method,result:results[request.method]}});\nprocess.stderr.write('private-diagnostic-marker\\n'.repeat(10000));\nprocess.stdout.write(response+' '.repeat({length}-Buffer.byteLength(response)));"
        ));
        let output = fixture.invoke(&[]);
        assert_eq!(
            output.status.code(),
            Some(expected_code),
            "{length} bytes: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        if expected_code == 70 {
            assert_eq!(
                result["diagnostic"]["message"],
                "extension message exceeds 8 MiB"
            );
            assert_eq!(result["evidencePath"], Value::Null);
            assert_eq!(fixture.requests().len(), 1);
        } else {
            assert_eq!(result["task"]["verdict"], "not_assessed");
            assert_eq!(fixture.requests().len(), 3);
        }
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private-diagnostic-marker"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("private-diagnostic-marker"));
    }
}

#[test]
fn passes_private_configuration_to_extensions_and_retains_only_redacted_identity() {
    let fixture = Fixture::new();
    let private = json!({"label":"private-secret-marker","nested":{"enabled":true}});
    let redacted = json!({"label":"retained-label","secretPresent":true});
    write_json(&fixture.root.join("private.json"), &private);
    write_json(&fixture.root.join("redacted.json"), &redacted);
    let arguments = [
        "--extension-configuration-file",
        "private.json",
        "--extension-redacted-configuration-file",
        "redacted.json",
    ];
    let output = fixture.invoke(&arguments);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let evidence_path = Path::new(result["evidencePath"].as_str().unwrap());
    let evidence = read_json(evidence_path);
    assert_eq!(
        evidence["configuration"]["redacted"]["extensionConfiguration"],
        redacted
    );
    assert_eq!(
        evidence["configuration"]["redacted"]["extensionConfigurationDigest"],
        evidence["extension"]["configurationDigest"]
    );
    for request in &fixture.requests()[1..] {
        assert_eq!(request["request"]["params"]["configuration"], private);
    }
    for bytes in [
        &output.stdout,
        &output.stderr,
        &fs::read(evidence_path).unwrap(),
    ] {
        assert!(!String::from_utf8_lossy(bytes).contains("private-secret-marker"));
    }
    write_json(
        &fixture.root.join("redacted.json"),
        &json!({"label":"different-label","secretPresent":true}),
    );
    let second = fixture.invoke(&arguments);
    assert_eq!(second.status.code(), Some(0));
    let second_result: Value = serde_json::from_slice(&second.stdout).unwrap();
    let second_evidence = read_json(Path::new(second_result["evidencePath"].as_str().unwrap()));
    assert_ne!(
        second_evidence["extension"]["configurationDigest"],
        evidence["extension"]["configurationDigest"]
    );
    assert_eq!(fixture.invoke(&arguments[..2]).status.code(), Some(64));
}

#[test]
fn refuses_an_oversized_request_before_launching_resolution() {
    let fixture = Fixture::new();
    write_json(
        &fixture.root.join("private.json"),
        &json!({"value":"x".repeat(8 * 1024 * 1024)}),
    );
    write_json(
        &fixture.root.join("redacted.json"),
        &json!({"valuePresent":true}),
    );
    let output = fixture.invoke(&[
        "--extension-configuration-file",
        "private.json",
        "--extension-redacted-configuration-file",
        "redacted.json",
    ]);
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result["diagnostic"]["message"],
        "extension request exceeds 8 MiB"
    );
    assert_eq!(result["evidencePath"], Value::Null);
    assert_eq!(fixture.requests().len(), 1);
}

#[test]
fn enforces_the_default_deadline_until_the_extension_exits() {
    let fixture = Fixture::new();
    fixture.response_program("process.stdout.end(JSON.stringify({protocol:request.protocol,id:request.id,method:request.method,result:results[request.method]}));\nprocess.stderr.end();\nif(request.method==='describe') setTimeout(()=>{},31000);");
    let output = fixture.invoke(&[]);
    assert_eq!(
        output.status.code(),
        Some(70),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["diagnostic"]["message"], "extension timed out");
    assert_eq!(result["evidencePath"], Value::Null);
    assert_eq!(fixture.requests().len(), 1);
}

#[test]
fn cancels_extension_discovery_and_its_descendants_on_cli_signals() {
    for signal in [Signal::SIGINT, Signal::SIGTERM] {
        let fixture = Fixture::new();
        fixture.response_program(r#"const {spawn}=await import('node:child_process');
const {writeFileSync}=await import('node:fs');
const child=spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'alive'),800);setTimeout(()=>{},10000);",process.argv[2]+'.alive'],{stdio:'ignore'});
writeFileSync(process.argv[2]+'.ready',String(child.pid));
setTimeout(()=>{},10000);"#);
        let mut child = fixture
            .command(&[])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !fixture.root.join("requests.jsonl.ready").exists() {
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("extension fixture did not reach discovery");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let extension_pid = Pid::from_raw(fixture.requests()[0]["pid"].as_i64().unwrap() as i32);
        kill(Pid::from_raw(child.id() as i32), signal).unwrap();
        let output = child.wait_with_output().unwrap();
        std::thread::sleep(Duration::from_millis(1100));
        let descendant_survived = fixture.root.join("requests.jsonl.alive").exists();
        // Clean up the known fixture group even on the intentionally failing red run.
        let _ = killpg(extension_pid, Signal::SIGKILL);
        assert_eq!(
            output.status.code(),
            Some(70),
            "{signal:?}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            result["diagnostic"],
            json!({"code":"sevro.runner.error","message":"extension request cancelled"})
        );
        assert_eq!(result["evidencePath"], Value::Null);
        assert_eq!(result["cases"], json!([]));
        assert!(
            !descendant_survived,
            "the cancelled extension descendant performed work"
        );
    }
}
