use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output};
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("sevro-rust-source-map-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        for name in ["project", "sources", "home", "temporary"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        fs::write(
            root.join("project/case.json"),
            serde_json::to_vec(&json!({
                "id":"source-map-boundary","prompt":"Return ready.",
                "fixture":{"files":{"README.md":"fixture\n"}},
                "checks":[],"requiredEvidence":[]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(root.join("sources/input.txt"), "caller source bytes\n").unwrap();
        fs::write(
            root.join("native"),
            "#!/bin/sh\nprintf called > \"$0.called\"\nexit 97\n",
        )
        .unwrap();
        fs::set_permissions(root.join("native"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            root.join("credential.json"),
            "SYNTHETIC_SOURCE_MAP_CREDENTIAL\n",
        )
        .unwrap();
        Self { root }
    }

    fn invoke(&self) -> Output {
        Command::new(env!("CARGO_BIN_EXE_sevro"))
            .args([
                "run",
                "--json",
                "--case-file",
                "project/case.json",
                "--host",
                "claude",
                "--claude-bin",
                "./native",
                "--claude-credential-file",
                "credential.json",
                "--model",
                "synthetic",
                "--effort",
                "low",
                "--project-root",
                "project",
                "--results-root",
                "results",
                "--case-source-root",
                "sources",
                "--case-source-map-file",
                "source-map.json",
                "--runner-build-digest",
            ])
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64))
            .current_dir(&self.root)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("HOME", self.root.join("home"))
            .env("TMPDIR", self.root.join("temporary"))
            .output()
            .unwrap()
    }

    fn refuse(&self, message: &str) {
        let caller_files = [
            "project/case.json",
            "sources/input.txt",
            "native",
            "credential.json",
        ];
        let before: Vec<_> = caller_files
            .iter()
            .map(|name| fs::read(self.root.join(name)).unwrap())
            .collect();
        let output = self.invoke();
        assert_eq!(
            output.status.code(),
            Some(64),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).lines().count(), 1);
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            result,
            json!({
                "format":"sevro.cli-result.v1","runId":null,
                "execution":{"status":"not_run"},"grading":{"status":"not_requested"},
                "task":{"verdict":"not_assessed"},"exitCode":64,"evidencePath":null,
                "cases":[],"diagnostic":{"code":"sevro.invocation.invalid","message":message}
            })
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(
            stderr.lines().next(),
            Some(format!("sevro: {message}").as_str())
        );
        assert!(!self.root.join("native.called").exists());
        assert!(!self.root.join("results").exists());
        for (name, bytes) in caller_files.iter().zip(before) {
            assert_eq!(fs::read(self.root.join(name)).unwrap(), bytes);
        }
        for public in [&output.stdout, &output.stderr] {
            let public = String::from_utf8_lossy(public);
            assert!(!public.contains("PRIVATE_MAP_MARKER"));
            assert!(!public.contains("SYNTHETIC_SOURCE_MAP_CREDENTIAL"));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn refuses_malformed_source_map_json_before_execution() {
    let fixture = Fixture::new();
    let path = fixture.root.join("source-map.json");
    let contents = b"{\"PRIVATE_MAP_MARKER\":";
    fs::write(&path, contents).unwrap();
    fixture.refuse("case source map file is unreadable or invalid");
    assert_eq!(fs::read(path).unwrap(), contents);
}

#[test]
fn refuses_unreadable_source_maps_before_execution() {
    for directory in [false, true] {
        let fixture = Fixture::new();
        let path = fixture.root.join("source-map.json");
        if directory {
            fs::create_dir(&path).unwrap();
        }
        fixture.refuse("case source map file is unreadable or invalid");
        if directory {
            assert!(path.is_dir());
            assert_eq!(fs::read_dir(path).unwrap().count(), 0);
        } else {
            assert!(!path.exists());
        }
    }
}

#[test]
fn refuses_source_maps_without_string_file_urls_before_execution() {
    for value in [
        Value::Null,
        json!([]),
        json!({"reference":"https://example.com/source"}),
        json!({"reference":42}),
    ] {
        let fixture = Fixture::new();
        let path = fixture.root.join("source-map.json");
        let contents = serde_json::to_vec(&value).unwrap();
        fs::write(&path, &contents).unwrap();
        fixture.refuse("case source map must contain file URLs");
        assert_eq!(fs::read(path).unwrap(), contents);
    }
}
