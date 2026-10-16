use super::AdapterExit;
use crate::cancellation::Cancellation;
use serde_json::{Value, json};
use signal_hook::consts::SIGINT;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::net::Shutdown;
use std::os::fd::OwnedFd;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

pub(super) enum CancellationPhase {
    Import,
    Execution,
}

pub(super) struct Transport {
    directory: PathBuf,
    child: Option<Child>,
    stream: BufReader<UnixStream>,
    stderr: StderrForwarder,
}

struct StderrForwarder {
    writer: UnixStream,
    reader: Option<thread::JoinHandle<io::Result<u64>>>,
}

impl StderrForwarder {
    fn start() -> Result<(Self, Stdio), String> {
        let (mut reader, writer) = UnixStream::pair().map_err(|error| error.to_string())?;
        let child = writer.try_clone().map_err(|error| error.to_string())?;
        let reader = thread::Builder::new()
            .name("sevro-adapter-stderr".into())
            .spawn(move || io::copy(&mut reader, &mut io::stderr()))
            .map_err(|error| format!("cannot forward adapter stderr: {error}"))?;
        Ok((
            Self {
                writer,
                reader: Some(reader),
            },
            Stdio::from(OwnedFd::from(child)),
        ))
    }

    fn finish(&mut self) -> Result<(), String> {
        if let Some(reader) = self.reader.take() {
            // End this private stream after reaping the bridge, even when an
            // adapter descendant still holds the inherited writing endpoint.
            // The reader drains queued bytes before EOF; memory stays bounded.
            let shutdown = self.writer.shutdown(Shutdown::Write);
            reader
                .join()
                .map_err(|_| "adapter stderr forwarding thread failed")?
                .map_err(|error| format!("cannot forward adapter stderr: {error}"))?;
            shutdown.map_err(|error| format!("cannot close adapter stderr: {error}"))?;
        }
        Ok(())
    }
}

impl Drop for StderrForwarder {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

impl Transport {
    pub fn start() -> Result<Self, String> {
        let directory = PathBuf::from("/tmp").join(format!("sevro-adapter-{}", Uuid::new_v4()));
        DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(|error| error.to_string())?;
        let result = Self::start_in(directory.clone());
        if result.is_err() {
            let _ = fs::remove_dir_all(directory);
        }
        result
    }

    fn start_in(directory: PathBuf) -> Result<Self, String> {
        let bridge = directory.join("host-adapter-bridge.ts");
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&bridge)
            .and_then(|mut file| {
                file.write_all(include_bytes!(
                    "../../../../src/compat/host-adapter-bridge.ts"
                ))
            })
            .map_err(|error| error.to_string())?;
        let socket = directory.join("bridge.sock");
        let listener = UnixListener::bind(&socket).map_err(|error| error.to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let (stderr, child_stderr) = StderrForwarder::start()?;
        let mut child = Command::new("bun")
            .arg(bridge)
            .arg(socket)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(child_stderr)
            .spawn()
            .map_err(|error| format!("cannot start TypeScript adapter bridge: {error}"))?;
        let stream = match Self::connect(&listener, &mut child) {
            Ok(stream) => stream,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        Ok(Self {
            directory,
            child: Some(child),
            stream: BufReader::new(stream),
            stderr,
        })
    }

    fn connect(listener: &UnixListener, child: &mut Child) -> Result<UnixStream, String> {
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream
                        .set_nonblocking(false)
                        .map_err(|error| error.to_string())?;
                    return Ok(stream);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error.to_string()),
            }
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                return Err(format!(
                    "TypeScript adapter bridge exited before connection: {status}"
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn exchange(&mut self, request: &Value) -> Result<Value, String> {
        Self::send(self.stream.get_mut(), request)?;
        self.receive()
    }

    pub fn exchange_cancelable(
        &mut self,
        request: &Value,
        cancellation: &Cancellation,
        phase: CancellationPhase,
    ) -> Result<Value, String> {
        Self::send(self.stream.get_mut(), request)?;
        let mut writer = self
            .stream
            .get_ref()
            .try_clone()
            .map_err(|error| error.to_string())?;
        let completed = AtomicBool::new(false);
        thread::scope(|scope| {
            let watcher = scope.spawn(|| {
                while !completed.load(Ordering::Acquire) {
                    if let Some(signal) = cancellation.signal() {
                        let reason = if signal == SIGINT {
                            "SIGINT"
                        } else {
                            "SIGTERM"
                        };
                        let interrupt = match phase {
                            CancellationPhase::Import => json!({
                                "method":"interrupt-import", "reason":reason,
                                "exitCode":128 + signal
                            }),
                            CancellationPhase::Execution => {
                                json!({"method":"abort", "reason":reason})
                            }
                        };
                        return Self::send(&mut writer, &interrupt);
                    }
                    thread::park_timeout(Duration::from_millis(10));
                }
                Ok(())
            });
            let result = self.receive();
            completed.store(true, Ordering::Release);
            watcher.thread().unpark();
            watcher
                .join()
                .map_err(|_| "adapter cancellation watcher failed")??;
            result
        })
    }

    fn send(stream: &mut UnixStream, request: &Value) -> Result<(), String> {
        serde_json::to_writer(&mut *stream, request).map_err(|error| error.to_string())?;
        stream.write_all(b"\n").map_err(|error| error.to_string())
    }

    fn receive(&mut self) -> Result<Value, String> {
        let mut line = String::new();
        self.stream
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        let response: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
        if let Some(error) = response.get("error") {
            return Err(format!("adapter failed: {error}"));
        }
        response
            .get("result")
            .cloned()
            .ok_or_else(|| "adapter bridge response has no result".into())
    }

    pub fn shutdown(&mut self) -> Result<Option<AdapterExit>, String> {
        if let Some(mut child) = self.child.take() {
            let response = self.exchange(&json!({"method":"shutdown"}));
            let status = child.wait().map_err(|error| error.to_string());
            let diagnostics = self.stderr.finish();
            let status = status?;
            response?;
            diagnostics?;
            return status
                .code()
                .map(|code| Some(AdapterExit { code }))
                .ok_or_else(|| format!("adapter bridge exited with {status}"));
        }
        Ok(None)
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        let _ = self.shutdown();
        let _ = fs::remove_dir_all(&self.directory);
    }
}
