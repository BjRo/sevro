mod claude;
mod codex;
mod isolation;
mod process;

pub(crate) use claude::{ClaudeHost, ClaudeOptions};
pub(crate) use codex::{CodexHost, CodexOptions};

pub(crate) enum NativeHost {
    Codex(CodexHost),
    Claude(ClaudeHost),
}

impl NativeHost {
    pub fn execute(
        &self,
        request: &crate::host::HostRequest<'_>,
        cancellation: &crate::cancellation::Cancellation,
    ) -> Result<crate::host::HostResult, String> {
        match self {
            Self::Codex(host) => host.execute(request, cancellation),
            Self::Claude(host) => host.execute(request, cancellation),
        }
    }
}
