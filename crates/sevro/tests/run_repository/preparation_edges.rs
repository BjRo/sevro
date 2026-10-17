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
fn names_a_missing_prompt_before_malformed_fixture_fields() {
    let mut case = inline_case();
    case.as_object_mut().unwrap().remove("prompt");
    assert_invalid_case(&case, "prompt: expected a nonempty string");
    case["fixture"] = Value::Null;
    assert_invalid_case(&case, "prompt: expected a nonempty string");
}

#[test]
fn requires_a_nonempty_prompt_but_accepts_whitespace() {
    for prompt in [json!(""), Value::Null, json!(7)] {
        let mut case = inline_case();
        case["prompt"] = prompt;
        assert_invalid_case(&case, "prompt: expected a nonempty string");
    }
    let fixture = RepositoryFixture::new();
    let mut case = inline_case();
    case["prompt"] = json!(" ");
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
    assert!(!fixture.root.join("native-invocations").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
}

#[test]
fn names_blank_or_nonstring_follow_up_prompts() {
    for prompt in [json!(""), json!(" \t"), json!(7)] {
        let mut case = inline_case();
        case["followUpPrompt"] = prompt;
        assert_invalid_case(&case, "followUpPrompt: omit or supply a nonblank string");
    }
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
fn names_an_empty_output_check_id() {
    let mut case = inline_case();
    case["checks"][0]["id"] = json!("");
    assert_preparation_failure(&case, "duplicate or empty check ID: ");
}

#[test]
fn refuses_a_direct_case_without_its_requested_extension_grader() {
    for grader in ["example.missing", ""] {
        let mut case = inline_case();
        case["checks"][0]["grader"] = json!(grader);
        assert_preparation_failure(&case, "case declares an unavailable extension grader");
    }
}

#[test]
fn names_a_missing_or_nonobject_fixture() {
    let mut case = inline_case();
    case.as_object_mut().unwrap().remove("fixture");
    assert_invalid_case(&case, "fixture: expected an object");
    for fixture in [Value::Null, json!([])] {
        case["fixture"] = fixture;
        assert_invalid_case(&case, "fixture: expected an object");
    }
}

#[test]
fn names_a_missing_or_nonobject_inline_file_map() {
    for fixture in [json!({}), json!({"files":null}), json!({"files":[]})] {
        let mut case = inline_case();
        case["fixture"] = fixture;
        assert_invalid_case(
            &case,
            "fixture.files: expected an object mapping file paths to string contents",
        );
    }
}

#[test]
fn names_the_inline_file_with_nonstring_contents() {
    let mut case = inline_case();
    case["fixture"] = json!({"files":{"README.md":7}});
    assert_invalid_case(
        &case,
        "fixture.files[\"README.md\"]: expected string contents",
    );
}
