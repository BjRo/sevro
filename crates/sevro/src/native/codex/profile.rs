use super::{runtime::EmptyRuntime, state::State};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub(super) fn configuration(
    state: &State,
    workspace: &Path,
    protected: &[PathBuf],
    executable_roots: &[PathBuf],
) -> Result<String, String> {
    let mut lines = vec![
        format!("default_permissions = \"{}\"", state.profile_id),
        "approval_policy = \"never\"".into(),
        "allow_login_shell = false".into(),
        "[features]".into(),
        "hooks = false".into(),
        "[shell_environment_policy]".into(),
        "inherit = \"none\"".into(),
        "ignore_default_excludes = false".into(),
        "[shell_environment_policy.set]".into(),
        format!("PATH = {}", quoted(&command_path(executable_roots)?)?),
        format!("HOME = {}", path(&state.command_home)?),
        format!("TMPDIR = {}", path(&state.command_temp)?),
        format!(
            "TMPPREFIX = {}",
            quoted(&format!(
                "{}/",
                state
                    .command_temp
                    .to_str()
                    .ok_or("Codex temporary path is not UTF-8")?
            ))?
        ),
    ];
    if state.runtime.is_some() {
        for (name, value) in EmptyRuntime::ENVIRONMENT {
            lines.push(format!("{} = {}", quoted(name)?, quoted(value)?));
        }
    }
    lines.extend([
        format!("[permissions.{}]", state.profile_id),
        "extends = \":workspace\"".into(),
        format!("[permissions.{}.filesystem]", state.profile_id),
        "\":root\" = \"deny\"".into(),
        "\":minimal\" = \"read\"".into(),
    ]);
    #[cfg(target_os = "macos")]
    {
        lines.extend([
            "\":tmpdir\" = \"deny\"".into(),
            "\":slash_tmp\" = \"deny\"".into(),
        ]);
    }
    let denied = effective_denials(state, workspace, protected);
    for root in &denied {
        if !denied
            .iter()
            .any(|other| other != root && root.starts_with(other))
        {
            lines.push(format!("{} = \"deny\"", path(root)?));
        }
    }
    for root in executable_roots.iter().collect::<BTreeSet<_>>() {
        lines.push(format!("{} = \"read\"", path(root)?));
    }
    for root in [
        &state.command_home,
        &state.command_temp,
        &workspace.join(".git"),
    ] {
        lines.push(format!("{} = \"write\"", path(root)?));
    }
    lines.extend([
        format!(
            "[permissions.{}.filesystem.\":workspace_roots\"]",
            state.profile_id
        ),
        "\".\" = \"write\"".into(),
        format!("[permissions.{}.network]", state.profile_id),
        "enabled = false".into(),
        format!("[projects.{}]", path(workspace)?),
        "trust_level = \"untrusted\"".into(),
    ]);
    Ok(lines.join("\n") + "\n")
}

#[cfg(not(target_os = "linux"))]
fn effective_denials(_state: &State, _workspace: &Path, protected: &[PathBuf]) -> Vec<PathBuf> {
    protected.to_vec()
}

#[cfg(target_os = "linux")]
fn effective_denials(state: &State, workspace: &Path, protected: &[PathBuf]) -> Vec<PathBuf> {
    protected
        .iter()
        .filter(|root| {
            // Empty-root isolation hides future siblings; an ancestor deny mount
            // would mask the exact command-state or workspace grants as well.
            root.as_path() != state.namespace && Some(root.as_path()) != workspace.parent()
        })
        .cloned()
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn command_path(_roots: &[PathBuf]) -> Result<String, String> {
    Ok("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into())
}

#[cfg(target_os = "linux")]
fn command_path(roots: &[PathBuf]) -> Result<String, String> {
    let system = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    let mut entries = roots
        .iter()
        .map(|root| root.to_str().ok_or("Codex executable path is not UTF-8"))
        .collect::<Result<Vec<_>, _>>()?;
    entries.push(system);
    Ok(entries.join(":"))
}

fn path(path: &Path) -> Result<String, String> {
    quoted(path.to_str().ok_or("Codex profile path is not UTF-8")?)
}

fn quoted(value: &str) -> Result<String, String> {
    if value
        .chars()
        .any(|character| character < '\u{20}' || character == '\u{7f}')
    {
        return Err("Codex profile value contains a control character".into());
    }
    serde_json::to_string(value).map_err(|error| error.to_string())
}
