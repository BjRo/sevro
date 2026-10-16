use super::{RunError, RunResult, storage};
use nix::errno::Errno;
use nix::sys::signal::kill;
use nix::unistd::{Pid, gethostname};
use rusqlite::{Connection, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessIdentity {
    pid: u32,
    started_at: String,
    host: String,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Active,
    Complete,
    Diagnostic,
    Interrupted,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Claim {
    format: String,
    evaluation_digest: String,
    attempt_id: String,
    status: Status,
    owner: ProcessIdentity,
    active_run_path: PathBuf,
    evidence_directory: PathBuf,
    artifact_path: PathBuf,
    started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    finalized_at: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RetainedClaim {
    format: String,
    evaluation_digest: String,
    attempt_id: String,
    status: Status,
    #[serde(default)]
    owner: Value,
    active_run_path: PathBuf,
    evidence_directory: PathBuf,
    artifact_path: PathBuf,
    #[serde(flatten)]
    retained_fields: serde_json::Map<String, Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletedTrial {
    trial: u64,
    artifact_path: PathBuf,
}

pub(super) struct RunOwner {
    claim_path: PathBuf,
    checkpoint_path: PathBuf,
    claim: Claim,
    completed: Vec<CompletedTrial>,
}

struct UnadmittedDirectory {
    path: PathBuf,
    published: bool,
}

impl Drop for UnadmittedDirectory {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

impl RunOwner {
    pub fn start(root: &Path, digest: &str) -> RunResult<Self> {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("invalid evaluation identity for run ownership".into());
        }
        storage::private_directory(root)?;
        let run_id = Uuid::new_v4().to_string();
        let directory = root.join(&run_id);
        storage::new_directory(&directory)?;
        let mut allocation = UnadmittedDirectory {
            path: directory.clone(),
            published: false,
        };
        let claim_path = root.join("owners").join(format!("{digest}.json"));
        let admitted = locked(&claim_path, |transaction| {
            if let Some(prior) = read_claim(&claim_path)? {
                if prior.evaluation_digest != digest {
                    return Err("Sevro ownership record has a different identity".into());
                }
                if prior.status == Status::Active {
                    match owner_status(&prior.owner) {
                        OwnerStatus::Live => {
                            return Err(format!(
                                "equivalent Sevro run is active: {}",
                                claim_path.display()
                            )
                            .into());
                        }
                        OwnerStatus::Unknown => {
                            return Err("Sevro run ownership is unverifiable".into());
                        }
                        OwnerStatus::Dead => preserve_abandoned(&prior, transaction)?,
                    }
                }
            }
            let claim = Claim {
                format: "sevro.run-owner.v1".into(),
                evaluation_digest: digest.into(),
                attempt_id: run_id.clone(),
                status: Status::Active,
                owner: process_identity(std::process::id())?,
                active_run_path: root.join("active").join(format!("{run_id}.json")),
                evidence_directory: directory.clone(),
                artifact_path: directory.join("run.json"),
                started_at: timestamp(transaction)?,
                finalized_at: None,
            };
            let owner = Self {
                claim_path: claim_path.clone(),
                checkpoint_path: directory.join("checkpoint.json"),
                claim,
                completed: vec![],
            };
            owner.write(&owner.claim)?;
            // JSON replacement is outside SQLite's rollback domain. Once the
            // claim is published, retain its evidence even if COMMIT fails.
            allocation.published = true;
            Ok(owner)
        });
        if admitted.is_err() && !allocation.published {
            fs::remove_dir_all(&allocation.path)?;
            allocation.published = true;
        }
        admitted
    }

    pub fn run_id(&self) -> &str {
        &self.claim.attempt_id
    }

    pub fn directory(&self) -> &Path {
        &self.claim.evidence_directory
    }

    pub fn complete_trial(&mut self, trial: u64, artifact_path: &Path) -> RunResult<()> {
        self.completed.push(CompletedTrial {
            trial,
            artifact_path: artifact_path.to_owned(),
        });
        self.completed.sort_by_key(|entry| entry.trial);
        self.checkpoint(Status::Active)
    }

    pub fn finish(&mut self, interrupted: bool) -> RunResult<()> {
        self.checkpoint(if interrupted {
            Status::Interrupted
        } else {
            Status::Complete
        })
    }

    pub fn diagnose_failure(&mut self) {
        if self.claim.status == Status::Active {
            // A failed diagnostic write cannot replace the original run error.
            let _ = self.checkpoint(Status::Diagnostic);
        }
    }

    fn checkpoint(&mut self, status: Status) -> RunResult<()> {
        let updated = locked(&self.claim_path, |transaction| {
            let current = read_claim(&self.claim_path)?
                .filter(|claim| claim.attempt_id == self.claim.attempt_id)
                .ok_or("Sevro run ownership changed before checkpoint")?;
            if current.status != Status::Active {
                return Err("Sevro run owner is already finalized".into());
            }
            verify_owner(&current.owner)?;
            let mut updated = self.claim.clone();
            updated.status = status;
            if status != Status::Active {
                updated.finalized_at = Some(timestamp(transaction)?);
            }
            self.write(&updated)?;
            Ok(updated)
        })?;
        self.claim = updated;
        Ok(())
    }

    fn write(&self, claim: &Claim) -> RunResult<()> {
        storage::private_directory(
            claim
                .active_run_path
                .parent()
                .expect("active record parent"),
        )?;
        storage::private_directory(self.claim_path.parent().expect("claim parent"))?;
        storage::atomic_json(
            &self.checkpoint_path,
            &json!({
                "format":"sevro.run-checkpoint.v1", "runId":claim.attempt_id, "completedTrials":self.completed
            }),
        )?;
        let mut active = json!({
            "format":"sevro.active-run.v1", "runId":claim.attempt_id,
            "evaluationDigest":claim.evaluation_digest, "attemptId":claim.attempt_id,
            "status":claim.status, "owner":claim.owner, "artifactPath":claim.artifact_path,
            "evidenceDirectory":claim.evidence_directory, "checkpointPath":self.checkpoint_path,
            "completedTrials":self.completed
        });
        if let Some(finalized_at) = &claim.finalized_at {
            active["finalizedAt"] = json!(finalized_at);
        }
        storage::atomic_json(&claim.active_run_path, &active)?;
        storage::atomic_json(&self.claim_path, claim)
    }
}

fn locked<T>(claim: &Path, action: impl FnOnce(&Transaction<'_>) -> RunResult<T>) -> RunResult<T> {
    let root = claim
        .parent()
        .and_then(Path::parent)
        .expect("ownership root");
    let locks = root.join("locks");
    storage::private_directory(&locks)?;
    let database_path = locks.join(format!(
        "{}.sqlite",
        claim.file_name().expect("claim filename").to_string_lossy()
    ));
    let mut connection = Connection::open(database_path).map_err(database_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(database_error)?;
    connection
        .execute_batch("CREATE TABLE IF NOT EXISTS mutex (id INTEGER PRIMARY KEY)")
        .map_err(database_error)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    let result = action(&transaction)?;
    transaction.commit().map_err(database_error)?;
    Ok(result)
}

fn database_error(error: rusqlite::Error) -> RunError {
    RunError::with_source(
        format!("Sevro run ownership database failed: {error}"),
        error,
    )
}

fn timestamp(connection: &Connection) -> RunResult<String> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get(0)
        })
        .map_err(database_error)
}

fn read_claim(path: &Path) -> RunResult<Option<RetainedClaim>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let claim: RetainedClaim = serde_json::from_slice(&bytes).map_err(|error| {
        RunError::with_source(
            format!("unrecognized Sevro ownership record: {}", path.display()),
            error,
        )
    })?;
    if claim.format != "sevro.run-owner.v1"
        || claim.attempt_id.is_empty()
        || claim.active_run_path.as_os_str().is_empty()
        || claim.evidence_directory.as_os_str().is_empty()
        || claim.artifact_path.as_os_str().is_empty()
    {
        return Err(format!("unrecognized Sevro ownership record: {}", path.display()).into());
    }
    Ok(Some(claim))
}

fn process_identity(pid: u32) -> RunResult<ProcessIdentity> {
    let host = gethostname()
        .map_err(|error| RunError::with_source("cannot verify Sevro runner hostname", error))?
        .into_string()
        .map_err(|_| "cannot verify Sevro runner hostname")?;
    let output = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;
    let started_at = String::from_utf8(output.stdout).map_err(|error| {
        RunError::with_source("cannot verify Sevro runner process identity", error)
    })?;
    if !output.status.success() || started_at.trim().is_empty() {
        return Err("cannot verify Sevro runner process identity".into());
    }
    Ok(ProcessIdentity {
        pid,
        host,
        started_at: started_at.trim().into(),
    })
}

fn verify_owner(owner: &Value) -> RunResult<()> {
    if matches!(owner_status(owner), OwnerStatus::Live) {
        Ok(())
    } else {
        Err("Sevro run ownership is unverifiable".into())
    }
}

enum OwnerStatus {
    Live,
    Dead,
    Unknown,
}

fn owner_status(owner: &Value) -> OwnerStatus {
    let Ok(owner) = serde_json::from_value::<ProcessIdentity>(owner.clone()) else {
        return OwnerStatus::Unknown;
    };
    let Ok(pid) = i32::try_from(owner.pid) else {
        return OwnerStatus::Unknown;
    };
    let host = gethostname().ok().and_then(|host| host.into_string().ok());
    if pid <= 0 || owner.started_at.is_empty() || host.as_deref() != Some(owner.host.as_str()) {
        return OwnerStatus::Unknown;
    }
    match kill(Pid::from_raw(pid), None) {
        Err(Errno::ESRCH) => return OwnerStatus::Dead,
        Err(_) => return OwnerStatus::Unknown,
        Ok(()) => {}
    }
    match process_identity(owner.pid) {
        Ok(current) if current.started_at == owner.started_at => OwnerStatus::Live,
        Ok(_) => OwnerStatus::Dead,
        Err(_) => OwnerStatus::Unknown,
    }
}

fn preserve_abandoned(claim: &RetainedClaim, connection: &Connection) -> RunResult<()> {
    let mut interrupted = serde_json::to_value(claim)?;
    interrupted["status"] = json!("interrupted");
    interrupted["finalizedAt"] = json!(timestamp(connection)?);
    storage::atomic_json(
        &claim.evidence_directory.join("run-owner.json"),
        &interrupted,
    )?;
    let mut active = match fs::read(&claim.active_run_path) {
        Ok(bytes) => serde_json::from_slice::<Option<serde_json::Map<String, Value>>>(&bytes)?
            .unwrap_or_default(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::Map::from_iter([
            ("format".into(), json!("sevro.active-run.v1")),
            ("runId".into(), json!(claim.attempt_id)),
            ("artifactPath".into(), json!(claim.artifact_path)),
            ("evidenceDirectory".into(), json!(claim.evidence_directory)),
            ("completedTrials".into(), json!([])),
        ]),
        Err(error) => return Err(error.into()),
    };
    active.insert("status".into(), json!("interrupted"));
    active.insert("finalizedAt".into(), interrupted["finalizedAt"].clone());
    storage::atomic_json(&claim.active_run_path, &active)?;
    Ok(())
}
