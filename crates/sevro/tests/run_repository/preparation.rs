use super::{RepositoryFixture, boundaries::failure, git, write_json};
use serde_json::{Value, json};
use std::fs;

fn inline_case() -> Value {
    json!({
        "id":"direct-case", "prompt":"Return ready.",
        "fixture":{"files":{"README.md":"inline fixture\n"}},
        "checks":[{"id":"answer","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
        "requiredEvidence":[]
    })
}

fn assert_invalid_case(case: &Value, detail: &str) {
    let fixture = RepositoryFixture::new();
    let case_file = fixture.root.join("case.json");
    write_json(&case_file, case);
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        failure(
            64,
            &format!(
                "resolved case file is unreadable or invalid at {}: invalid resolved case file: {detail}; supply --case-file with readable JSON and correct the named field",
                case_file.display()
            )
        )
    );
    assert!(!fixture.root.join("native-invocations").exists());
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "repository fixture\n"
    );
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
}

#[test]
fn rejects_a_present_null_follow_up_prompt() {
    let mut case = inline_case();
    case["followUpPrompt"] = Value::Null;
    assert_invalid_case(&case, "followUpPrompt: omit or supply a nonblank string");
}

#[test]
fn rejects_an_empty_case_id_but_accepts_a_whitespace_id() {
    let mut case = inline_case();
    case["id"] = json!("");
    assert_invalid_case(&case, "id: expected a nonempty string");

    let fixture = RepositoryFixture::new();
    case["id"] = json!(" ");
    write_json(&fixture.root.join("case.json"), &case);
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"not_run"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    assert_eq!(result["cases"][0]["caseId"], " ");
    assert_eq!(result["cases"][0]["trials"][0]["checks"], json!([]));
    assert!(!fixture.root.join("native-invocations").exists());
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "repository fixture\n"
    );
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
}

#[test]
fn names_the_missing_checks_field_in_a_direct_case() {
    let mut case = inline_case();
    case.as_object_mut().unwrap().remove("checks");
    assert_invalid_case(&case, "checks: expected an array of check objects");
}

#[test]
fn names_a_null_check_configuration_in_a_direct_case() {
    let mut case = inline_case();
    case["checks"][0]["configuration"] = Value::Null;
    assert_invalid_case(&case, "checks[0].configuration: expected an object");
}

#[test]
fn rejects_duplicate_check_ids_with_the_case_diagnostic() {
    let mut case = inline_case();
    let check = case["checks"][0].clone();
    case["checks"] = json!([check, check]);
    assert_preparation_failure(&case, "case check IDs must be unique");
}

fn assert_preparation_failure(case: &Value, message: &str) {
    let fixture = RepositoryFixture::new();
    write_json(&fixture.root.join("case.json"), case);
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result, failure(64, message));
    assert!(!fixture.root.join("native-invocations").exists());
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "repository fixture\n"
    );
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
}

#[test]
fn rejects_invalid_required_evidence_identifiers() {
    for identifiers in [json!([""]), json!(["receipt"])] {
        let mut case = inline_case();
        case["requiredEvidence"] = identifiers;
        assert_preparation_failure(&case, "invalid required evidence IDs");
    }
}

#[test]
fn rejects_duplicate_required_evidence_identifiers() {
    let mut case = inline_case();
    case["requiredEvidence"] = json!(["example.receipt", "example.receipt"]);
    assert_preparation_failure(&case, "invalid required evidence IDs");
}

#[test]
fn rejects_kind_tags_in_direct_inline_or_repository_cases() {
    for declaration in [
        json!({"kind":"inline","files":{}}),
        json!({"kind":"repository","sourceRef":"fixture-repo"}),
        json!({"kind":null,"files":{}}),
    ] {
        let mut case = inline_case();
        case["fixture"] = declaration;
        assert_invalid_case(
            &case,
            "fixture.kind: omit for inline/repository fixtures, or use generated",
        );
    }
}

#[test]
fn accepts_extra_direct_inline_properties_without_changing_fixture_identity() {
    let fixture = RepositoryFixture::new();
    let mut case = inline_case();
    case["fixture"] = json!({"files":{},"unused":true});
    write_json(&fixture.root.join("case.json"), &case);
    let output = fixture.invoke();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"not_run"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    let evidence: Value =
        serde_json::from_slice(&fs::read(result["evidencePath"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!(evidence["result"], result);
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["caseDigest"],
        "4f0ebf312483328e3bf31a35f318b16f22bc1c1ac7f420bba0cb045dfb9fed0a"
    );
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        "fc1f5d14b99603011b03d4001fe6fe3b9062e39ea6c25fca4782b0d1022e428c"
    );
    let workspace = evidence["trials"][0]["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap()["data"]["candidate"]
        .as_str()
        .unwrap();
    assert!(!std::path::Path::new(workspace).exists());
    assert!(!fixture.root.join("native-invocations").exists());
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "repository fixture\n"
    );
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
}

#[test]
fn rejects_a_present_null_repository_source_reference() {
    let mut case = inline_case();
    case["fixture"] = json!({"sourceRef":null,"files":{}});
    assert_invalid_case(
        &case,
        "fixture: invalid repository fixture; correct the fixture declaration",
    );
}
