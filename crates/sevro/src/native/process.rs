use crate::cancellation::Cancellation;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{Receiver, TryRecvError, channel};
use std::thread;
use std::time::{Duration, Instant};

pub(super) struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stderr_truncated: bool,
    pub duration_ms: f64,
    pub reason: &'static str,
}

struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
}

struct OwnedProcess {
    child: Child,
    terminated: bool,
}

impl OwnedProcess {
    fn terminate(&mut self) {
        if self.terminated {
            return;
        }
        if let Ok(pid) = i32::try_from(self.child.id()) {
            let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
        }
        let _ = self.child.kill();
        self.terminated = true;
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.terminate();
        let _ = self.child.wait();
    }
}

pub(super) struct Request<'a> {
    pub binary: &'a Path,
    pub arguments: &'a [OsString],
    pub cwd: &'a Path,
    pub environment: &'a BTreeMap<OsString, OsString>,
    pub input: Option<&'a [u8]>,
    pub timeout: Duration,
    pub cancellation: &'a Cancellation,
}

#[derive(Clone, Copy)]
pub(super) enum Flavor {
    Codex,
    Claude,
}

impl Flavor {
    fn name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude",
        }
    }
    fn overflow(self) -> &'static str {
        match self {
            Self::Codex => "Codex event stream exceeds the size limit",
            Self::Claude => "Claude process output exceeds its limit",
        }
    }
}

// Temporary, explicitly opted-in CI diagnosis; remove after the Ubuntu failure is identified.
#[cfg(debug_assertions)]
fn diagnostic_enabled() -> bool {
    std::env::var_os("SEVRO_DEBUG_NATIVE_DIAGNOSTICS").as_deref() == Some(std::ffi::OsStr::new("1"))
}

#[cfg(debug_assertions)]
pub(super) fn diagnostic_stage(stage: &'static str) {
    if diagnostic_enabled() {
        let _ = writeln!(std::io::stderr(), "sevro native diagnostic stage={stage}");
    }
}

#[cfg(not(debug_assertions))]
pub(super) fn diagnostic_stage(_stage: &'static str) {}

pub(super) fn run(request: Request<'_>, flavor: Flavor) -> Result<Output, String> {
    let Request {
        binary,
        arguments,
        cwd,
        environment,
        input,
        timeout,
        cancellation,
    } = request;
    let host = flavor.name();
    if cancellation.is_cancelled() {
        return Err(format!("{host} run cancelled"));
    }
    let child = Command::new(binary)
        .args(arguments)
        .current_dir(cwd)
        .env_clear()
        .envs(environment)
        .process_group(0)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .inspect_err(|_error| {
            #[cfg(debug_assertions)]
            if matches!(flavor, Flavor::Codex) && diagnostic_enabled() {
                let _ = writeln!(
                    std::io::stderr(),
                    "sevro native diagnostic stage=spawn kind={:?} raw_os_error={:?}",
                    _error.kind(),
                    _error.raw_os_error()
                );
            }
        })
        .map_err(|_| format!("{host} process could not start"))?;
    let mut process = OwnedProcess {
        child,
        terminated: false,
    };
    let stdout = capture(
        process
            .child
            .stdout
            .take()
            .ok_or_else(|| format!("{host} stdout unavailable"))?,
        8 * 1024 * 1024,
        true,
        flavor,
    );
    let stderr = capture(
        process
            .child
            .stderr
            .take()
            .ok_or_else(|| format!("{host} stderr unavailable"))?,
        64 * 1024,
        matches!(flavor, Flavor::Claude),
        flavor,
    );
    let writer = write_input(process.child.stdin.take(), input.map(Vec::from), host);
    let started = Instant::now();
    let deadline = started + timeout;
    let mut out = None;
    let mut err = None;
    let mut written = false;
    let mut reason = "exit";
    loop {
        receive(&stdout, &mut out, host)?;
        receive(&stderr, &mut err, host)?;
        if !written {
            match writer.try_recv() {
                Ok(result) => {
                    result?;
                    written = true;
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    return Err(format!("{host} input worker ended unexpectedly"));
                }
            }
        }
        if let Some(status) = process
            .child
            .try_wait()
            .map_err(|_| format!("{host} process could not be awaited"))?
            && out.is_some()
            && err.is_some()
            && written
        {
            let stdout = out
                .take()
                .ok_or_else(|| format!("{host} output unavailable"))?;
            let stderr = err
                .take()
                .ok_or_else(|| format!("{host} stderr unavailable"))?;
            return Ok(Output {
                status,
                stdout: stdout.bytes,
                stderr: stderr.bytes,
                stderr_truncated: stderr.truncated,
                duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                reason,
            });
        }
        if reason == "exit" && cancellation.is_cancelled() {
            process.terminate();
            reason = "cancelled";
        } else if reason == "exit" && Instant::now() >= deadline {
            process.terminate();
            reason = "timeout";
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn write_input(
    mut stdin: Option<std::process::ChildStdin>,
    input: Option<Vec<u8>>,
    host: &'static str,
) -> Receiver<Result<(), String>> {
    let (sender, receiver) = channel();
    thread::spawn(move || {
        let result = match (stdin.as_mut(), input) {
            (Some(pipe), Some(bytes)) => pipe
                .write_all(&bytes)
                .map_err(|_| format!("{host} prompt could not be written")),
            _ => Ok(()),
        };
        drop(stdin);
        let _ = sender.send(result);
    });
    receiver
}

fn receive(
    receiver: &Receiver<Result<Capture, String>>,
    value: &mut Option<Capture>,
    host: &'static str,
) -> Result<(), String> {
    if value.is_some() {
        return Ok(());
    }
    match receiver.try_recv() {
        Ok(result) => {
            *value = Some(result?);
            Ok(())
        }
        Err(TryRecvError::Empty) => Ok(()),
        Err(TryRecvError::Disconnected) => Err(format!("{host} output worker ended unexpectedly")),
    }
}

fn capture(
    mut stream: impl Read + Send + 'static,
    limit: usize,
    reject: bool,
    flavor: Flavor,
) -> Receiver<Result<Capture, String>> {
    let (sender, receiver) = channel();
    let host = flavor.name();
    thread::spawn(move || {
        let result = (|| {
            let mut bytes = Vec::new();
            let mut truncated = false;
            let mut buffer = [0; 8192];
            loop {
                let count = stream
                    .read(&mut buffer)
                    .map_err(|_| format!("{host} output could not be read"))?;
                if count == 0 {
                    return Ok(Capture { bytes, truncated });
                }
                let retained = count.min(limit.saturating_sub(bytes.len()));
                if reject && retained != count {
                    return Err(flavor.overflow().into());
                }
                truncated |= retained != count;
                bytes.extend_from_slice(&buffer[..retained]);
            }
        })();
        let _ = sender.send(result);
    });
    receiver
}
