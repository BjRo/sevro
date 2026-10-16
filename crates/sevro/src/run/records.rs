mod ownership;

use super::{
    RunError, RunResult,
    fixtures::{self, PreparedFixture},
    graders,
    host::HostContext,
    identity::{PreparedIdentity, sha256},
    options::Options,
    preparation::{Check, PreparedCase},
    storage,
};
use crate::host::{
    HostError, HostRequest, Observation, ObservationCompleteness, RetainedEvidenceIssue,
};
use jsonschema::Registry;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::Instant;

#[derive(Serialize)]
struct Status {
    status: &'static str,
}

#[derive(Serialize)]
struct Task {
    verdict: &'static str,
}

#[derive(Serialize)]
struct Assessment {
    execution: Status,
    grading: Status,
    task: Task,
}

impl Assessment {
    fn new(execution: &'static str, grading: &graders::Assessment) -> Self {
        Self {
            execution: Status { status: execution },
            grading: Status {
                status: grading.grading.as_str(),
            },
            task: Task {
                verdict: grading.task.as_str(),
            },
        }
    }
}

pub(super) struct Completion {
    pub result: Value,
    pub exit_code: i32,
    pub evidence: Value,
    pub result_file: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrialSummary {
    trial: u64,
    #[serde(flatten)]
    assessment: Assessment,
    checks: Vec<graders::CheckResult>,
    domain_outcomes: Vec<Value>,
    artifact_path: PathBuf,
}

pub(super) fn run(
    options: &Options,
    case: &PreparedCase,
    fixture: &PreparedFixture,
    identity: &PreparedIdentity<'_>,
    host: &HostContext,
) -> RunResult<Completion> {
    let digest = identity.identity["digest"]
        .as_str()
        .ok_or("invalid evaluation identity for run ownership")?;
    let mut owner = ownership::RunOwner::start(&options.results_root, digest)?;
    let result = run_owned(options, case, fixture, identity, host, &mut owner);
    if result.is_err() {
        owner.diagnose_failure();
    }
    result
}

fn run_owned(
    options: &Options,
    case: &PreparedCase,
    fixture: &PreparedFixture,
    identity: &PreparedIdentity<'_>,
    host: &HostContext,
    owner: &mut ownership::RunOwner,
) -> RunResult<Completion> {
    let run_id = owner.run_id().to_owned();
    let run_directory = owner.directory().to_owned();
    let evidence_path = run_directory.join("run.json");
    let fixture_artifacts = fixture.retain_artifacts(&run_directory)?;
    let mut trials = Vec::new();
    let mut summaries = Vec::new();
    let mut conditions = Vec::new();
    let mut failed = false;
    let mut failure = None;
    let mut grading_failure = None;
    let mut retained_evidence_issue = None;
    let context = TrialContext {
        options,
        case,
        fixture,
        identity,
        host,
        run_directory: &run_directory,
        fixture_artifacts: &fixture_artifacts,
        owner: Mutex::new(&mut *owner),
        admission: Mutex::new(Admission {
            next: 1,
            stopped: false,
            failure: None,
        }),
    };
    let completed = context.run()?;
    drop(context);
    for completed in completed {
        if completed.failed && !failed {
            failure = completed.failure;
        }
        failed |= completed.failed;
        grading_failure = grading_failure.or(completed.grading_failure);
        retained_evidence_issue = retained_evidence_issue.or(completed.retained_evidence_issue);
        trials.push(completed.evidence);
        summaries.push(completed.summary);
        conditions.push(completed.condition);
    }
    let interruption = host.cancellation().signal();
    let execution = if failed {
        "failed"
    } else if interruption.is_some() {
        "cancelled"
    } else if options.dry {
        "not_run"
    } else {
        "completed"
    };
    let grading = if grading_failure.is_some() {
        "error"
    } else if summaries
        .iter()
        .any(|trial| trial.assessment.grading.status == "unavailable")
    {
        "unavailable"
    } else if summaries
        .iter()
        .any(|trial| trial.assessment.grading.status == "completed")
    {
        "completed"
    } else {
        "not_requested"
    };
    let task = if summaries.is_empty()
        || summaries
            .iter()
            .any(|trial| trial.assessment.task.verdict == "not_assessed")
    {
        "not_assessed"
    } else {
        let passed = summaries
            .iter()
            .filter(|trial| trial.assessment.task.verdict == "passed")
            .count();
        if passed as f64 / summaries.len() as f64
            >= options.threshold.as_f64().expect("validated threshold")
        {
            "passed"
        } else {
            "failed"
        }
    };
    let exit_code = if let Some(signal) = interruption {
        128 + signal
    } else if failed {
        2
    } else if grading_failure.is_some() {
        3
    } else if grading == "unavailable" {
        4
    } else if task == "failed" {
        1
    } else {
        0
    };
    let actual_condition = conditions
        .first()
        .filter(|first| conditions.iter().all(|condition| condition == *first))
        .map(String::as_str)
        .unwrap_or("unknown");
    let mut result = json!({
        "format":"sevro.cli-result.v1","runId":run_id,
        "execution":{"status":execution},"grading":{"status":grading},"task":{"verdict":task},
        "exitCode":exit_code,"evidencePath":evidence_path,
        "cases":[{"caseId":case.id,"execution":{"status":execution},"grading":{"status":grading},
            "task":{"verdict":task},"trials":summaries}]
    });
    let diagnostic = if interruption.is_some() {
        json!({"code":"sevro.run.cancelled","message":"run cancelled"})
    } else if !failed && grading_failure.is_some() {
        json!({"code":"sevro.grader.error","message":"output grading did not complete"})
    } else {
        failure_diagnostic(failure)
    };
    if failed || interruption.is_some() || grading_failure.is_some() {
        result["diagnostic"] = diagnostic.clone();
    }
    let mut evidence = json!({
        "format":"sevro.run-evidence.v1","runId":run_id,"evaluationIdentity":identity.identity,
        "configuration":identity.configuration,
        "runner":identity.runner,
        "project":identity.project,"extension":identity.extension,
        "condition":{"requested":options.condition,"actual":actual_condition,"requestedInstrumentation":[],"appliedInstrumentation":[]},
        "graders":{"active":identity.graders,"replacedDefaults":[]},"routes":[identity.route],"result":result,"trials":trials
    });
    if failed || interruption.is_some() || grading_failure.is_some() {
        evidence["diagnostic"] = diagnostic;
    }
    validate(&result, &evidence)?;
    if retained_evidence_issue.is_some() {
        return Err("invalid Sevro retained evidence".into());
    }
    storage::atomic_json(&evidence_path, &evidence)?;
    owner.finish(interruption.is_some())?;
    let result_file = run_directory.join("result.json");
    let publication = storage::atomic_json(&result_file, &result)
        .and_then(|()| storage::atomic_json(&options.results_root.join("latest.json"), &result))
        .map_err(|error| {
            RunError::with_source(
                "CLI result/latest could not be retained; check --results-root permissions",
                error,
            )
        });
    let result_file = publication.is_ok().then_some(result_file);
    if let Err(error) = publication {
        if exit_code == 0 {
            return Err(error);
        }
        eprintln!(
            "sevro: CLI result/latest could not be retained; original run outcome preserved; inspect evidence directly"
        );
    }
    Ok(Completion {
        result,
        exit_code,
        evidence,
        result_file,
    })
}

struct Admission {
    next: u64,
    stopped: bool,
    failure: Option<RunError>,
}

struct CompletedTrial {
    summary: TrialSummary,
    evidence: Value,
    condition: String,
    failed: bool,
    failure: Option<HostError>,
    grading_failure: Option<RunError>,
    retained_evidence_issue: Option<RetainedEvidenceIssue>,
}

struct TrialContext<'a, 'identity> {
    options: &'a Options,
    case: &'a PreparedCase,
    fixture: &'a PreparedFixture,
    identity: &'a PreparedIdentity<'identity>,
    host: &'a HostContext,
    run_directory: &'a Path,
    fixture_artifacts: &'a [Value],
    owner: Mutex<&'a mut ownership::RunOwner>,
    admission: Mutex<Admission>,
}

impl TrialContext<'_, '_> {
    fn run(&self) -> RunResult<Vec<CompletedTrial>> {
        let mut completed = thread::scope(|scope| {
            let workers: Vec<_> = (0..self.options.jobs.min(self.options.trials))
                .map(|_| scope.spawn(|| self.worker()))
                .collect();
            let mut completed = Vec::new();
            for worker in workers {
                completed.extend(worker.join().map_err(|_| "trial worker failed")??);
            }
            Ok::<_, RunError>(completed)
        })?;
        let mut admission = self
            .admission
            .lock()
            .map_err(|_| "trial admission lock failed")?;
        if let Some(error) = admission.failure.take() {
            return Err(error);
        }
        completed.sort_by_key(|trial| trial.summary.trial);
        Ok(completed)
    }

    fn worker(&self) -> RunResult<Vec<CompletedTrial>> {
        let mut completed = Vec::new();
        loop {
            let trial = {
                let mut admission = self
                    .admission
                    .lock()
                    .map_err(|_| "trial admission lock failed")?;
                if admission.stopped
                    || self.host.cancellation().is_cancelled()
                    || admission.next > self.options.trials
                {
                    break;
                }
                let trial = admission.next;
                admission.next += 1;
                trial
            };
            match self.execute(trial) {
                Ok(trial) => completed.push(trial),
                Err(error) => {
                    let mut admission = self
                        .admission
                        .lock()
                        .map_err(|_| "trial admission lock failed")?;
                    admission.stopped = true;
                    admission.failure.get_or_insert(error);
                    break;
                }
            }
        }
        Ok(completed)
    }

    fn stop_admission(&self) -> RunResult<()> {
        self.admission
            .lock()
            .map_err(|_| "trial admission lock failed")?
            .stopped = true;
        Ok(())
    }

    fn execute(&self, trial: u64) -> RunResult<CompletedTrial> {
        let Self {
            options,
            case,
            fixture,
            identity,
            host,
            run_directory,
            ..
        } = self;
        let materialized = fixtures::materialize(fixture, host.cancellation())?;
        let workspace = &materialized.workspace;
        let receipt = self.candidate_receipt(&materialized, trial)?;
        if receipt.failed || receipt.cancelled {
            self.stop_admission()?;
        }
        let checks = if options.dry || receipt.failed || receipt.cancelled {
            &[]
        } else {
            case.checks.as_slice()
        };
        let (mut grading, grading_failure) =
            match graders::evaluate(checks, receipt.final_message.as_deref(), receipt.complete) {
                Ok(grading) => (grading, None),
                Err(error) => {
                    self.stop_admission()?;
                    (graders::Assessment::error(), Some(error))
                }
            };
        if receipt.execution(options.dry) == "completed"
            && grading_failure.is_none()
            && case
                .required_evidence
                .iter()
                .any(|id| !receipt.has_required_evidence(id))
        {
            grading.grading = graders::GradingStatus::Unavailable;
            if !matches!(grading.task, graders::TaskVerdict::Failed) {
                grading.task = graders::TaskVerdict::NotAssessed;
            }
        }
        let summary = TrialSummary {
            trial,
            assessment: Assessment::new(receipt.execution(options.dry), &grading),
            checks: grading.checks,
            domain_outcomes: grading.domain_outcomes,
            artifact_path: run_directory.join(format!("trial-{trial}.json")),
        };
        let mut observations = vec![
            json!({"id":"sevro.observation.final-message","source":identity.route.host,"completeness":receipt.completeness,"data":receipt.observation}),
            json!({"id":"sevro.observation.workspaces","source":"sevro.runner","completeness":"complete","data":{"candidate":workspace,"retainedAuxiliary":[]}}),
        ];
        observations.extend(receipt.observations.iter().map(|observation| {
            json!({"id":observation.id,"source":identity.route.host,"completeness":observation.completeness,"data":observation.data})
        }));
        let evidence = json!({
            "caseId":case.id,"trial":trial,"executionMode":if options.dry {"dry"} else {"executed"},"candidateDurationMs":receipt.duration_ms,
            "condition":{"requested":options.condition,"actual":receipt.actual_condition,"appliedInstrumentation":[]},
            "observationCompleteness":receipt.completeness,
            "observations":observations,
            "metrics":grading.metrics,"domainOutcomes":summary.domain_outcomes,"taskVerdictPolicy":null,"advisoryReview":null,
            "routes":[identity.route],"usage":receipt.usage,
            "rawResult":{"source":identity.route.host,"path":receipt.raw_path,"sha256":receipt.raw_digest},"artifactRefs":receipt.artifacts
        });
        storage::atomic_json(
            &summary.artifact_path,
            &json!({
                "format":"sevro.trial-evidence.v1","caseId":case.id,"trial":trial,"result":summary,"evidence":evidence
            }),
        )?;
        let checkpoint = self
            .owner
            .lock()
            .map_err(|_| "run ownership lock failed")?
            .complete_trial(trial, &summary.artifact_path);
        if !receipt.failed
            && !receipt.cancelled
            && summary.assessment.grading.status != "unavailable"
            && summary.assessment.grading.status != "error"
            && summary.assessment.task.verdict != "failed"
            && storage::cleanup(workspace).is_err()
        {
            eprintln!(
                "fixture cleanup failed; retained at {}",
                workspace.display()
            );
        }
        checkpoint?;
        eprintln!(
            "sevro: case={} trial={trial} candidate {}; grading {}",
            case.id,
            if options.dry {
                "skipped"
            } else {
                summary.assessment.execution.status
            },
            summary.assessment.grading.status
        );
        Ok(CompletedTrial {
            summary,
            evidence,
            condition: receipt.actual_condition,
            failed: receipt.failed,
            failure: receipt.failure,
            grading_failure,
            retained_evidence_issue: receipt.retained_evidence_issue,
        })
    }
}

struct CandidateReceipt {
    failed: bool,
    cancelled: bool,
    duration_ms: Option<f64>,
    actual_condition: String,
    completeness: &'static str,
    observation: Value,
    usage: Value,
    raw_path: Option<String>,
    raw_digest: Option<String>,
    artifacts: Vec<Value>,
    produced_artifact_ids: Vec<String>,
    observations: Vec<Observation>,
    final_message: Option<String>,
    complete: bool,
    failure: Option<HostError>,
    retained_evidence_issue: Option<RetainedEvidenceIssue>,
}

impl CandidateReceipt {
    fn has_required_evidence(&self, id: &str) -> bool {
        match id {
            "sevro.observation.final-message" => self.completeness == "complete",
            "sevro.observation.workspaces" => true,
            _ => {
                self.produced_artifact_ids
                    .iter()
                    .any(|produced| produced == id)
                    || self.observations.iter().any(|observation| {
                        observation.id == id
                            && observation.completeness == ObservationCompleteness::Complete
                    })
            }
        }
    }

    fn execution(&self, dry: bool) -> &'static str {
        if self.cancelled {
            "cancelled"
        } else if self.failed {
            "failed"
        } else if dry {
            "not_run"
        } else {
            "completed"
        }
    }
}

impl TrialContext<'_, '_> {
    fn candidate_receipt(
        &self,
        materialized: &fixtures::Materialized,
        trial: u64,
    ) -> RunResult<CandidateReceipt> {
        let Self {
            options,
            case,
            host,
            run_directory,
            fixture_artifacts,
            ..
        } = self;
        let workspace = &materialized.workspace;
        let mut receipt = CandidateReceipt {
            failed: false,
            cancelled: materialized.cancelled || host.cancellation().is_cancelled(),
            duration_ms: None,
            actual_condition: "unknown".into(),
            completeness: "unavailable",
            observation: json!({}),
            usage: json!({"inputTokens":null,"outputTokens":null,"costUsd":null,"complete":false}),
            raw_path: None,
            raw_digest: None,
            artifacts: fixture_artifacts.to_vec(),
            produced_artifact_ids: vec![],
            observations: vec![],
            final_message: None,
            complete: false,
            failure: None,
            retained_evidence_issue: None,
        };
        if options.dry || receipt.cancelled {
            return Ok(receipt);
        }
        let started = Instant::now();
        let result = host.execute(&HostRequest {
            prompt: &case.prompt,
            follow_up_prompt: case.follow_up_prompt.as_deref(),
            workspace,
            condition: &options.condition,
        });
        receipt.duration_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
        receipt.cancelled = host.cancellation().is_cancelled();
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                receipt.failed = !receipt.cancelled;
                if receipt.failed {
                    receipt.failure = Some(match error {
                        HostError::Failure(_private_message) => {
                            HostError::Failure("host execution did not complete".into())
                        }
                        HostError::InvalidConditionEvidence => HostError::InvalidConditionEvidence,
                    });
                }
                return Ok(receipt);
            }
        };
        if result
            .final_message
            .as_ref()
            .is_some_and(|message| message.len() > 8 * 1024 * 1024)
            || !valid_artifacts(&result.artifacts, fixture_artifacts, &case.checks)
        {
            receipt.failed = !receipt.cancelled;
            return Ok(receipt);
        }
        receipt.actual_condition = result.actual_condition.unwrap_or_else(|| "unknown".into());
        receipt.retained_evidence_issue = result.retained_evidence_issue;
        receipt.failed = result.execution_failed && !receipt.cancelled;
        if receipt.failed || receipt.cancelled {
            self.stop_admission()?;
        }
        receipt.failure = result
            .failure_message
            .or_else(|| {
                result
                    .process_failure
                    .as_ref()
                    .and_then(|failure| process_failure_message(host, failure))
            })
            .map(HostError::Failure);
        receipt.complete = result.complete;
        receipt.usage = json!({"inputTokens":result.input_tokens,"outputTokens":result.output_tokens,
        "costUsd":result.cost_usd,"complete":result.usage_complete.unwrap_or(false)});
        receipt.observations = result.observations;
        for artifact in result.artifacts {
            receipt.produced_artifact_ids.push(artifact.id.clone());
            let path = run_directory.join(format!("trial-{trial}-host-{}.bin", artifact.id));
            storage::write_private(&path, &artifact.bytes)
                .map_err(|error| trial_persistence_error(workspace, error))?;
            let uri = url::Url::from_file_path(path).map_err(|()| "invalid host artifact path")?;
            receipt.artifacts.push(
                json!({"id":artifact.id,"path":uri.as_str(),"sha256":sha256(&artifact.bytes)}),
            );
        }
        if let Some(message) = result.final_message {
            let digest = sha256(message.as_bytes());
            receipt.completeness = if result.complete {
                "complete"
            } else {
                "partial"
            };
            receipt.observation = json!({"sha256":digest,"byteLength":message.len()});
            let path = run_directory.join(format!("trial-{trial}-raw.txt"));
            storage::write_private(&path, message.as_bytes())
                .map_err(|error| trial_persistence_error(workspace, error))?;
            receipt.raw_path = Some(
                url::Url::from_file_path(path)
                    .map_err(|()| "invalid raw result path")?
                    .into(),
            );
            receipt.raw_digest = Some(digest);
            receipt.final_message = Some(message);
        }
        Ok(receipt)
    }
}

fn trial_persistence_error(workspace: &Path, error: RunError) -> RunError {
    RunError::with_source(
        format!(
            "trial persistence failed; fixture retained at {}",
            workspace.display()
        ),
        error,
    )
}

fn failure_diagnostic(failure: Option<HostError>) -> Value {
    match failure {
        Some(HostError::InvalidConditionEvidence) => json!({
            "code":"sevro.instrumentation.mismatch",
            "message":"host condition evidence is invalid"
        }),
        Some(HostError::Failure(message)) => {
            json!({"code":"sevro.host.failed","message":message})
        }
        None => {
            json!({"code":"sevro.host.failed","message":"host execution did not complete"})
        }
    }
}

fn valid_artifacts(
    artifacts: &[crate::host::Artifact],
    existing: &[Value],
    checks: &[Check],
) -> bool {
    let mut ids = existing
        .iter()
        .filter_map(|artifact| artifact["id"].as_str())
        .chain(checks.iter().map(|check| check.id.as_str()))
        .collect::<std::collections::BTreeSet<_>>();
    artifacts.len() <= 32
        && artifacts.iter().all(|artifact| {
            artifact.bytes.len() <= 8 * 1024 * 1024
                && qualified_id(&artifact.id)
                && ids.insert(&artifact.id)
        })
        && artifacts
            .iter()
            .map(|artifact| artifact.bytes.len())
            .sum::<usize>()
            <= 32 * 1024 * 1024
}

fn process_failure_message(
    host: &HostContext,
    failure: &crate::host::ProcessFailure,
) -> Option<String> {
    if host.id != "sevro.host.codex" {
        return None;
    }
    let label = match failure.phase.as_str() {
        "isolation-preflight" => "Codex isolation preflight",
        "executable-preflight" => "Codex executable preflight",
        "execution" => "Codex run",
        _ => return None,
    };
    let suffix = match failure.reason.as_str() {
        "timeout" if (1..=1_800_000).contains(&failure.timeout_ms) => {
            format!("timed out after {} s", failure.timeout_ms as f64 / 1000.0)
        }
        "cancelled" => "cancelled".into(),
        _ => "failed".into(),
    };
    Some(format!("{label} {suffix}"))
}

fn qualified_id(id: &str) -> bool {
    let parts = id.split(['.', '-']).collect::<Vec<_>>();
    parts.len() > 1
        && id.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn validate(result: &Value, evidence: &Value) -> RunResult<()> {
    let mut registry = Registry::new();
    for (id, source) in [
        (
            "urn:sevro:schema:cli-result:v1",
            include_str!("../../../../schemas/cli-result-v1.schema.json"),
        ),
        (
            "urn:sevro:schema:run-evidence:v1",
            include_str!("../../../../schemas/run-evidence-v1.schema.json"),
        ),
    ] {
        let schema: Value = serde_json::from_str(source)?;
        registry = registry.add(id, schema)?;
    }
    let registry = registry.prepare()?;
    for (id, value) in [("cli-result", result), ("run-evidence", evidence)] {
        let validator = jsonschema::draft202012::options()
            .with_registry(&registry)
            .build(&json!({"$ref":format!("urn:sevro:schema:{id}:v1")}))?;
        validator.validate(value).map_err(|error| {
            RunError::with_source(format!("invalid retained {id}: {error}"), error.to_owned())
        })?;
    }
    Ok(())
}
