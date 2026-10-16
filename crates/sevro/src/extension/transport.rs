use super::{Failure, Result};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use std::io::{Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES: usize = 64 * 1024;

pub(super) fn exchange_process(
    command: &[String],
    payload: &[u8],
    cancellation: &crate::cancellation::Cancellation,
) -> Result<Vec<u8>> {
    if cancellation.is_cancelled() {
        return Err(Failure::protocol("extension request cancelled"));
    }
    if payload.len() > MAX_MESSAGE_BYTES {
        return Err(Failure::protocol("extension request exceeds 8 MiB"));
    }
    let mut child = Command::new(&command[0])
        .args(&command[1..])
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| Failure::protocol("could not start extension process"))?;
    let mut stdin = child.stdin.take().expect("piped child stdin");
    let stdout = child.stdout.take().expect("piped child stdout");
    let stderr = child.stderr.take().expect("piped child stderr");
    std::thread::scope(|scope| {
        let (sender, receiver) = mpsc::channel();
        let writer = sender.clone();
        scope.spawn(move || {
            let result = stdin
                .write_all(payload)
                .map(|()| None)
                .map_err(transport_failure);
            let _ = writer.send(result);
        });
        let output = sender.clone();
        scope.spawn(move || {
            let _ = output.send(capture(stdout, MAX_MESSAGE_BYTES, false).map(Some));
        });
        scope.spawn(move || {
            let _ = sender.send(capture(stderr, MAX_DIAGNOSTIC_BYTES, true).map(|_| None));
        });
        collect_output(&mut child, receiver, cancellation)
    })
}

fn collect_output(
    child: &mut Child,
    receiver: mpsc::Receiver<Result<Option<Vec<u8>>>>,
    cancellation: &crate::cancellation::Cancellation,
) -> Result<Vec<u8>> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let interval = Duration::from_millis(10);
    let mut stdout = None;
    let mut failure = None;
    let mut streams_open = true;
    let mut status = None;
    while streams_open || status.is_none() {
        if streams_open {
            match receiver.recv_timeout(interval) {
                Ok(Ok(Some(bytes))) => stdout = Some(bytes),
                Ok(Ok(None)) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Ok(Err(error)) => {
                    if failure.is_none() {
                        failure = Some(error);
                        terminate(child);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => streams_open = false,
            }
        } else {
            std::thread::sleep(interval);
        }
        if failure.is_none() {
            let interruption = if cancellation.is_cancelled() {
                Some("extension request cancelled")
            } else if Instant::now() >= deadline {
                Some("extension timed out")
            } else {
                None
            };
            if let Some(message) = interruption {
                failure = Some(Failure::protocol(message));
                terminate(child);
            }
        }
        if status.is_none() {
            status = child.try_wait().map_err(transport_failure)?;
        }
    }
    if let Some(failure) = failure {
        return Err(failure);
    }
    let status = status.expect("owned extension process exited");
    if !status.success() {
        return Err(Failure::protocol(&format!(
            "extension exited with code {}",
            status.code().unwrap_or_else(|| 128
                + status
                    .signal()
                    .expect("exited Unix child has a signal or code"))
        )));
    }
    Ok(stdout.expect("stdout reader reports completion"))
}

fn terminate(child: &mut Child) {
    let _ = killpg(Pid::from_raw(child.id() as i32), Signal::SIGKILL);
    let _ = child.kill();
}

fn capture(mut reader: impl Read, limit: usize, truncate: bool) -> Result<Vec<u8>> {
    let mut retained = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let count = reader.read(&mut chunk).map_err(transport_failure)?;
        if count == 0 {
            return Ok(retained);
        }
        if !truncate && retained.len() + count > limit {
            return Err(Failure::protocol("extension message exceeds 8 MiB"));
        }
        retained.extend_from_slice(&chunk[..count.min(limit - retained.len())]);
    }
}

fn transport_failure(_: std::io::Error) -> Failure {
    Failure::protocol("extension transport failed")
}
