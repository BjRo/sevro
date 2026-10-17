use super::{RepositoryFixture, git, write_json};
use serde_json::{Value, json};
use std::fs;

#[test]
fn refuses_invalid_or_colliding_artifacts_without_modifying_the_source() {
    for (scenario, exit, message) in [
        (
            "wrong-digest",
            64,
            "preparation artifact digest does not match content",
        ),
        (
            "noncanonical-base64",
            64,
            "preparation artifact content is not canonical base64",
        ),
        (
            "duplicate-id",
            64,
            "preparation artifact IDs must be unique and nonempty",
        ),
        (
            "metadata-path",
            64,
            "preparation artifacts cannot modify repository metadata",
        ),
        ("traversal-path", 64, "invalid fixture path: ../escaped.txt"),
        (
            "existing-target",
            70,
            "preparation artifact path already exists",
        ),
        ("colliding-overlay", 64, "fixture paths collide"),
    ] {
        let fixture = RepositoryFixture::new();
        let mut declaration = json!({"kind":"repository","sourceRef":"fixture-repo"});
        let mut artifact = json!({
            "id":"generated-file","relativePath":"generated/data.txt",
            "sha256":"738fb5667d1f1ac841e87be5a842e667ef9ff77e7f06f59141a7d59c4caa5d8f",
            "contentBase64":"cHJlcGFyZWQgZGF0YQo="
        });
        match scenario {
            "wrong-digest" => artifact["sha256"] = json!("0".repeat(64)),
            "noncanonical-base64" => artifact["contentBase64"] = json!("cHJlcGFyZWQgZGF0YQo"),
            "metadata-path" => artifact["relativePath"] = json!(".git/config"),
            "traversal-path" => artifact["relativePath"] = json!("../escaped.txt"),
            "existing-target" => artifact["relativePath"] = json!("README.md"),
            "colliding-overlay" => {
                declaration["files"] = json!({"generated/data.txt":"overlay data\n"})
            }
            "duplicate-id" => {}
            _ => unreachable!(),
        }
        let mut artifacts = vec![artifact];
        if scenario == "duplicate-id" {
            let mut duplicate = artifacts[0].clone();
            duplicate["relativePath"] = json!("generated/second.txt");
            artifacts.push(duplicate);
        }
        fixture.extension(
            declaration,
            json!({
                "artifacts":artifacts,"requestedInstrumentation":[],"extensionData":{}
            }),
            json!([]),
        );
        let output = fixture.invoke_source(&[
            "--extension-command-file",
            "setup-command.json",
            "--extension-source-file",
            "setup-extension.mjs",
            "--case-id",
            "repository-setup",
        ]);
        assert_eq!(
            output.status.code(),
            Some(exit),
            "{scenario}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result, failure(exit, message), "{scenario}");
        assert_eq!(
            fs::read_to_string(fixture.source.join("README.md")).unwrap(),
            "repository fixture\n",
            "{scenario}"
        );
        assert!(!fixture.source.join("generated").exists(), "{scenario}");
        assert_eq!(
            git(&fixture.source, &["status", "--porcelain=v1"]),
            "",
            "{scenario}"
        );
        assert_eq!(
            git(&fixture.source, &["rev-parse", "HEAD"]),
            "f4d351b20b90e67f9e9092777856c0135110b023",
            "{scenario}"
        );
        assert!(
            !fixture.root.join("native-invocations").exists(),
            "{scenario}"
        );
    }
}

#[test]
fn refuses_dirty_or_escaping_repository_sources_without_mutation() {
    for (scenario, message, expected_bytes) in [
        (
            "dirty",
            "repository source has uncommitted changes",
            "dirty source\n",
        ),
        (
            "escaping",
            "repository source escapes its declared root",
            "repository fixture\n",
        ),
    ] {
        let fixture = RepositoryFixture::new();
        let source = if scenario == "dirty" {
            fs::write(fixture.source.join("README.md"), expected_bytes).unwrap();
            fixture.source.clone()
        } else {
            let external = fixture.root.join("external");
            fs::rename(&fixture.source, &external).unwrap();
            write_json(
                &fixture.root.join("source-map.json"),
                &json!({
                    "fixture-repo":url::Url::from_file_path(&external).unwrap().as_str()
                }),
            );
            external
        };
        let original_status = git(&source, &["status", "--porcelain=v1"]);
        let output = fixture.invoke();
        assert_eq!(
            output.status.code(),
            Some(64),
            "{scenario}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result, failure(64, message), "{scenario}");
        assert_eq!(
            fs::read_to_string(source.join("README.md")).unwrap(),
            expected_bytes
        );
        assert_eq!(git(&source, &["status", "--porcelain=v1"]), original_status);
        assert_eq!(
            git(&source, &["rev-parse", "HEAD"]),
            "f4d351b20b90e67f9e9092777856c0135110b023"
        );
        assert!(!fixture.root.join("native-invocations").exists());
    }
}

pub(super) fn failure(exit: i32, message: &str) -> Value {
    json!({
        "format":"sevro.cli-result.v1","runId":null,"execution":{"status":"not_run"},
        "grading":{"status":"not_requested"},"task":{"verdict":"not_assessed"},
        "exitCode":exit,"evidencePath":null,"cases":[],
        "diagnostic":{"code":if exit == 64 {"sevro.invocation.invalid"} else {"sevro.runner.error"},"message":message}
    })
}

#[test]
fn refuses_an_undeclared_repository_reference() {
    let fixture = RepositoryFixture::new();
    write_json(&fixture.root.join("source-map.json"), &json!({}));
    let output = fixture.invoke();
    assert_eq!(output.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        failure(64, "repository source reference is not declared")
    );
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "repository fixture\n"
    );
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert!(!fixture.root.join("native-invocations").exists());
}

#[test]
fn validates_the_entire_source_map_as_file_urls() {
    for mapping in [
        Value::Null,
        json!([]),
        json!({"fixture-repo":42}),
        json!({"fixture-repo":"https://example.invalid/repository"}),
        json!({"fixture-repo":"file:///unused","unused":"https://example.invalid/repository"}),
    ] {
        let fixture = RepositoryFixture::new();
        let mut mapping = mapping;
        if mapping.get("unused").is_some() {
            mapping["fixture-repo"] =
                json!(url::Url::from_file_path(&fixture.source).unwrap().as_str());
        }
        write_json(&fixture.root.join("source-map.json"), &mapping);
        let output = fixture.invoke();
        assert_eq!(output.status.code(), Some(64));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            result,
            failure(64, "case source map must contain file URLs"),
            "{mapping}"
        );
        assert_eq!(
            fs::read_to_string(fixture.source.join("README.md")).unwrap(),
            "repository fixture\n"
        );
        assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
        assert!(!fixture.root.join("native-invocations").exists());
    }
}

#[test]
fn requires_a_readable_committed_repository_root() {
    for (scenario, message) in [
        ("file", "repository source is unreadable"),
        ("missing", "repository source is unreadable"),
        ("directory", "repository fixture Git operation failed"),
        ("unborn", "repository fixture Git operation failed"),
        (
            "subdirectory",
            "repository source must name the repository root",
        ),
    ] {
        let fixture = RepositoryFixture::new();
        let selected = match scenario {
            "file" => fixture.source.join("README.md"),
            "subdirectory" => fixture.source.join("empty-subdirectory"),
            _ => fixture.root.join("sources").join(scenario),
        };
        if matches!(scenario, "directory" | "unborn" | "subdirectory") {
            fs::create_dir(&selected).unwrap();
        }
        if scenario == "unborn" {
            git(&selected, &["init", "--quiet"]);
        }
        write_json(
            &fixture.root.join("source-map.json"),
            &json!({
                "fixture-repo":url::Url::from_file_path(&selected).unwrap().as_str()
            }),
        );
        let output = fixture.invoke();
        assert_eq!(output.status.code(), Some(64), "{scenario}");
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result, failure(64, message), "{scenario}");
        assert_eq!(
            fs::read_to_string(fixture.source.join("README.md")).unwrap(),
            "repository fixture\n"
        );
        assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
        assert!(!fixture.root.join("native-invocations").exists());
    }
}

#[test]
fn bounds_real_repository_status_output_without_mutating_source_files() {
    let fixture = RepositoryFixture::new();
    for index in 0..1024 {
        fs::write(
            fixture
                .source
                .join(format!("{index:04}-{}", "x".repeat(64))),
            "source sentinel\n",
        )
        .unwrap();
    }
    let original_status = git(
        &fixture.source,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    );
    assert_eq!(original_status.lines().count(), 1024);
    let output = fixture.invoke();
    assert_eq!(output.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        failure(64, "repository fixture Git output is too large")
    );
    assert_eq!(
        git(
            &fixture.source,
            &["status", "--porcelain=v1", "--untracked-files=all"]
        ),
        original_status
    );
    for index in 0..1024 {
        assert_eq!(
            fs::read_to_string(
                fixture
                    .source
                    .join(format!("{index:04}-{}", "x".repeat(64)))
            )
            .unwrap(),
            "source sentinel\n"
        );
    }
    assert!(!fixture.root.join("native-invocations").exists());
}
