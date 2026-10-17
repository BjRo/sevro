use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub(super) fn create(
    private: &Path,
    credential: &Path,
    protected: &[PathBuf],
    workspace: &Path,
) -> Result<Value, String> {
    if !credential.starts_with(private) || credential == private {
        return Err("Claude private state paths are invalid".into());
    }
    let roots: Vec<&Path> = std::iter::once(private)
        .chain(protected.iter().map(PathBuf::as_path))
        .collect();
    let writable: Vec<&Path> = roots
        .iter()
        .copied()
        .filter(|root| Some(*root) != workspace.parent())
        .collect();
    let mut deny = Vec::new();
    for root in &writable {
        deny.push(rule(root, "Read")?);
        deny.push(rule(root, "Edit")?);
    }
    Ok(json!({
        "disableAllHooks": true,
        "sandbox": {
            "enabled": true,
            "allowUnsandboxedCommands": false,
            "failIfUnavailable": true,
            "filesystem": {"denyRead": roots, "allowRead": [workspace], "denyWrite": writable},
            "credentials": {
                "files": [{"path": credential, "mode": "deny"}],
                "envVars": [
                    {"name": "ANTHROPIC_API_KEY", "mode": "deny"},
                    {"name": "CLAUDE_CODE_OAUTH_TOKEN", "mode": "deny"}
                ]
            }
        },
        "permissions": {
            "allow": ["Bash", "Read", "Skill", "Agent", rule(workspace, "Edit")?],
            "blockReadsOutsideWorkingDirectories": true,
            "additionalDirectories": [],
            "deny": deny
        }
    }))
}

fn rule(path: &Path, tool: &str) -> Result<String, String> {
    let path_text = path.to_str().ok_or("Claude protected path is invalid")?;
    if !path.is_absolute() || path_text.contains(['\r', '\n', '(', ')']) {
        return Err("Claude protected path is invalid".into());
    }
    Ok(format!("{tool}(/{path_text}/**)"))
}
