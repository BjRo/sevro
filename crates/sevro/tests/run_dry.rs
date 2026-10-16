use jsonschema::Registry;
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "sevro-rust-dry-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir(root.join("tmp")).unwrap();
        fs::write(
            root.join("native"),
            "#!/bin/sh\nprintf invoked >> \"$SEVRO_NATIVE_MARKER\"\nexit 98\n",
        )
        .unwrap();
        fs::set_permissions(root.join("native"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("auth.json"), "PRIVATE_DRY_CREDENTIAL").unwrap();
        write_json(
            &root.join("case.json"),
            &json!({
                "id":"dry-example", "prompt":"Return ready.",
                "fixture":{"files":{"README.md":"prepared fixture\n","nested/input.txt":"original input"}},
                "checks":[{"id":"answer","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
                "requiredEvidence":["example.receipt"]
            }),
        );
        Self { root }
    }

    fn invoke(&self, additional: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_sevro"))
            .current_dir(&self.root)
            .env("TMPDIR", self.root.join("tmp"))
            .env("SEVRO_NATIVE_MARKER", self.root.join("native-invocations"))
            .args([
                "run",
                "--json",
                "--dry",
                "--case-file",
                "case.json",
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
                "--runner-build-digest",
            ])
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64))
            .args(additional)
            .output()
            .unwrap()
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

fn validate_documents(result: &Value, evidence: &Value) {
    let mut registry = Registry::new();
    for (id, source) in [
        (
            "urn:sevro:schema:cli-result:v1",
            include_str!("../../../schemas/cli-result-v1.schema.json"),
        ),
        (
            "urn:sevro:schema:run-evidence:v1",
            include_str!("../../../schemas/run-evidence-v1.schema.json"),
        ),
    ] {
        registry = registry
            .add(id, serde_json::from_str::<Value>(source).unwrap())
            .unwrap();
    }
    let registry = registry.prepare().unwrap();
    for (id, document) in [("cli-result", result), ("run-evidence", evidence)] {
        let schema = json!({"$ref":format!("urn:sevro:schema:{id}:v1")});
        let validator = jsonschema::draft202012::options()
            .with_registry(&registry)
            .build(&schema)
            .unwrap();
        let errors = validator
            .iter_errors(document)
            .map(|error| error.to_string())
            .collect::<Vec<_>>();
        assert!(errors.is_empty(), "invalid {id}: {errors:?}");
    }
}

#[test]
fn prepares_inline_native_dry_run() {
    let fixture = Fixture::new();
    let output = fixture.invoke(&[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .lines()
            .count(),
        1
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"not_run"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    assert_eq!(result["exitCode"], 0);
    assert_eq!(result["cases"].as_array().unwrap().len(), 1);
    assert_eq!(result["cases"][0]["caseId"], "dry-example");
    assert_eq!(result["cases"][0]["trials"].as_array().unwrap().len(), 1);
    let trial = &result["cases"][0]["trials"][0];
    assert_eq!(trial["checks"], json!([]));
    assert_eq!(trial["execution"], json!({"status":"not_run"}));
    let evidence_path = Path::new(result["evidencePath"].as_str().unwrap());
    assert!(evidence_path.starts_with(fixture.root.join(".sevro/results")));
    let evidence = read_json(evidence_path);
    validate_documents(&result, &evidence);
    assert_eq!(evidence["result"], result);
    assert_eq!(
        read_json(&evidence_path.parent().unwrap().join("result.json")),
        result
    );
    assert_eq!(
        read_json(&fixture.root.join(".sevro/results/latest.json")),
        result
    );
    let trial_file = read_json(Path::new(trial["artifactPath"].as_str().unwrap()));
    assert_eq!(trial_file["format"], "sevro.trial-evidence.v1");
    assert_eq!(trial_file["result"], *trial);
    assert_eq!(trial_file["evidence"], evidence["trials"][0]);
    let details = &evidence["trials"][0];
    assert_eq!(details["executionMode"], "dry");
    assert_eq!(details["candidateDurationMs"], Value::Null);
    assert_eq!(details["condition"]["actual"], "unknown");
    assert_eq!(
        details["usage"],
        json!({"inputTokens":null,"outputTokens":null,"costUsd":null,"complete":false})
    );
    assert_eq!(
        details["rawResult"],
        json!({"source":"sevro.host.codex","path":null,"sha256":null})
    );
    assert_eq!(details["artifactRefs"], json!([]));
    let dimensions = &evidence["evaluationIdentity"]["dimensions"];
    assert_eq!(dimensions["runnerBuildDigest"], "a".repeat(64));
    assert_eq!(dimensions["projectDigest"], "b".repeat(64));
    assert_eq!(dimensions["trialCount"], 1);
    assert_eq!(dimensions["passThreshold"], 1);
    assert_eq!(dimensions["condition"], "passive");
    // Fixed SHA-256 vectors of the contract's canonical JSON inputs, computed
    // independently from the Rust implementation before the first red run.
    for (key, digest) in [
        (
            "caseDigest",
            "d220f185d67b31f211f447d1256e3bfd963136a7665066cf4452dc9952429668",
        ),
        (
            "fixtureDigest",
            "03588770762134a5aaaa619ccdfb785e9fdb71be020bdc651eff8ddbf3a14d00",
        ),
        (
            "checksDigest",
            "fbdd95b077bfbcfb98b04346b5f38364a31d0f99fac56ceefb68b6257f72f242",
        ),
        (
            "requiredEvidenceDigest",
            "161c1e21ac93ec931b698c87e715a0186b1a5802b84a294fbd35b61c3a883d1e",
        ),
        (
            "evaluatorDigest",
            "83e25fab2f2b5e428797aca26fd748d7a668565097e8d5ebfc83ec11c923dafc",
        ),
        (
            "graderDigest",
            "14c7c54696ae32d30b27de6a73390d05e32fdbec3f205517cceddcb907bde5d8",
        ),
        (
            "instrumentationDigest",
            "5e40c8352580659036b6fcb1cd6ef506c2c09d7a673a75a50914e53efa43f45a",
        ),
        (
            "routeDigest",
            "6b9d7cd6551a077909838fb7c000e6f4a42dde97babc608e8c2f348a57bda6e4",
        ),
    ] {
        assert_eq!(dimensions[key], digest, "{key}");
    }
    let workspace = details["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert_eq!(workspace["completeness"], "complete");
    let candidate = Path::new(workspace["data"]["candidate"].as_str().unwrap());
    let temporary_root = if cfg!(target_os = "linux") {
        PathBuf::from("/var/tmp")
    } else {
        fixture.root.join("tmp")
    };
    assert!(candidate.starts_with(temporary_root.join("sevro-workspaces-private")));
    assert!(
        !candidate.exists(),
        "successful dry fixture must be cleaned"
    );
    assert_eq!(
        evidence["configuration"]["redacted"]["executionMode"],
        "dry"
    );
    assert_eq!(evidence["configuration"]["redacted"]["jobs"], 3);
    assert_eq!(
        evidence["configuration"]["redacted"]["hostConfiguration"]["candidate"]["sevro.host.executable"],
        fixture.root.join("native").to_str().unwrap()
    );
    assert_eq!(evidence["runner"]["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(evidence["project"]["revision"], Value::Null);
    assert_eq!(evidence["project"]["dirtyPatchDigest"], Value::Null);
    assert!(
        !String::from_utf8_lossy(&fs::read(evidence_path).unwrap())
            .contains("PRIVATE_DRY_CREDENTIAL")
    );
    assert!(!fixture.root.join("native-invocations").exists());
    assert!(String::from_utf8_lossy(&output.stderr).contains("sevro: effective settings "));
    assert!(String::from_utf8_lossy(&output.stderr).contains("skipped"));
    assert_eq!(
        fs::metadata(evidence_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
