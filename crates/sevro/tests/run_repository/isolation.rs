use super::{git, write_json};
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;

const MARKER: &str = "OWNED_MAPPED_WORKTREE_MARKER\n";

struct MappedFixture {
    root: PathBuf,
    sources: [PathBuf; 3],
}

impl MappedFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("sevro-mapped-isolation-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        for name in ["primary", "source-cache", "peer", "project", "tmp"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        let sources = [
            root.join("primary"),
            root.join("source-cache/mapped"),
            root.join("peer/linked"),
        ];
        fs::write(sources[0].join("README.md"), MARKER).unwrap();
        git(&sources[0], &["init", "--quiet", "--initial-branch=main"]);
        git(&sources[0], &["add", "README.md"]);
        git(
            &sources[0],
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "Owned fixture",
            ],
        );
        for path in &sources[1..] {
            git(
                &sources[0],
                &[
                    "worktree",
                    "add",
                    "--quiet",
                    "--detach",
                    path.to_str().unwrap(),
                ],
            );
        }
        Self { root, sources }
    }

    fn prepare(&self) {
        let project = self.root.join("project");
        fs::write(project.join("auth.json"), "FAKE_MAPPED_WORKTREE_AUTH\n").unwrap();
        fs::set_permissions(project.join("auth.json"), fs::Permissions::from_mode(0o600)).unwrap();
        write_json(
            &project.join("case.json"),
            &json!({
                "id":"mapped-source-isolation", "prompt":"Probe owned source marker isolation.",
                "fixture":{"sourceRef":"fixture-repo"},
                "checks":[{"id":"private-sources","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
                "requiredEvidence":[]
            }),
        );
        write_json(
            &project.join("source-map.json"),
            &json!({"fixture-repo":url::Url::from_file_path(&self.sources[1]).unwrap().as_str()}),
        );
        let codex = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|directory| directory.join("codex"))
            .find(|path| path.is_file())
            .expect("native isolation requires the installed Codex CLI; run bun scripts/setup-ci-codex.ts");
        let binary = self.root.join("peer/codex-wrapper");
        fs::write(&binary, native_probe(&codex, &self.root, &self.sources)).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        if cfg!(target_os = "linux") {
            std::os::unix::fs::symlink(codex, self.root.join("peer/codex-linux-sandbox")).unwrap();
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_sevro"));
        command
            .current_dir(self.root.join("project"))
            .env("TMPDIR", self.root.join("tmp"))
            .env_remove("CODEX_HOME")
            .env_remove("CLAUDE_CONFIG_DIR")
            .args([
                "run",
                "--json",
                "--case-file",
                "case.json",
                "--host",
                "codex",
                "--codex-bin",
            ])
            .arg(self.root.join("peer/codex-wrapper"))
            .args([
                "--codex-auth-file",
                "auth.json",
                "--model",
                "synthetic-mapped-isolation",
                "--effort",
                "low",
                "--runner-build-digest",
            ])
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64))
            .arg("--case-source-root")
            .arg(self.root.join("source-cache"))
            .args(["--case-source-map-file", "source-map.json"]);
        command
    }
}

impl Drop for MappedFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\"'\"'"))
}

fn native_probe(codex: &Path, root: &Path, sources: &[PathBuf; 3]) -> String {
    r#"#!/bin/sh
if [ "$1" = --version ]; then printf 'synthetic-mapped-worktree-oracle\n'; exit 0; fi
if [ "$1" = sandbox ]; then shift; exec @CODEX@ sandbox "$@"; fi
if [ "$1" != exec ]; then exit 99; fi
/bin/cat >/dev/null
profile=$(/usr/bin/sed -n 's/^default_permissions = "\(.*\)"/\1/p' "$CODEX_HOME/config.toml")
test -n "$profile" || exit 92
@CODEX@ sandbox -P "$profile" -C "$PWD" /bin/sh -c '
  test "$(/bin/cat README.md)" = OWNED_MAPPED_WORKTREE_MARKER || exit 90
  printf "clone readable OWNED_MAPPED_WORKTREE_MARKER\n"
  for label in primary mapped sibling; do
    if value=$(/bin/cat "$1/README.md" 2>/dev/null); then
      printf "%s readable %s\n" "$label" "$value"
    else
      printf "%s denied\n" "$label"
    fi
    shift
  done
' owned-source-probe @PRIMARY@ @MAPPED@ @SIBLING@ > @LOG@ 2>&1
code=$?
printf '%s\n' "$code" >> @LOG@
test "$code" = 0 || exit 93
if /usr/bin/grep -E '^(primary|mapped|sibling) readable ' @LOG@ >/dev/null; then
  text=source-marker-readable
else
  text=ready
fi
printf '%s\n' '{"type":"thread.started","thread_id":"mapped-worktree-oracle"}'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\n' "$text"
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
"#
    .replace("@CODEX@", &quote(codex))
    .replace("@PRIMARY@", &quote(&sources[0]))
    .replace("@MAPPED@", &quote(&sources[1]))
    .replace("@SIBLING@", &quote(&sources[2]))
    .replace("@LOG@", &quote(&root.join("peer/probe.txt")))
}

#[test]
fn protects_mapped_repository_linked_worktrees_from_native_commands() {
    let fixture = MappedFixture::new();
    fixture.prepare();
    let revision = git(&fixture.sources[0], &["rev-parse", "HEAD"]);
    let output = fixture.command().output().unwrap();
    let probe = fs::read_to_string(fixture.root.join("peer/probe.txt")).unwrap();
    for source in &fixture.sources {
        assert_eq!(
            fs::read_to_string(source.join("README.md")).unwrap(),
            MARKER
        );
        assert_eq!(git(source, &["status", "--porcelain=v1"]), "");
        assert_eq!(git(source, &["rev-parse", "HEAD"]), revision);
    }
    assert_eq!(
        output.status.code(),
        Some(0),
        "native source probe:\n{probe}\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        probe,
        "clone readable OWNED_MAPPED_WORKTREE_MARKER\nprimary denied\nmapped denied\nsibling denied\n0\n"
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["execution"]["status"], "completed");
    assert_eq!(result["grading"]["status"], "completed");
    assert_eq!(result["task"]["verdict"], "passed");
}
