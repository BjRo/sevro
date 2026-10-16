pub(super) use super::super::process::Output;
use super::super::process::{self, Flavor, Request};
use crate::cancellation::Cancellation;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

pub(super) fn run(
    binary: &Path,
    arguments: &[OsString],
    cwd: &Path,
    environment: &BTreeMap<OsString, OsString>,
    input: Option<&[u8]>,
    timeout: Duration,
    cancellation: &Cancellation,
) -> Result<Output, String> {
    process::run(
        Request {
            binary,
            arguments,
            cwd,
            environment,
            input,
            timeout,
            cancellation,
        },
        Flavor::Codex,
    )
}
