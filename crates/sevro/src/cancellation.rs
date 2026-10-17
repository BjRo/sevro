use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::iterator::{Handle, Signals};
use std::sync::Arc;
use std::sync::atomic::{AtomicI32, Ordering};
use std::thread::{self, JoinHandle};

#[derive(Clone)]
pub(crate) struct Cancellation {
    signal: Arc<AtomicI32>,
}

impl Cancellation {
    pub fn signal(&self) -> Option<i32> {
        match self.signal.load(Ordering::Acquire) {
            0 => None,
            signal => Some(signal),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.signal().is_some()
    }
}

pub(crate) struct CommandCancellation {
    token: Cancellation,
    handle: Handle,
    listener: Option<JoinHandle<()>>,
}

impl CommandCancellation {
    pub fn register() -> Result<Self, String> {
        let mut signals = Signals::new([SIGINT, SIGTERM]).map_err(|error| error.to_string())?;
        let handle = signals.handle();
        let signal = Arc::new(AtomicI32::new(0));
        let observed = Arc::clone(&signal);
        let listener = thread::Builder::new()
            .name("sevro-signals".into())
            .spawn(move || {
                for signal in signals.forever() {
                    let _ =
                        observed.compare_exchange(0, signal, Ordering::AcqRel, Ordering::Acquire);
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            token: Cancellation { signal },
            handle,
            listener: Some(listener),
        })
    }

    pub fn token(&self) -> Cancellation {
        self.token.clone()
    }
}

impl Drop for CommandCancellation {
    fn drop(&mut self) {
        self.handle.close();
        if let Some(listener) = self.listener.take() {
            let _ = listener.join();
        }
    }
}
