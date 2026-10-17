use super::AdapterExit;
use crate::cancellation::Cancellation;
use serde_json::{Value, json};
use signal_hook::consts::SIGINT;
use std::collections::HashMap;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::net::Shutdown;
use std::os::fd::OwnedFd;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
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
    writer: Mutex<UnixStream>,
    pending: Arc<Mutex<Pending>>,
    reader: Option<thread::JoinHandle<()>>,
    next_id: AtomicU64,
    stderr: StderrForwarder,
}

#[derive(Default)]
struct Pending {
    replies: HashMap<String, mpsc::Sender<Result<Value, String>>>,
    closed: Option<String>,
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
        let reader_stream = stream.try_clone().map_err(|error| error.to_string())?;
        let pending = Arc::new(Mutex::new(Pending::default()));
        let reader_pending = Arc::clone(&pending);
        let reader = match thread::Builder::new()
            .name("sevro-adapter-replies".into())
            .spawn(move || Self::receive(reader_stream, &reader_pending))
        {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("cannot receive adapter replies: {error}"));
            }
        };
        Ok(Self {
            directory,
            child: Some(child),
            writer: Mutex::new(stream),
            pending,
            reader: Some(reader),
            next_id: AtomicU64::new(1),
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

    pub fn exchange_cancelable(
        &self,
        request: &Value,
        cancellation: &Cancellation,
        phase: CancellationPhase,
    ) -> Result<Value, String> {
        self.exchange(request, Some((cancellation, phase)))
    }

    fn exchange(
        &self,
        request: &Value,
        cancellation: Option<(&Cancellation, CancellationPhase)>,
    ) -> Result<Value, String> {
        let id = format!("rust:{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self.pending.lock().map_err(|error| error.to_string())?;
            if let Some(error) = &pending.closed {
                return Err(error.clone());
            }
            pending.replies.insert(id.clone(), sender);
        }
        let mut request = request.clone();
        request["id"] = json!(id);
        let result = (|| {
            self.send(&request)?;
            let mut interrupted = false;
            loop {
                if !interrupted
                    && let Some((cancellation, phase)) = &cancellation
                    && let Some(signal) = cancellation.signal()
                {
                    let reason = if signal == SIGINT {
                        "SIGINT"
                    } else {
                        "SIGTERM"
                    };
                    let interrupt = match phase {
                        CancellationPhase::Import => json!({
                            "method":"interrupt-import", "id":id, "reason":reason,
                            "exitCode":128 + signal
                        }),
                        CancellationPhase::Execution => {
                            json!({"method":"abort", "id":id, "reason":reason})
                        }
                    };
                    self.send(&interrupt)?;
                    interrupted = true;
                }
                match receiver.recv_timeout(Duration::from_millis(10)) {
                    Ok(response) => return response,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err("adapter reply stream closed".into());
                    }
                }
            }
        })();
        self.pending
            .lock()
            .map_err(|error| error.to_string())?
            .replies
            .remove(&id);
        result
    }

    fn send(&self, request: &Value) -> Result<(), String> {
        let mut stream = self.writer.lock().map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut *stream, request).map_err(|error| error.to_string())?;
        stream.write_all(b"\n").map_err(|error| error.to_string())
    }

    fn receive(stream: UnixStream, pending: &Mutex<Pending>) {
        let mut reader = BufReader::new(stream);
        let error = loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break "adapter reply stream closed".to_owned(),
                Ok(_) => {}
                Err(error) => break error.to_string(),
            }
            let response: Value = match serde_json::from_str(&line) {
                Ok(response) => response,
                Err(error) => break error.to_string(),
            };
            let Some(id) = response["id"].as_str() else {
                break "adapter bridge response has no id".into();
            };
            let Ok(mut pending) = pending.lock() else {
                return;
            };
            let Some(sender) = pending.replies.remove(id) else {
                break "adapter bridge response has an unknown id".into();
            };
            let result = if let Some(error) = response.get("error") {
                Err(format!("adapter failed: {error}"))
            } else {
                response
                    .get("result")
                    .cloned()
                    .ok_or_else(|| "adapter bridge response has no result".into())
            };
            let _ = sender.send(result);
        };
        if let Ok(mut pending) = pending.lock() {
            pending.closed = Some(error.clone());
            for (_, sender) in pending.replies.drain() {
                let _ = sender.send(Err(error.clone()));
            }
        }
    }

    pub fn shutdown(&mut self) -> Result<Option<AdapterExit>, String> {
        if let Some(mut child) = self.child.take() {
            let response = self.exchange(&json!({"method":"shutdown"}), None);
            if response.is_err() {
                let _ = child.kill();
            }
            let status = child.wait().map_err(|error| error.to_string());
            if let Ok(writer) = self.writer.lock() {
                let _ = writer.shutdown(Shutdown::Both);
            }
            if let Some(reader) = self.reader.take() {
                let _ = reader.join();
            }
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
