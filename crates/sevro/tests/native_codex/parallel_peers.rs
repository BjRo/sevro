use super::*;
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

#[test]
fn concurrent_native_runs_keep_sibling_probe_peers_independent() {
    let first = Fixture::new();
    let second = Fixture::new();
    // Both public invocations use one real managed-workspace parent on either OS.
    let temporary = first.root.join("parallel-temporary");
    fs::create_dir(&temporary).unwrap();
    let mut first_run = Running::start(&first, &temporary);
    let first_admitted = first_run.admitted();
    let mut second_run = Running::start(&second, &temporary);
    let second_admitted = second_run.admitted();
    let first_peer = peer_receipt(&first);
    let second_peer = peer_receipt(&second);
    let peers_present = [&first_peer, &second_peer].map(|receipt| {
        receipt.as_ref().is_some_and(|(_, peer)| {
            fs::read_to_string(peer.join("private-input"))
                .is_ok_and(|bytes| bytes == "peer private input")
        })
    });
    first_run.release();
    second_run.release();
    let outputs = [first_run.finish(), second_run.finish()];
    for output in &outputs {
        cleanup_retained_workspace(output, &temporary);
    }
    for output in &outputs {
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert!(first_admitted && second_admitted);
    assert_eq!(peers_present, [true, true]);
    let (first_workspace, first_peer) = first_peer.unwrap();
    let (second_workspace, second_peer) = second_peer.unwrap();
    assert_eq!(first_workspace.parent(), second_workspace.parent());
    assert_ne!(first_workspace, second_workspace);
    assert_ne!(first_peer, second_peer);
    for (workspace, peer) in [
        (first_workspace, first_peer),
        (second_workspace, second_peer),
    ] {
        assert_eq!(workspace.parent(), peer.parent());
        assert!(!peer.starts_with(&workspace));
        assert!(!peer.exists(), "owned peer survived its wrapper");
        assert!(!workspace.exists(), "successful workspace survived cleanup");
    }
    for (fixture, output) in [(&first, &outputs[0]), (&second, &outputs[1])] {
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["execution"]["status"], "completed");
        let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
        let trial = &evidence["trials"][0];
        assert_eq!(
            fs::read(artifact_path(&trial["rawResult"]["path"])).unwrap(),
            b"ready"
        );
        assert_eq!(trial["usage"]["inputTokens"].as_f64(), Some(12.0));
        assert_eq!(trial["usage"]["outputTokens"].as_f64(), Some(4.0));
        assert_eq!(trial["artifactRefs"][0]["id"], "sevro.codex.events");
        assert_eq!(
            fs::read_to_string(fixture.root.join("project/auth.json")).unwrap(),
            "FAKE_NATIVE_TEST_CREDENTIAL\n"
        );
        assert_state_removed(fixture);
    }
}

struct Running {
    child: Option<Child>,
    ready: PathBuf,
    release: PathBuf,
}

impl Running {
    fn start(fixture: &Fixture, temporary: &Path) -> Self {
        let ready = fixture.root.join("binary/peer-ready");
        let release = fixture.root.join("binary/peer-release");
        let barrier = format!(
            "printf '%s\\n' \"$PWD\" \"$peer\" > {}\nwhile [ ! -f {} ]; do /bin/sleep 0.01; done",
            quote(&ready),
            quote(&release)
        );
        let script = native_script(&installed_codex(), &fixture.root).replace(
            "trap '/bin/rm -rf \"$peer\"' EXIT",
            &format!("trap '/bin/rm -rf \"$peer\"' EXIT\n{barrier}"),
        );
        fs::write(fixture.root.join("binary/codex-wrapper"), script).unwrap();
        let child = fixture
            .command()
            .env("TMPDIR", temporary)
            .args(["--codex-timeout-ms", "120000"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        Self {
            child: Some(child),
            ready,
            release,
        }
    }

    fn admitted(&mut self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(65);
        while Instant::now() < deadline {
            if fs::read_to_string(&self.ready).is_ok_and(|text| text.lines().count() == 2) {
                return true;
            }
            if self.child.as_mut().unwrap().try_wait().unwrap().is_some() {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }

    fn release(&self) {
        fs::write(&self.release, b"release").unwrap();
    }

    fn finish(mut self) -> Output {
        self.child.take().unwrap().wait_with_output().unwrap()
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = fs::write(&self.release, b"release");
        if let Some(mut child) = self.child.take() {
            // Signal only the CLI owned by this guard; its cancellation drains native groups.
            if child.try_wait().ok().flatten().is_none() {
                let _ = kill(
                    Pid::from_raw(i32::try_from(child.id()).unwrap()),
                    Signal::SIGTERM,
                );
            }
            let _ = child.wait();
        }
    }
}

fn peer_receipt(fixture: &Fixture) -> Option<(PathBuf, PathBuf)> {
    let text = fs::read_to_string(fixture.root.join("binary/peer-ready")).ok()?;
    let mut lines = text.lines();
    Some((PathBuf::from(lines.next()?), PathBuf::from(lines.next()?)))
}

fn cleanup_retained_workspace(output: &Output, temporary: &Path) {
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let workspaces = evidence["trials"][0]["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "sevro.observation.workspaces")
        .unwrap();
    let workspace = Path::new(workspaces["data"]["candidate"].as_str().unwrap());
    let parent = if cfg!(target_os = "linux") {
        PathBuf::from("/var/tmp/sevro-workspaces-private")
    } else {
        temporary.join("sevro-workspaces-private")
    };
    assert_eq!(workspace.parent(), Some(parent.as_path()));
    if output.status.code() != Some(0) && workspace.exists() {
        fs::remove_dir_all(workspace).unwrap();
    }
}
