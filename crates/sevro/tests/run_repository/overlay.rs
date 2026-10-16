use super::{RepositoryFixture, boundaries::failure, git, write_json};
use serde_json::{Value, json};
use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::PathBuf;
use uuid::Uuid;

#[test]
fn creates_nested_repository_overlay_paths_before_setup() {
    let fixture = RepositoryFixture::new();
    fixture.extension(
        json!({"kind":"repository","sourceRef":"fixture-repo","files":{
            "README.md":"replacement\n","new/deep/note.txt":"nested overlay\n"
        }}),
        json!({"artifacts":[],"requestedInstrumentation":[],"extensionData":{},
            "fixtureSetup":{"command":["/bin/sh","-c",r#"set -eu
printf 'replacement\n' | cmp - README.md
printf 'nested overlay\n' | cmp - new/deep/note.txt
git show HEAD:README.md | cmp - "$PROJECT_ROOT/sources/example/README.md"
[ ! -e "$PROJECT_ROOT/sources/example/new" ]
"#],"environment":{"PROJECT_ROOT":"{{sevro.project}}"}}
        }),
        json!(["sevro.fixture.setup"]),
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
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        "5c3a4f327a536468be51ac1787b8d68b107874576157c93059cbc2ef865fea7c"
    );
    assert_eq!(
        evidence["configuration"]["redacted"]["fixtureSetupDigest"],
        "dfbbde8d7e6ec04ad1ff0e46c794905b9ec7bebbe90912d978bde41d5a681eb9"
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
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "repository fixture\n"
    );
    assert!(!fixture.source.join("new").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert!(!fixture.root.join("native-invocations").exists());
}

#[test]
fn stages_only_declared_repository_overlay_paths_before_setup() {
    let fixture = RepositoryFixture::new();
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    let source_index = fs::read(fixture.source.join(".git/index")).unwrap();
    let source_reference = fs::read(fixture.source.join(".git/refs/heads/main")).unwrap();
    fixture.setup_extension_with_fixture(
        r#"set -eu
printf 'overlay fixture\n' | cmp - README.md
printf 'untracked\n' | cmp - notes.txt
git show HEAD:README.md | cmp - "$PROJECT_ROOT/sources/example/README.md"
git show :README.md | cmp - README.md
[ "$(git diff --cached --name-only)" = README.md ]
[ "$(git status --porcelain=v1)" = "M  README.md
?? notes.txt" ]
[ "$(git rev-parse HEAD)" = f4d351b20b90e67f9e9092777856c0135110b023 ]
[ -z "$(git remote)" ]
[ "$WORKSPACE" = "$PWD" ]
printf 'staged overlay verified\n' > "$PROJECT_ROOT/setup-receipt.txt"
"#,
        json!({"kind":"repository","sourceRef":"fixture-repo","files":{
            "README.md":"overlay fixture\n","notes.txt":"untracked\n"
        },"staged":["README.md"]}),
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
        Some(0),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
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
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        "83766ddec51223bf5ed90edc7d85eb4e75a11eaefaf184efa7fe9e3909b5432d"
    );
    assert_eq!(
        evidence["configuration"]["redacted"]["fixtureSetupDigest"],
        "8a5f024beadc50f1e19844df760cf8c329a53e3e0761028874de836b50850c40"
    );
    assert_eq!(
        fs::read(fixture.root.join("setup-receipt.txt")).unwrap(),
        b"staged overlay verified\n"
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
        fs::read(fixture.source.join("README.md")).unwrap(),
        b"repository fixture\n"
    );
    assert!(!fixture.source.join("notes.txt").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert_eq!(
        git(&fixture.source, &["rev-parse", "HEAD"]),
        "f4d351b20b90e67f9e9092777856c0135110b023"
    );
    assert_eq!(
        fs::read(fixture.source.join(".git/index")).unwrap(),
        source_index
    );
    assert_eq!(
        fs::read(fixture.source.join(".git/refs/heads/main")).unwrap(),
        source_reference
    );
}

#[test]
fn refuses_staging_a_repository_path_outside_the_declared_overlay() {
    let fixture = RepositoryFixture::new();
    fixture.extension(
        json!({"kind":"repository","sourceRef":"fixture-repo","files":{
            "notes.txt":"untracked\n"
        },"staged":["README.md"]}),
        json!({"artifacts":[],"requestedInstrumentation":[],"extensionData":{}}),
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
        Some(64),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        failure(
            64,
            "invalid resolved case file: fixture: invalid repository fixture staging; correct the fixture declaration"
        )
    );
    assert!(!fixture.root.join(".sevro").exists());
    assert!(!fixture.root.join("native-invocations").exists());
    assert_eq!(
        fs::read(fixture.source.join("README.md")).unwrap(),
        b"repository fixture\n"
    );
    assert!(!fixture.source.join("notes.txt").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert_eq!(
        git(&fixture.source, &["rev-parse", "HEAD"]),
        "f4d351b20b90e67f9e9092777856c0135110b023"
    );
}

#[test]
fn refuses_duplicate_repository_staging_paths() {
    let fixture = RepositoryFixture::new();
    let case_file = fixture.root.join("case.json");
    write_json(
        &case_file,
        &json!({
            "id":"repository-staging","prompt":"Return ready.",
            "fixture":{"sourceRef":"fixture-repo","files":{"README.md":"overlay fixture\n"},
                "staged":["README.md","README.md"]},
            "checks":[],"requiredEvidence":[]
        }),
    );
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
                "resolved case file is unreadable or invalid at {}: invalid resolved case file: fixture: invalid repository fixture staging; correct the fixture declaration; supply --case-file with readable JSON and correct the named field",
                case_file.display()
            )
        )
    );
    assert!(!fixture.root.join(".sevro").exists());
    assert!(!fixture.root.join("native-invocations").exists());
    assert_eq!(
        fs::read(fixture.source.join("README.md")).unwrap(),
        b"repository fixture\n"
    );
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
}

#[test]
fn refuses_a_present_null_repository_staging_declaration() {
    let fixture = RepositoryFixture::new();
    let case_file = fixture.root.join("case.json");
    write_json(
        &case_file,
        &json!({
            "id":"repository-staging","prompt":"Return ready.",
            "fixture":{"sourceRef":"fixture-repo","files":{"README.md":"overlay fixture\n"},
                "staged":null},
            "checks":[],"requiredEvidence":[]
        }),
    );
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
                "resolved case file is unreadable or invalid at {}: invalid resolved case file: fixture: invalid repository fixture; correct the fixture declaration; supply --case-file with readable JSON and correct the named field",
                case_file.display()
            )
        )
    );
    assert!(!fixture.root.join(".sevro").exists());
    assert!(!fixture.root.join("native-invocations").exists());
    assert_eq!(
        fs::read(fixture.source.join("README.md")).unwrap(),
        b"repository fixture\n"
    );
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
}

#[test]
fn counts_staged_utf8_path_bytes_toward_the_repository_overlay_limit() {
    for (content_bytes, expected_exit) in [(33_554_408, 0), (33_554_409, 64)] {
        let fixture = RepositoryFixture::new();
        let case_file = fixture.root.join("case.json");
        write_json(
            &case_file,
            &json!({
                "id":"repository-staging-bound","prompt":"Return ready.",
                "fixture":{"sourceRef":"fixture-repo","files":{
                    "données.txt":"x".repeat(content_bytes)
                },"staged":["données.txt"]},
                "checks":[],"requiredEvidence":[]
            }),
        );
        let output = fixture.invoke();
        assert_eq!(
            output.status.code(),
            Some(expected_exit),
            "{content_bytes}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        if expected_exit == 0 {
            assert_eq!(result["execution"], json!({"status":"not_run"}));
            assert_eq!(result["grading"], json!({"status":"not_requested"}));
            assert_eq!(result["task"], json!({"verdict":"not_assessed"}));
            let evidence: Value = serde_json::from_slice(
                &fs::read(result["evidencePath"].as_str().unwrap()).unwrap(),
            )
            .unwrap();
            assert_eq!(evidence["result"], result);
            assert_eq!(
                evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
                "9ea657ac1fa467650a1b47d466b5414db650270bdb2393be0bd0520528ec5292"
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
        } else {
            assert_eq!(
                result,
                failure(
                    64,
                    &format!(
                        "resolved case file is unreadable or invalid at {}: invalid resolved case file: fixture: repository fixture exceeds the size limit; correct the fixture declaration; supply --case-file with readable JSON and correct the named field",
                        case_file.display()
                    )
                )
            );
            assert!(!fixture.root.join(".sevro").exists());
        }
        assert!(!fixture.root.join("native-invocations").exists());
        assert_eq!(
            fs::read(fixture.source.join("README.md")).unwrap(),
            b"repository fixture\n"
        );
        assert!(!fixture.source.join("données.txt").exists());
        assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    }
}

#[test]
fn accepts_repository_overlay_at_the_exact_utf8_byte_limit() {
    let fixture = RepositoryFixture::new();
    write_json(
        &fixture.root.join("case.json"),
        &json!({
            "id":"repository-overlay-bound","prompt":"Return ready.",
            "fixture":{"sourceRef":"fixture-repo","files":{
                "données.txt":"x".repeat(33_554_420)
            }},
            "checks":[],"requiredEvidence":[]
        }),
    );
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
        evidence["evaluationIdentity"]["dimensions"]["fixtureDigest"],
        "749324f55f7497b8d2b2229ad3eaa21dd96478bc47359fd78eb647621bf8f338"
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
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "repository fixture\n"
    );
    assert!(!fixture.source.join("données.txt").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert!(!fixture.root.join("native-invocations").exists());
}

#[test]
fn rejects_the_next_overlay_byte_including_utf8_path_bytes() {
    let fixture = RepositoryFixture::new();
    let case_file = fixture.root.join("case.json");
    write_json(
        &case_file,
        &json!({
            "id":"repository-overlay-bound","prompt":"Return ready.",
            "fixture":{"sourceRef":"fixture-repo","files":{
                "données.txt":"x".repeat(33_554_421)
            }},
            "checks":[],"requiredEvidence":[]
        }),
    );
    let output = fixture.invoke();
    assert_eq!(output.status.code(), Some(64));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        failure(
            64,
            &format!(
                "resolved case file is unreadable or invalid at {}: invalid resolved case file: fixture: repository fixture exceeds the size limit; correct the fixture declaration; supply --case-file with readable JSON and correct the named field",
                case_file.display()
            )
        )
    );
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "repository fixture\n"
    );
    assert!(!fixture.source.join("données.txt").exists());
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert!(!fixture.root.join("native-invocations").exists());
}

#[test]
fn refuses_an_existing_directory_as_the_final_overlay_target() {
    let fixture = RepositoryFixture::new();
    let name = format!("kept-{}.txt", Uuid::new_v4());
    let sentinel = format!("preserve directory owned by {}\n", Uuid::new_v4());
    let directory = fixture.source.join("occupied");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join(&name), &sentinel).unwrap();
    git(&fixture.source, &["add", &format!("occupied/{name}")]);
    git(
        &fixture.source,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "Add occupied directory",
        ],
    );
    let revision = git(&fixture.source, &["rev-parse", "HEAD"]);
    let _cleanup = RetainedOverlayWorkspace {
        namespace: if cfg!(target_os = "linux") {
            PathBuf::from("/var/tmp/sevro-workspaces-private")
        } else {
            fixture.root.join("tmp/sevro-workspaces-private")
        },
        name: name.clone(),
        sentinel: sentinel.clone(),
        owner: fs::metadata(&fixture.root).unwrap().uid(),
    };
    write_json(
        &fixture.root.join("case.json"),
        &json!({
            "id":"repository-overlay-directory","prompt":"Return ready.",
            "fixture":{"sourceRef":"fixture-repo","files":{
                "occupied":"must not replace a directory\n"
            }},
            "checks":[],"requiredEvidence":[]
        }),
    );
    let output = fixture.invoke();
    assert_eq!(output.status.code(), Some(70));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        failure(70, "repository fixture overlay targets a non-file")
    );
    assert!(fs::symlink_metadata(&directory).unwrap().is_dir());
    assert_eq!(fs::read_to_string(directory.join(name)).unwrap(), sentinel);
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
    assert_eq!(
        fs::read_to_string(fixture.source.join("README.md")).unwrap(),
        "repository fixture\n"
    );
    assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
    assert_eq!(git(&fixture.source, &["rev-parse", "HEAD"]), revision);
    assert!(!fixture.root.join("native-invocations").exists());
}

// Cleanup only: failed materialization does not yet publish its reserved workspace.
// Acceptance assertions above use the public result and the declared source.
struct RetainedOverlayWorkspace {
    namespace: PathBuf,
    name: String,
    sentinel: String,
    owner: u32,
}

impl Drop for RetainedOverlayWorkspace {
    fn drop(&mut self) {
        let Ok(namespace) = fs::symlink_metadata(&self.namespace) else {
            return;
        };
        if !namespace.is_dir() || namespace.uid() != self.owner || namespace.mode() & 0o077 != 0 {
            return;
        }
        let Ok(entries) = fs::read_dir(&self.namespace) else {
            return;
        };
        for entry in entries.flatten() {
            let workspace = entry.path();
            let owned_directory = |path: &std::path::Path| {
                fs::symlink_metadata(path)
                    .is_ok_and(|metadata| metadata.is_dir() && metadata.uid() == self.owner)
            };
            if !owned_directory(&workspace) || !owned_directory(&workspace.join("occupied")) {
                continue;
            }
            let Ok(file) = fs::OpenOptions::new()
                .read(true)
                .custom_flags(nix::libc::O_NOFOLLOW)
                .open(workspace.join("occupied").join(&self.name))
            else {
                continue;
            };
            if !file.metadata().is_ok_and(|metadata| {
                metadata.is_file()
                    && metadata.uid() == self.owner
                    && metadata.len() == self.sentinel.len() as u64
            }) {
                continue;
            }
            let mut content = String::new();
            if file
                .take(self.sentinel.len() as u64 + 1)
                .read_to_string(&mut content)
                .is_ok()
                && content == self.sentinel
            {
                let _ = fs::remove_dir_all(workspace);
                break;
            }
        }
    }
}

#[test]
fn rejects_unsafe_colliding_or_excessive_overlay_paths() {
    let mut cases = vec![
        (
            json!({".GiT/config":""}),
            "repository fixture cannot write repository metadata",
        ),
        (json!({"":""}), "invalid fixture path: "),
        (json!({"a\\b":""}), "invalid fixture path: a\\b"),
        (json!({"C:bad":""}), "invalid fixture path: C:bad"),
        (json!({"/absolute":""}), "invalid fixture path: /absolute"),
        (json!({"a//b":""}), "invalid fixture path: a//b"),
        (json!({"a/./b":""}), "invalid fixture path: a/./b"),
        (json!({"a/../b":""}), "invalid fixture path: a/../b"),
        (
            json!({"README.md":"a","readme.md":"b"}),
            "repository fixture overlay paths collide",
        ),
        (
            json!({"a":"a","a/b":"b"}),
            "repository fixture overlay paths collide",
        ),
        (
            json!({"A/b":"b","a":"a"}),
            "repository fixture overlay paths collide",
        ),
    ];
    cases.push((
        Value::Object(
            (0..1025)
                .map(|index| (format!("file-{index}"), json!("")))
                .collect(),
        ),
        "repository fixture exceeds the file limit",
    ));
    for (files, detail) in cases {
        let fixture = RepositoryFixture::new();
        fixture.extension(
            json!({"kind":"repository","sourceRef":"fixture-repo","files":files}),
            json!({"artifacts":[],"requestedInstrumentation":[],"extensionData":{}}),
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
        assert_eq!(output.status.code(), Some(64), "{detail}");
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            result,
            failure(
                64,
                &format!(
                    "invalid resolved case file: fixture: {detail}; correct the fixture declaration"
                )
            )
        );
        assert_eq!(
            fs::read_to_string(fixture.source.join("README.md")).unwrap(),
            "repository fixture\n"
        );
        assert_eq!(git(&fixture.source, &["status", "--porcelain=v1"]), "");
        assert!(!fixture.root.join("native-invocations").exists());
    }
}
