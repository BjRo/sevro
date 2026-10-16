use super::{RepositoryFixture, artifact_arguments, failure, write_json};
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::symlink;
use std::process::{Command, Output};

const CHUNK_DIGEST: &str = "9bc1b2a288b26af7257a36277ae3816a7d4f16e89c1e7e77d0a5c48bad62b360";
const TAIL_DIGEST: &str = "3311ea1faad557de3899e89a39076c69d9d0cc5b4cff56a0b61339f487395d56";
const BYTE_DIGEST: &str = "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb";

fn source_artifact(id: &str, digest: &str, reference: &str) -> Value {
    json!({
        "id":id,"relativePath":format!("generated/{id}.txt"),
        "sha256":digest,"sourceRef":reference
    })
}

fn declare(fixture: &RepositoryFixture, artifacts: Vec<Value>) {
    fixture.extension(
        json!({"kind":"inline","files":{"README.txt":"fixture only\n"}}),
        json!({"artifacts":artifacts,"requestedInstrumentation":[],"extensionData":{}}),
        json!([]),
    );
}

fn success(output: &Output) -> Value {
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
    serde_json::from_slice(&fs::read(result["evidencePath"].as_str().unwrap()).unwrap()).unwrap()
}

fn assert_retained(evidence: &Value, index: usize, id: &str, bytes: &[u8], digest: &str) {
    let artifact = &evidence["trials"][0]["artifactRefs"][index];
    assert_eq!(artifact["id"], id);
    assert_eq!(artifact["sha256"], digest);
    let retained = url::Url::parse(artifact["path"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(fs::read(retained).unwrap(), bytes);
}

#[test]
fn requires_canonical_source_paths_to_be_strict_descendants() {
    for scenario in ["internal-alias", "root", "outside", "escaping-alias"] {
        let fixture = RepositoryFixture::new();
        let source = fixture.root.join("sources/data.txt");
        let outside = fixture.root.join("outside.txt");
        fs::write(&source, b"prepared data\n").unwrap();
        fs::write(&outside, b"outside bytes\n").unwrap();
        let selected = match scenario {
            "internal-alias" => {
                let alias = fixture.root.join("sources/alias.txt");
                symlink("data.txt", &alias).unwrap();
                alias
            }
            "root" => fixture.root.join("sources"),
            "outside" => outside.clone(),
            "escaping-alias" => {
                let alias = fixture.root.join("sources/alias.txt");
                symlink(&outside, &alias).unwrap();
                alias
            }
            _ => unreachable!(),
        };
        write_json(
            &fixture.root.join("source-map.json"),
            &json!({"input-data":url::Url::from_file_path(selected).unwrap().as_str()}),
        );
        declare(
            &fixture,
            vec![json!({
                "id":"generated-file","relativePath":"generated/data.txt",
                "sha256":"738fb5667d1f1ac841e87be5a842e667ef9ff77e7f06f59141a7d59c4caa5d8f",
                "sourceRef":"input-data"
            })],
        );
        let output = fixture.invoke_source(&artifact_arguments());
        if scenario == "internal-alias" {
            let evidence = success(&output);
            assert_eq!(
                evidence["trials"][0]["artifactRefs"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            assert_retained(
                &evidence,
                0,
                "generated-file",
                b"prepared data\n",
                "738fb5667d1f1ac841e87be5a842e667ef9ff77e7f06f59141a7d59c4caa5d8f",
            );
            assert_eq!(
                evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
                "474fdf0f1a03f43b3e2fc85158bd7dc3b3a99636d8d5226ecf92b227cbbcbc75"
            );
        } else {
            assert_eq!(output.status.code(), Some(64), "{scenario}");
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                result,
                failure(64, "preparation source escapes its declared root")
            );
        }
        assert_eq!(fs::read(source).unwrap(), b"prepared data\n");
        assert_eq!(fs::read(outside).unwrap(), b"outside bytes\n");
        assert!(!fixture.root.join("native-invocations").exists());
    }
}

fn aggregate_declarations(mixed: bool, over: bool) -> Vec<Value> {
    let mut artifacts = Vec::new();
    if mixed {
        artifacts.push(json!({
            "id":"inline","relativePath":"generated/inline.txt",
            "sha256":if over {
                "961b6dd3ede3cb8ecbaacbd68de040cd78eb2ed5889130cceb4c49268ea4d506"
            } else { BYTE_DIGEST },
            "contentBase64":if over {"YWE="} else {"YQ=="}
        }));
    }
    for index in 0..32 {
        let tail = mixed && index == 31;
        artifacts.push(source_artifact(
            &format!("source-{index}"),
            if tail { TAIL_DIGEST } else { CHUNK_DIGEST },
            if tail { "tail" } else { "chunk" },
        ));
    }
    if !mixed && over {
        artifacts.push(source_artifact("extra", BYTE_DIGEST, "extra"));
    }
    artifacts
}

fn assert_aggregate(evidence: &Value, mixed: bool, chunk: &[u8]) {
    let offset = usize::from(mixed);
    assert_eq!(
        evidence["trials"][0]["artifactRefs"]
            .as_array()
            .unwrap()
            .len(),
        32 + offset
    );
    if mixed {
        assert_retained(evidence, 0, "inline", b"a", BYTE_DIGEST);
    }
    for index in 0..32 {
        let tail = mixed && index == 31;
        assert_retained(
            evidence,
            index + offset,
            &format!("source-{index}"),
            if tail {
                &chunk[..chunk.len() - 1]
            } else {
                chunk
            },
            if tail { TAIL_DIGEST } else { CHUNK_DIGEST },
        );
    }
    assert_eq!(
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        if mixed {
            "84f4cacec79f49b63a3f57c24c1bdb86ef0d2c1e7c836c9d03d91e44cf882278"
        } else {
            "d6d8005e7af1050043df4338de3d92f02f09f81afca19157cefd52b53eb94999"
        }
    );
}

#[test]
fn bounds_combined_source_and_inline_artifacts_at_thirty_two_mib() {
    for (mixed, over) in [(false, false), (false, true), (true, false), (true, true)] {
        let fixture = RepositoryFixture::new();
        let chunk = vec![b'a'; 1024 * 1024];
        let tail = &chunk[..chunk.len() - 1];
        for (name, bytes) in [("chunk", chunk.as_slice()), ("tail", tail), ("extra", b"a")] {
            fs::write(fixture.root.join(format!("sources/{name}.txt")), bytes).unwrap();
        }
        let refs: serde_json::Map<String, Value> = ["chunk", "tail", "extra"]
            .into_iter()
            .map(|name| {
                (
                    name.to_owned(),
                    json!(
                        url::Url::from_file_path(fixture.root.join(format!("sources/{name}.txt")))
                            .unwrap()
                            .as_str()
                    ),
                )
            })
            .collect();
        write_json(&fixture.root.join("source-map.json"), &json!(refs));
        declare(&fixture, aggregate_declarations(mixed, over));
        let output = fixture.invoke_source(&artifact_arguments());
        if over {
            assert_eq!(output.status.code(), Some(64));
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                result,
                failure(64, "preparation artifacts exceed the size limit")
            );
        } else {
            assert_aggregate(&success(&output), mixed, &chunk);
        }
        for (name, bytes) in [("chunk", chunk.as_slice()), ("tail", tail), ("extra", b"a")] {
            assert_eq!(
                fs::read(fixture.root.join(format!("sources/{name}.txt"))).unwrap(),
                bytes
            );
        }
        assert!(!fixture.root.join("native-invocations").exists());
    }
}

#[test]
fn refuses_unreadable_source_roots_files_and_directories() {
    for scenario in ["missing-root", "missing-file", "directory"] {
        let fixture = RepositoryFixture::new();
        let mut source = fixture.root.join("sources/data.txt");
        fs::write(&source, b"prepared data\n").unwrap();
        let selected = match scenario {
            "missing-root" => source.clone(),
            "missing-file" => fixture.root.join("sources/missing.txt"),
            "directory" => {
                let directory = fixture.root.join("sources/directory");
                fs::create_dir(&directory).unwrap();
                directory
            }
            _ => unreachable!(),
        };
        write_json(
            &fixture.root.join("source-map.json"),
            &json!({"input-data":url::Url::from_file_path(selected).unwrap().as_str()}),
        );
        if scenario == "missing-root" {
            fs::rename(
                fixture.root.join("sources"),
                fixture.root.join("unavailable-sources"),
            )
            .unwrap();
            source = fixture.root.join("unavailable-sources/data.txt");
        }
        declare(
            &fixture,
            vec![source_artifact(
                "generated-file",
                "738fb5667d1f1ac841e87be5a842e667ef9ff77e7f06f59141a7d59c4caa5d8f",
                "input-data",
            )],
        );
        let output = fixture.invoke_source(&artifact_arguments());
        assert_eq!(output.status.code(), Some(64), "{scenario}");
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            result,
            failure(
                64,
                if scenario == "missing-root" {
                    "preparation source root is unreadable"
                } else {
                    "preparation source is unreadable"
                }
            )
        );
        assert_eq!(fs::read(source).unwrap(), b"prepared data\n");
        assert!(!fixture.root.join("native-invocations").exists());
    }
}

#[test]
fn accepts_eight_mib_source_artifacts_and_refuses_the_next_byte() {
    for (size, digest) in [
        (
            8_388_608,
            "ad97f87076920684e2ca66fc44e5d322797dc9d64706b174e51b5d0828937043",
        ),
        (
            8_388_609,
            "c92697f4cc3b569dff3d484285d22487e523d4b439ae7c9a6747dc258e35b275",
        ),
    ] {
        let fixture = RepositoryFixture::new();
        let source = fixture.root.join("sources/data.txt");
        let bytes = vec![b'a'; size];
        fs::write(&source, &bytes).unwrap();
        write_json(
            &fixture.root.join("source-map.json"),
            &json!({"input-data":url::Url::from_file_path(&source).unwrap().as_str()}),
        );
        declare(
            &fixture,
            vec![source_artifact("generated-file", digest, "input-data")],
        );
        let output = fixture.invoke_source(&artifact_arguments());
        if size == 8_388_608 {
            let evidence = success(&output);
            assert_eq!(
                evidence["trials"][0]["artifactRefs"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            assert_retained(&evidence, 0, "generated-file", &bytes, digest);
        } else {
            assert_eq!(output.status.code(), Some(64));
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                result,
                failure(64, "preparation artifacts exceed the size limit")
            );
        }
        assert_eq!(fs::read(source).unwrap(), bytes);
        assert!(!fixture.root.join("native-invocations").exists());
    }
}

#[test]
fn requires_source_configuration_before_resolving_artifacts() {
    let fixture = RepositoryFixture::new();
    let source = fixture.root.join("sources/data.txt");
    fs::write(&source, b"prepared data\n").unwrap();
    declare(
        &fixture,
        vec![source_artifact(
            "generated-file",
            "738fb5667d1f1ac841e87be5a842e667ef9ff77e7f06f59141a7d59c4caa5d8f",
            "input-data",
        )],
    );
    let output = Command::new(env!("CARGO_BIN_EXE_sevro"))
        .current_dir(&fixture.root)
        .env("TMPDIR", fixture.root.join("tmp"))
        .env(
            "SEVRO_NATIVE_MARKER",
            fixture.root.join("native-invocations"),
        )
        .args([
            "run",
            "--json",
            "--dry",
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
        .args(artifact_arguments())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        failure(
            64,
            "preparation source root is required and must be absolute"
        )
    );
    assert_eq!(fs::read(source).unwrap(), b"prepared data\n");
    assert!(!fixture.root.join("native-invocations").exists());
}

#[test]
fn refuses_undeclared_source_references_before_retaining_artifacts() {
    let fixture = RepositoryFixture::new();
    let source = fixture.root.join("sources/data.txt");
    fs::write(&source, b"prepared data\n").unwrap();
    write_json(
        &fixture.root.join("source-map.json"),
        &json!({"other-data":url::Url::from_file_path(&source).unwrap().as_str()}),
    );
    declare(
        &fixture,
        vec![source_artifact(
            "generated-file",
            "738fb5667d1f1ac841e87be5a842e667ef9ff77e7f06f59141a7d59c4caa5d8f",
            "input-data",
        )],
    );
    let output = fixture.invoke_source(&artifact_arguments());
    assert_eq!(output.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        failure(64, "preparation source reference is not declared")
    );
    assert_eq!(fs::read(source).unwrap(), b"prepared data\n");
    assert!(!fixture.root.join("native-invocations").exists());
}
