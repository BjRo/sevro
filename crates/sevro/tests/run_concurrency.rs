use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("sevro-rust-concurrency-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir(root.join("calls")).unwrap();
        fs::write(root.join("case.json"), serde_json::to_vec(&json!({
            "id":"parallel", "prompt":"Return ready.",
            "fixture":{"files":{"marker":"original"}},
            "checks":[{"id":"answer","grader":"sevro.output","configuration":{"expectExact":"ready"}}],
            "requiredEvidence":[]
        })).unwrap()).unwrap();
        fs::write(root.join("adapter.ts"), format!(r#"
import {{ readFile, writeFile }} from 'node:fs/promises';
import {{ join }} from 'node:path';
const root = {};
let active = 0, peak = 0, ordinal = 0;
const width = Number(process.env.SEVRO_TEST_PARALLEL ?? '2');
const failure = process.env.SEVRO_TEST_FAILURE === 'yes';
let release;
const firstPair = new Promise(resolve => {{ release = resolve; }});
export default {{ id:'test.parallel', model:'synthetic', effort:'low',
  async run({{workspace, condition}}) {{
    const position = ++ordinal;
    active++;
    peak = Math.max(peak, active);
    if (active === width) release();
    await writeFile(join(root, 'calls', String(position)), workspace);
    const original = await readFile(join(workspace, 'marker'), 'utf8');
    await writeFile(join(workspace, 'marker'), String(position));
    if (position <= width) await Promise.race([firstPair, Bun.sleep(1000)]);
    await Bun.sleep(failure ? (position === 1 ? 5 : 100) : (position === 1 ? 50 : 5));
    active--;
    return {{finalMessage:'ready', complete:true, actualCondition:condition,
      executionFailed:failure && position === 1,
      failureMessage:failure && position !== 1 ? 'successful peer message' : undefined,
      artifacts:[{{id:'test.parallel.sample', bytes:new TextEncoder().encode(JSON.stringify({{position,peak,workspace,original}}))}}]}};
  }}
}};
"#, json!(root))).unwrap();
        Self { root }
    }

    fn command(&self, trials: u64) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_sevro"));
        command
            .current_dir(&self.root)
            .args([
                "run",
                "--json",
                "--case-file",
                "case.json",
                "--adapter-module",
                "adapter.ts",
                "--results-root",
                "results",
                "--runner-build-digest",
            ])
            .arg("a".repeat(64))
            .arg("--project-digest")
            .arg("b".repeat(64))
            .arg("--trials")
            .arg(trials.to_string())
            .env_remove("SEVRO_TEST_PARALLEL")
            .env_remove("SEVRO_TEST_FAILURE");
        command
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(calls) = fs::read_dir(self.root.join("calls")) {
            for call in calls.flatten() {
                if let Ok(workspace) = fs::read_to_string(call.path()) {
                    let _ = fs::remove_dir_all(workspace);
                }
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn result(output: Output, expected: i32) -> Value {
    assert_eq!(
        output.status.code(),
        Some(expected),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 1, "{stdout}");
    serde_json::from_str(&stdout).unwrap()
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn bounds_parallel_trials_and_retains_ordered_isolated_evidence() {
    let fixture = Fixture::new();
    let result = result(
        fixture.command(5).args(["--jobs", "2"]).output().unwrap(),
        0,
    );
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    let trials = evidence["trials"].as_array().unwrap();
    let samples: Vec<_> = trials
        .iter()
        .map(|trial| {
            let artifact = trial["artifactRefs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == "test.parallel.sample")
                .unwrap();
            read_json(
                &url::Url::parse(artifact["path"].as_str().unwrap())
                    .unwrap()
                    .to_file_path()
                    .unwrap(),
            )
        })
        .collect();
    assert_eq!(
        samples
            .iter()
            .map(|sample| sample["peak"].as_u64().unwrap())
            .max(),
        Some(2)
    );
    assert_eq!(
        samples
            .iter()
            .map(|sample| sample["position"].as_u64().unwrap())
            .collect::<HashSet<_>>(),
        HashSet::from([1, 2, 3, 4, 5])
    );
    assert_eq!(
        samples
            .iter()
            .map(|sample| sample["workspace"].as_str().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        5
    );
    for (trial, sample) in trials.iter().zip(samples) {
        let workspace = trial["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == "sevro.observation.workspaces")
            .unwrap();
        assert_eq!(sample["workspace"], workspace["data"]["candidate"]);
        assert_eq!(sample["original"], "original");
        assert!(!Path::new(sample["workspace"].as_str().unwrap()).exists());
    }
    assert_eq!(evidence["configuration"]["redacted"]["jobs"], 2);
    let checkpoint = read_json(
        &fixture
            .root
            .join("results")
            .join(result["runId"].as_str().unwrap())
            .join("checkpoint.json"),
    );
    for rows in [
        trials,
        result["cases"][0]["trials"].as_array().unwrap(),
        checkpoint["completedTrials"].as_array().unwrap(),
    ] {
        assert_eq!(
            rows.iter()
                .map(|row| row["trial"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5]
        );
    }
    for trial in result["cases"][0]["trials"].as_array().unwrap() {
        assert_eq!(
            read_json(Path::new(trial["artifactPath"].as_str().unwrap()))["result"],
            *trial
        );
    }
}

#[test]
fn defaults_to_three_workers_and_honors_serial_execution() {
    for jobs in [None, Some(1)] {
        let fixture = Fixture::new();
        let expected = jobs.unwrap_or(3);
        let mut command = fixture.command(4);
        if let Some(jobs) = jobs {
            command.args(["--jobs", &jobs.to_string()]);
        }
        command.env("SEVRO_TEST_PARALLEL", expected.to_string());
        let result = result(command.output().unwrap(), 0);
        let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
        let peak = evidence["trials"]
            .as_array()
            .unwrap()
            .iter()
            .map(|trial| {
                let artifact = trial["artifactRefs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["id"] == "test.parallel.sample")
                    .unwrap();
                read_json(
                    &url::Url::parse(artifact["path"].as_str().unwrap())
                        .unwrap()
                        .to_file_path()
                        .unwrap(),
                )["peak"]
                    .as_u64()
                    .unwrap()
            })
            .max();
        assert_eq!(peak, Some(expected));
        assert_eq!(evidence["configuration"]["redacted"]["jobs"], expected);
    }
}

#[test]
fn candidate_failure_stops_queued_trials_and_drains_active_peer() {
    let fixture = Fixture::new();
    let result = result(
        fixture
            .command(6)
            .args(["--jobs", "2"])
            .env("SEVRO_TEST_FAILURE", "yes")
            .output()
            .unwrap(),
        2,
    );
    assert_eq!(fs::read_dir(fixture.root.join("calls")).unwrap().count(), 2);
    assert_eq!(result["execution"]["status"], "failed");
    let summaries = result["cases"][0]["trials"].as_array().unwrap();
    assert_eq!(
        summaries
            .iter()
            .map(|row| row["trial"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        summaries
            .iter()
            .filter(|row| row["execution"]["status"] == "failed")
            .count(),
        1
    );
    assert_eq!(
        summaries
            .iter()
            .filter(|row| row["execution"]["status"] == "completed")
            .count(),
        1
    );
    let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
    assert_eq!(evidence["trials"].as_array().unwrap().len(), 2);
    let run = fixture
        .root
        .join("results")
        .join(result["runId"].as_str().unwrap());
    let active_path = fixture
        .root
        .join("results/active")
        .join(format!("{}.json", result["runId"].as_str().unwrap()));
    assert_eq!(read_json(&active_path)["status"], "complete");
    for path in [run.join("checkpoint.json"), active_path] {
        let state = read_json(&path);
        assert_eq!(
            state["completedTrials"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["trial"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }
    assert!(Path::new(&fs::read_to_string(fixture.root.join("calls/1")).unwrap()).exists());
    assert!(!Path::new(&fs::read_to_string(fixture.root.join("calls/2")).unwrap()).exists());
}

#[test]
fn successful_peer_message_cannot_replace_the_failed_trial_diagnostic() {
    // Worker admission order and adapter arrival order are independent. Exercise
    // several real admissions; the successful peer is never a diagnostic source.
    for _ in 0..4 {
        let fixture = Fixture::new();
        let result = result(
            fixture
                .command(2)
                .args(["--jobs", "2"])
                .env("SEVRO_TEST_FAILURE", "yes")
                .output()
                .unwrap(),
            2,
        );
        assert_eq!(
            result["diagnostic"]["message"],
            "host execution did not complete"
        );
    }
}

struct Running(Option<Child>);

impl Running {
    fn wait_for(&mut self, ready: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !ready() {
            assert!(Instant::now() < deadline, "CLI readiness timed out");
            assert!(
                self.0.as_mut().unwrap().try_wait().unwrap().is_none(),
                "CLI exited before readiness"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn finish(mut self) -> Output {
        let deadline = Instant::now() + Duration::from_secs(8);
        while self.0.as_mut().unwrap().try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "CLI drainage timed out");
            thread::sleep(Duration::from_millis(10));
        }
        self.0.take().unwrap().wait_with_output().unwrap()
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[test]
fn signals_cancel_every_active_call_and_drain_before_interrupted_finalization() {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;

    for signal in [Signal::SIGINT, Signal::SIGTERM] {
        let fixture = Fixture::new();
        fs::create_dir(fixture.root.join("stopped")).unwrap();
        fs::write(
            fixture.root.join("adapter.ts"),
            format!(
                r#"
import {{ writeFile }} from 'node:fs/promises';
import {{ join }} from 'node:path';
const root = {};
let ordinal = 0;
export default {{ id:'test.parallel.cancel', model:'synthetic', effort:'low',
  async run({{workspace, signal}}) {{
    const position = ++ordinal;
    const cancelled = new Promise((resolve) => {{
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', resolve, {{once:true}});
    }});
    await writeFile(join(root, 'calls', String(position)), workspace);
    await cancelled;
    await Bun.sleep(position === 1 ? 50 : 5);
    await writeFile(join(root, 'stopped', String(position)), signal.reason);
    return {{finalMessage:'partial', complete:false}};
  }}
}};
"#,
                json!(fixture.root)
            ),
        )
        .unwrap();
        let mut running = Running(Some(
            fixture
                .command(6)
                .args(["--jobs", "2"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        ));
        running.wait_for(|| fs::read_dir(fixture.root.join("calls")).unwrap().count() == 2);
        kill(
            Pid::from_raw(running.0.as_ref().unwrap().id().try_into().unwrap()),
            signal,
        )
        .unwrap();
        let result = result(running.finish(), 128 + signal as i32);
        assert_eq!(fs::read_dir(fixture.root.join("calls")).unwrap().count(), 2);
        assert_eq!(
            fs::read_dir(fixture.root.join("stopped")).unwrap().count(),
            2
        );
        for position in [1, 2] {
            assert_eq!(
                fs::read_to_string(fixture.root.join("stopped").join(position.to_string()))
                    .unwrap(),
                signal.as_str()
            );
            assert!(
                Path::new(
                    &fs::read_to_string(fixture.root.join("calls").join(position.to_string()))
                        .unwrap()
                )
                .join("marker")
                .exists()
            );
        }
        assert_eq!(result["execution"]["status"], "cancelled");
        let summaries = result["cases"][0]["trials"].as_array().unwrap();
        assert_eq!(
            summaries
                .iter()
                .map(|row| row["trial"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(
            summaries
                .iter()
                .all(|row| row["execution"]["status"] == "cancelled")
        );
        let active = read_json(
            &fixture
                .root
                .join("results/active")
                .join(format!("{}.json", result["runId"].as_str().unwrap())),
        );
        assert_eq!(active["status"], "interrupted");
        assert_eq!(
            active["completedTrials"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["trial"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        let evidence = read_json(Path::new(result["evidencePath"].as_str().unwrap()));
        for trial in evidence["trials"].as_array().unwrap() {
            let raw = url::Url::parse(trial["rawResult"]["path"].as_str().unwrap())
                .unwrap()
                .to_file_path()
                .unwrap();
            assert_eq!(fs::read_to_string(raw).unwrap(), "partial");
        }
    }
}

#[test]
fn persistence_failure_drains_peer_and_retains_only_unpersisted_workspace() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("adapter.ts"), format!(r#"
import {{ mkdir, readdir, readFile, writeFile }} from 'node:fs/promises';
import {{ join }} from 'node:path';
const root = {};
let ordinal = 0, release;
const pair = new Promise(resolve => {{ release = resolve; }});
export default {{ id:'test.parallel.persistence', model:'synthetic', effort:'low',
  async run({{workspace, condition}}) {{
    const position = ++ordinal;
    await writeFile(join(root, 'calls', String(position)), workspace);
    if (position === 2) release();
    await Promise.race([pair, Bun.sleep(1000)]);
    if (position === 1) {{
      const [name] = await readdir(join(root, 'results', 'active'));
      const active = JSON.parse(await readFile(join(root, 'results', 'active', name), 'utf8'));
      for (const trial of [1, 2]) await mkdir(join(active.evidenceDirectory, 'trial-' + trial + '-host-test.fault.bin'));
      return {{finalMessage:'ready',complete:true,actualCondition:condition,artifacts:[{{id:'test.fault',bytes:new Uint8Array([1])}}]}};
    }}
    await Bun.sleep(100);
    return {{finalMessage:'ready',complete:true,actualCondition:condition}};
  }}
}};
"#, json!(fixture.root))).unwrap();
    result(
        fixture.command(6).args(["--jobs", "2"]).output().unwrap(),
        70,
    );
    assert_eq!(fs::read_dir(fixture.root.join("calls")).unwrap().count(), 2);
    let active_path = fs::read_dir(fixture.root.join("results/active"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let active = read_json(&active_path);
    assert_eq!(active["status"], "diagnostic");
    let completed = active["completedTrials"].as_array().unwrap();
    assert_eq!(completed.len(), 1);
    let trial = read_json(Path::new(completed[0]["artifactPath"].as_str().unwrap()));
    assert_eq!(trial["result"]["task"]["verdict"], "passed");
    assert_eq!(
        read_json(Path::new(active["checkpointPath"].as_str().unwrap()))["completedTrials"],
        active["completedTrials"]
    );
    assert!(
        Path::new(&fs::read_to_string(fixture.root.join("calls/1")).unwrap())
            .join("marker")
            .exists()
    );
    assert!(!Path::new(&fs::read_to_string(fixture.root.join("calls/2")).unwrap()).exists());
}
