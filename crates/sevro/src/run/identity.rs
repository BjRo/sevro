use super::{
    RunError, RunResult,
    extension_context::ExtensionContext,
    fixtures::PreparedFixture,
    host::HostContext,
    options::{Candidate, CaseSource, Options},
    preparation::PreparedCase,
    provenance,
    runtime_config::RuntimeSelection,
};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;

#[derive(Serialize)]
pub(super) struct Route<'a> {
    pub role: &'static str,
    pub host: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
}

#[derive(Serialize)]
pub(super) struct Grader<'a> {
    id: &'a str,
    source: &'static str,
    version: &'static str,
}

pub(super) struct PreparedIdentity<'a> {
    pub identity: Value,
    pub configuration: Value,
    pub resolved: Value,
    pub route: Route<'a>,
    pub graders: Vec<Grader<'a>>,
    pub project: Value,
    pub runner: Value,
    pub extension: Value,
}

pub(super) struct PreparationFailure {
    pub code: i32,
    pub error: RunError,
}

impl From<RunError> for PreparationFailure {
    fn from(error: RunError) -> Self {
        Self { code: 64, error }
    }
}

impl From<provenance::ProvenanceFailure> for PreparationFailure {
    fn from(failure: provenance::ProvenanceFailure) -> Self {
        Self {
            code: failure.exit_code,
            error: failure.error,
        }
    }
}

impl From<crate::extension::Failure> for PreparationFailure {
    fn from(failure: crate::extension::Failure) -> Self {
        Self {
            code: failure.code,
            error: failure.message.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Dimensions<'a> {
    runner_build_digest: &'a str,
    project_digest: &'a str,
    configuration_digest: String,
    extension_digest: Option<String>,
    extension_protocol: Option<String>,
    case_digest: String,
    fixture_digest: String,
    checks_digest: String,
    required_evidence_digest: String,
    evaluator_digest: String,
    grader_digest: String,
    instrumentation_digest: String,
    route_digest: String,
    condition: &'a str,
    trial_count: u64,
    pass_threshold: &'a serde_json::Number,
}

pub(super) fn prepare<'a>(
    options: &'a Options,
    case: &'a PreparedCase,
    fixture: &PreparedFixture,
    host: &'a HostContext,
    extension: Option<&ExtensionContext>,
    runtime: &RuntimeSelection,
) -> Result<PreparedIdentity<'a>, PreparationFailure> {
    refuse_pending_configuration(options)?;
    let provenance = provenance::resolve(provenance::Request {
        project_root: &options.project_root,
        excluded_roots: std::slice::from_ref(&options.results_root),
        runner_digest: options.runner_digest.as_deref(),
        project_digest: options.project_digest.as_deref(),
    })?;
    let route = Route {
        role: "candidate",
        host: &host.id,
        model: &host.model,
        effort: &host.effort,
    };
    let graders = case
        .checks
        .iter()
        .map(|check| check.grader.as_str())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|id| Grader {
            id,
            source: "builtin",
            version: "1.0.0",
        })
        .collect::<Vec<_>>();
    let mut redacted = json!({
        "condition":options.condition, "executionMode":if options.dry {"dry"} else {"executed"}, "trialCount":options.trials,
        "jobs":options.jobs, "passThreshold":options.threshold,
        "extensionConfigurationDigest":null,
        "runSettings":{
            "shellIsolation":false,"protectedRoots":[],"toolchainBinDir":null,
            "claudeUvCacheDir":null,"candidateTimeoutMs":host.timeout_ms(),"semanticTimeoutMs":null,
            "advisoryTimeoutMs":null,"claudeProjectSettings":false
        }
    });
    if let Some(configuration) = &host.configuration {
        redacted["hostConfiguration"] = json!({"candidate":configuration});
    }
    if let Some(policy) = &runtime.policy {
        redacted["runtimePolicy"] = policy.clone();
    }
    if let Some(extension) = extension {
        redacted["extensionConfigurationDigest"] =
            extension.identity["configurationDigest"].clone();
        redacted["extensionConfiguration"] = extension.redacted_configuration.clone();
    }
    if let Some(setup) = fixture.setup_configuration() {
        redacted["fixtureSetupDigest"] = hash_json(&setup)?.into();
    }
    let extension_data = extension
        .map(|extension| extension.data.clone())
        .unwrap_or_default();
    let resolved = resolved_settings(options, case, &route, host, runtime);
    let configuration_digest = hash_json(&redacted)?;
    let mut case_identity =
        json!({"id":case.id,"prompt":case.prompt,"extensionData":extension_data});
    if let Some(prompt) = &case.follow_up_prompt {
        case_identity["followUpPrompt"] = prompt.clone().into();
    }
    let dimensions = Dimensions {
        runner_build_digest: &provenance.runner_digest,
        project_digest: &provenance.project_digest,
        configuration_digest: configuration_digest.clone(),
        extension_digest: extension.and_then(|extension| {
            extension.identity["sourceDigest"]
                .as_str()
                .map(String::from)
        }),
        extension_protocol: extension
            .and_then(|extension| extension.identity["protocol"].as_str().map(String::from)),
        case_digest: hash_json(&case_identity)?,
        fixture_digest: hash_json(&fixture.identity())?,
        checks_digest: hash_json(&case.checks)?,
        required_evidence_digest: hash_json(&case.required_evidence)?,
        evaluator_digest: hash_json(
            &json!({"policy":"sevro.builtin-output.v1","extension":extension.map(|extension| &extension.identity),"extensionData":extension_data}),
        )?,
        grader_digest: hash_json(&graders)?,
        instrumentation_digest: hash_json(&json!({"requested":[],"applied":[]}))?,
        route_digest: hash_json(&route)?,
        condition: &options.condition,
        trial_count: options.trials,
        pass_threshold: &options.threshold,
    };
    let mut identity_bytes = b"sevro.identity.v1\n".to_vec();
    identity_bytes.extend(serde_jcs::to_vec(&dimensions).map_err(RunError::from)?);
    let identity = json!({"algorithm":"sevro.identity.v1","digest":sha256(&identity_bytes),"dimensions":dimensions});
    let configuration =
        json!({"digest":configuration_digest,"redacted":redacted,"resolved":resolved});
    Ok(PreparedIdentity {
        identity,
        configuration,
        resolved,
        route,
        graders,
        project: provenance.project,
        runner: provenance.runner,
        extension: extension
            .map(ExtensionContext::evidence)
            .unwrap_or(Value::Null),
    })
}

fn resolved_settings(
    options: &Options,
    case: &PreparedCase,
    route: &Route<'_>,
    host: &HostContext,
    runtime: &RuntimeSelection,
) -> Value {
    let extension = match &options.case_source {
        CaseSource::Extension(selection) => Some(selection),
        _ => None,
    };
    let adapter_module = match &options.candidate {
        Candidate::Adapter { module } => Some(module),
        _ => None,
    };
    json!({
        "format":"sevro.resolved-run-settings.v1","runManifestFile":options.run_manifest_file,"caseFile":options.case_source.file(),
        "caseId":case.id,"caseSourceMapping":options.case_source_map_file.is_some(),"extensionCommandFile":extension.map(|selection| &selection.command_file),"extensionSourceFileCount":extension.map_or(0,|selection| selection.source_files.len()),
        "taskVerdictPolicy":null,"replaceBuiltinGraders":[],"adapterModule":adapter_module,"semanticAdapterModule":null,
        "advisoryAdapterModule":null,"advisoryExcludedPaths":[],"toolchainBinDir":null,"claudeUvCacheDir":null,
        "protectedRoots":[],"condition":options.condition,"trials":options.trials,"threshold":options.threshold,
        "jobs":options.jobs,"dry":options.dry,"projectRoot":options.project_root,"configRoot":options.config_root,
        "resultsRoot":options.results_root,"runStateRoot":options.results_root,"runtimeConfigFile":runtime.path,
        "candidate":{"host":route.host,"model":route.model,"effort":route.effort,"executable":host.executable,"timeoutMs":host.timeout_ms()},
        "semantic":null,"advisory":null,"codexEntrypoint":matches!(options.candidate, Candidate::Codex { .. }).then_some("exec"),"agentConcurrencyLimit":null,
        "shellIsolation":false,"retainHostDiagnostics":false,"claudeProjectSettings":false,
        "shellCheckDefaults":{"expectedExitCode":0,"timeoutMs":30000}
    })
}

fn refuse_pending_configuration(options: &Options) -> RunResult<()> {
    let path = options.config_root.join(".codex/config.toml");
    match fs::symlink_metadata(&path) {
        Ok(_) => Err(format!(
            "configuration loading is not yet implemented in Rust: {}",
            path.display()
        )
        .into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(RunError::with_source(
            format!("Cannot read Codex configuration: {}", path.display()),
            error,
        )),
    }
}

pub(super) fn hash_json(value: &impl Serialize) -> RunResult<String> {
    serde_jcs::to_vec(value)
        .map(|bytes| sha256(&bytes))
        .map_err(RunError::from)
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
