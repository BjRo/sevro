use super::{RepositoryFixture, boundaries::failure, git, write_json};
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

#[path = "artifacts/sources.rs"]
mod sources;

fn artifact_arguments() -> [&'static str; 6] {
    [
        "--extension-command-file",
        "setup-command.json",
        "--extension-source-file",
        "setup-extension.mjs",
        "--case-id",
        "repository-setup",
    ]
}

#[test]
fn retains_a_declared_source_artifact_with_verified_bytes() {
    let fixture = RepositoryFixture::new();
    let source = fixture.root.join("sources/data.txt");
    fs::write(&source, b"prepared data\n").unwrap();
    write_json(
        &fixture.root.join("source-map.json"),
        &json!({
            "input-data":url::Url::from_file_path(&source).unwrap().as_str()
        }),
    );
    fixture.extension(
        json!({"kind":"inline","files":{"README.txt":"fixture only\n"}}),
        json!({"artifacts":[{
            "id":"generated-file","relativePath":"generated/data.txt",
            "sha256":"738fb5667d1f1ac841e87be5a842e667ef9ff77e7f06f59141a7d59c4caa5d8f",
            "sourceRef":"input-data"
        }],"requestedInstrumentation":[],"extensionData":{}}),
        json!([]),
    );
    let output = fixture.invoke_source(&artifact_arguments());
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
    assert_eq!(
        evidence["configuration"]["resolved"]["caseSourceMapping"],
        true
    );
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        "474fdf0f1a03f43b3e2fc85158bd7dc3b3a99636d8d5226ecf92b227cbbcbc75"
    );
    let artifacts = evidence["trials"][0]["artifactRefs"].as_array().unwrap();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0]["id"], "generated-file");
    assert_eq!(
        artifacts[0]["sha256"],
        "738fb5667d1f1ac841e87be5a842e667ef9ff77e7f06f59141a7d59c4caa5d8f"
    );
    let retained = url::Url::parse(artifacts[0]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(&retained).unwrap(), b"prepared data\n");
    assert_eq!(
        fs::metadata(retained).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(fs::read(source).unwrap(), b"prepared data\n");
    assert!(!fixture.root.join("native-invocations").exists());
    let workspace = evidence["trials"][0]["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|observation| observation["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert!(!Path::new(workspace["data"]["candidate"].as_str().unwrap()).exists());
}

#[test]
fn rejects_reused_artifact_ids_with_distinct_verified_payloads() {
    let fixture = RepositoryFixture::new();
    fixture.extension(
        json!({"kind":"inline","files":{}}),
        json!({"artifacts":[{
            "id":"same-id","relativePath":"generated/first.txt",
            "sha256":"b640e840b19d378660b32fb51ae18d67dccb4a8596a29e7bd72c1b2ae5928f41",
            "contentBase64":"Zmlyc3QK"
        },{
            "id":"same-id","relativePath":"generated/second.txt",
            "sha256":"480c2336b410f1ad5f8bf1b28944490255804b65350c527787e74ebdd511e3a4",
            "contentBase64":"c2Vjb25kCg=="
        }],"requestedInstrumentation":[],"extensionData":{}}),
        json!([]),
    );
    let output = fixture.invoke_source(&artifact_arguments());
    assert_eq!(output.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        failure(64, "preparation artifact IDs must be unique and nonempty")
    );
    assert!(!fixture.root.join("native-invocations").exists());
    assert!(!fixture.source.join("generated").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
}

#[test]
fn validates_git_exclusion_for_inline_fixture_artifacts() {
    for (path, excluded, diagnostic) in [
        (
            "generated/data.txt",
            true,
            Some("Git-excluded preparation artifacts require a Git fixture"),
        ),
        (
            "generated/line\nbreak.txt",
            true,
            Some("Git-excluded artifact path contains control characters"),
        ),
        (
            "generated/line\u{7f}break.txt",
            true,
            Some("Git-excluded artifact path contains control characters"),
        ),
        ("generated/data.txt", false, None),
    ] {
        let fixture = RepositoryFixture::new();
        fixture.extension(
            json!({"kind":"inline","files":{"README.txt":"fixture only\n"}}),
            json!({"artifacts":[{
                "id":"ordinary","relativePath":path,
                "sha256":"b640e840b19d378660b32fb51ae18d67dccb4a8596a29e7bd72c1b2ae5928f41",
                "contentBase64":"Zmlyc3QK","gitExclude":excluded,"executable":false
            }],"requestedInstrumentation":[],"extensionData":{}}),
            json!([]),
        );
        let output = fixture.invoke_source(&artifact_arguments());
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        if let Some(message) = diagnostic {
            assert_eq!(output.status.code(), Some(64));
            assert_eq!(result, failure(64, message));
        } else {
            assert_eq!(output.status.code(), Some(0), "{result}");
            let evidence: Value = serde_json::from_slice(
                &fs::read(result["evidencePath"].as_str().unwrap()).unwrap(),
            )
            .unwrap();
            assert_eq!(
                evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
                "cbc0c4d89d19a067e49317e0325bda7c587c828fdb20e428f841483c5c43dea3"
            );
            let artifact = &evidence["trials"][0]["artifactRefs"][0];
            assert_eq!(artifact.as_object().unwrap().len(), 3);
            assert_eq!(artifact["id"], "ordinary");
            assert_eq!(
                artifact["sha256"],
                "b640e840b19d378660b32fb51ae18d67dccb4a8596a29e7bd72c1b2ae5928f41"
            );
            let retained = url::Url::parse(artifact["path"].as_str().unwrap())
                .unwrap()
                .to_file_path()
                .unwrap();
            assert_eq!(fs::read(&retained).unwrap(), b"first\n");
            assert_eq!(
                fs::metadata(retained).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(!fixture.root.join("native-invocations").exists());
        assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    }
}

#[test]
fn rejects_artifact_prefix_collisions_and_tracked_file_traversal() {
    for (paths, exit, message) in [
        (
            vec!["generated", "generated/nested.txt"],
            64,
            "fixture paths collide",
        ),
        (
            vec!["generated/nested.txt", "generated"],
            64,
            "fixture paths collide",
        ),
        (
            vec!["README.md/nested.txt"],
            70,
            "preparation artifact traverses a non-directory",
        ),
    ] {
        let fixture = RepositoryFixture::new();
        let artifacts: Vec<Value> = paths
            .iter()
            .enumerate()
            .map(|(index, path)| {
                json!({
                    "id":format!("artifact-{index}"),"relativePath":path,
                    "sha256":"b640e840b19d378660b32fb51ae18d67dccb4a8596a29e7bd72c1b2ae5928f41",
                    "contentBase64":"Zmlyc3QK"
                })
            })
            .collect();
        fixture.extension(
            json!({"kind":"repository","sourceRef":"fixture-repo"}),
            json!({"artifacts":artifacts,"requestedInstrumentation":[],"extensionData":{}}),
            json!([]),
        );
        let output = fixture.invoke_source(&artifact_arguments());
        assert_eq!(output.status.code(), Some(exit), "{paths:?}");
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result, failure(exit, message));
        assert_eq!(
            fs::read_to_string(fixture.source.join("README.md")).unwrap(),
            "repository fixture\n"
        );
        assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
        assert!(!fixture.source.join("generated").exists());
        assert!(!fixture.root.join("native-invocations").exists());
    }
}

#[test]
fn rejects_nonzero_base64_padding_bits_before_artifact_mounting() {
    let fixture = RepositoryFixture::new();
    fixture.extension(
        json!({"kind":"inline","files":{}}),
        json!({"artifacts":[{
            "id":"data","relativePath":"generated/data.txt",
            "sha256":"252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111",
            "contentBase64":"Zh=="
        }],"requestedInstrumentation":[],"extensionData":{}}),
        json!([]),
    );
    let output = fixture.invoke_source(&artifact_arguments());
    assert_eq!(output.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        failure(64, "preparation artifact content is not canonical base64")
    );
    assert!(!fixture.source.join("generated").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert!(!fixture.root.join("native-invocations").exists());
}

#[test]
fn executes_a_git_excluded_artifact_without_hiding_candidate_changes() {
    let fixture = RepositoryFixture::new();
    fixture.extension(
        json!({"kind":"repository","sourceRef":"fixture-repo"}),
        json!({"artifacts":[{
            "id":"fixture-tool","relativePath":"tools/a [x]*#!?.sh",
            "sha256":"4dff0af9c31ff94f69d72a4e2ef303315bdc5b0ef219ba66931d38b0330dd8a1",
            "contentBase64":"IyEvYmluL3NoCnByaW50ZiAndG9vbC1yZWFkeVxuJwo=",
            "gitExclude":true,"executable":true
        }],"requestedInstrumentation":[],"extensionData":{}}),
        json!([]),
    );
    fs::write(fixture.root.join("adapter.ts"),r#"import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default {id:'example.fixture-reader',model:'synthetic',effort:'none',run({workspace}) {
 const tool=Bun.spawnSync([join(workspace,'tools/a [x]*#!?.sh')],{cwd:workspace});
 if(tool.exitCode!==0) throw new Error('prepared tool did not execute');
 writeFileSync(join(workspace,'tools/candidate.sh'),'candidate change\n');
 const status=Bun.spawnSync(['git','status','--porcelain=v1','--untracked-files=all'],{cwd:workspace});
 if(status.exitCode!==0) throw new Error('Git status failed');
 return {complete:true,finalMessage:JSON.stringify({tool:tool.stdout.toString(),status:status.stdout.toString()})};
}};
"#).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_sevro"))
        .current_dir(&fixture.root)
        .env("TMPDIR", fixture.root.join("tmp"))
        .args([
            "run",
            "--json",
            "--adapter-module",
            "adapter.ts",
            "--extension-command-file",
            "setup-command.json",
            "--extension-source-file",
            "setup-extension.mjs",
            "--case-id",
            "repository-setup",
            "--case-source-map-file",
            "source-map.json",
            "--case-source-root",
        ])
        .arg(fixture.root.join("sources"))
        .arg("--runner-build-digest")
        .arg("a".repeat(64))
        .arg("--project-digest")
        .arg("b".repeat(64))
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"], json!({"status":"completed"}));
    assert_eq!(result["grading"], json!({"status":"not_requested"}));
    assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
    let evidence: Value =
        serde_json::from_slice(&fs::read(result["evidencePath"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        "6e12cda3f9e94a77b841d110f0b8fe1ea0d79a08e5f2ffe8b2b34c86df581c4a"
    );
    let trial = &evidence["trials"][0];
    let raw = url::Url::parse(trial["rawResult"]["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(
        fs::read_to_string(raw).unwrap(),
        r#"{"tool":"tool-ready\n","status":"?? tools/candidate.sh\n"}"#
    );
    assert_eq!(
        trial["rawResult"]["sha256"],
        "a96b5763f9f158619d2d2166676c47446a3cae1937a7ebccc8009ed5069e190e"
    );
    assert_eq!(trial["artifactRefs"].as_array().unwrap().len(), 1);
    let artifact = &trial["artifactRefs"][0];
    assert_eq!(artifact["id"], "fixture-tool");
    assert_eq!(
        artifact["sha256"],
        "4dff0af9c31ff94f69d72a4e2ef303315bdc5b0ef219ba66931d38b0330dd8a1"
    );
    assert_eq!(artifact["gitExclude"], true);
    assert_eq!(artifact["executable"], true);
    let retained = url::Url::parse(artifact["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(
        fs::read(&retained).unwrap(),
        b"#!/bin/sh\nprintf 'tool-ready\\n'\n"
    );
    assert_eq!(
        fs::metadata(&retained).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let workspace = trial["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    assert!(!Path::new(workspace["data"]["candidate"].as_str().unwrap()).exists());
    assert!(!fixture.source.join("tools").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
}
