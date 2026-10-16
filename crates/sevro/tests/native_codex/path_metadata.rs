use super::*;

#[test]
fn preserves_isolation_with_spaces_unicode_and_apostrophes_in_paths() {
    for label in ["space paths", "café 漢", "apostrophe's path"] {
        let mut fixture = Fixture::new();
        let relocated = fixture
            .root
            .with_file_name(format!("sevro-native-{label}-{}", Uuid::new_v4()));
        fs::rename(&fixture.root, &relocated).unwrap();
        fixture.root = relocated;
        let installed = fixture.root.join("binary/sevro");
        fs::copy(env!("CARGO_BIN_EXE_sevro"), &installed).unwrap();
        let script = native_script(&installed_codex(), &fixture.root).replace(
            "\"$peer/private-input\" || exit 92",
            &format!("\"$peer/private-input\" {} || exit 92", quote(&installed)),
        );
        fs::write(fixture.root.join("binary/codex-wrapper"), script).unwrap();
        let output = fixture.command_with(&installed).output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(0),
            "{label}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
        assert_eq!(
            fs::read(artifact_path(&evidence["trials"][0]["rawResult"]["path"])).unwrap(),
            b"ready"
        );
        assert_state_removed(&fixture);
        assert_eq!(
            fs::read_to_string(fixture.root.join("project/auth.json")).unwrap(),
            "FAKE_NATIVE_TEST_CREDENTIAL\n"
        );
    }
}

#[test]
fn rejects_corrupt_or_unreadable_git_metadata_in_separate_config_root() {
    for kind in ["corrupt", "unreadable"] {
        let fixture = Fixture::new();
        let config = fixture.root.join("protected-config");
        fs::create_dir(&config).unwrap();
        if kind == "corrupt" {
            fs::write(
                config.join(".git"),
                "gitdir: /missing-fixture-only-repository\n",
            )
            .unwrap();
        } else {
            fixture_git(&config, &["init", "--quiet"]);
            fs::set_permissions(config.join(".git/config"), fs::Permissions::from_mode(0o0))
                .unwrap();
        }
        require_no_native_launch(&fixture);
        let output = fixture
            .command()
            .arg("--config-root")
            .arg(&config)
            .output()
            .unwrap();
        if kind == "unreadable" {
            fs::set_permissions(
                config.join(".git/config"),
                fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
        assert_failed_turn(&output);
        assert!(!fixture.root.join("binary/launched").exists(), "{kind}");
    }
}

#[test]
fn tolerates_stale_worktree_registration_in_protected_config_repository() {
    let fixture = Fixture::new();
    let config = fixture.root.join("protected-config");
    fs::create_dir(&config).unwrap();
    fixture_git(&config, &["init", "--quiet"]);
    fs::write(config.join("README.md"), "public fixture source\n").unwrap();
    fixture_git(&config, &["add", "README.md"]);
    fixture_git(&config, &["commit", "--quiet", "-m", "fixture"]);
    let stale = fixture.root.join("stale linked ' café 漢");
    fixture_git(
        &config,
        &[
            "worktree",
            "add",
            "--quiet",
            "--detach",
            stale.to_str().unwrap(),
        ],
    );
    fs::remove_dir_all(&stale).unwrap();
    let listing = Command::new("git")
        .arg("-C")
        .arg(&config)
        .args(["worktree", "list", "--porcelain", "-z"])
        .output()
        .unwrap();
    assert!(listing.status.success());
    assert!(
        String::from_utf8(listing.stdout)
            .unwrap()
            .contains(stale.to_str().unwrap())
    );
    let output = fixture
        .command()
        .arg("--config-root")
        .arg(&config)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    assert_eq!(
        fs::read(artifact_path(&evidence["trials"][0]["rawResult"]["path"])).unwrap(),
        b"ready"
    );
    assert_state_removed(&fixture);
}
