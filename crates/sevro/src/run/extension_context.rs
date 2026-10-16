use super::{
    RunError,
    fixtures::{ArtifactDeclaration, FixtureSetup, FixtureSetupInput},
    host::HostContext,
    identity::PreparationFailure,
    options::Options,
    preparation::PreparedCase,
};
use crate::extension::{Selection, Session};
use serde::Deserialize;
use serde_json::{Map, Value, json};

pub(super) struct ExtensionContext {
    pub identity: Value,
    pub redacted_configuration: Value,
    pub data: Map<String, Value>,
    pub fixture_setup: Option<FixtureSetup>,
    pub artifacts: Vec<ArtifactDeclaration>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preparation {
    artifacts: Vec<ArtifactDeclaration>,
    requested_instrumentation: Vec<Value>,
    extension_data: Map<String, Value>,
    fixture_setup: Option<FixtureSetupInput>,
}

pub(super) fn load(
    options: &Options,
    selection: &Selection,
    host: &HostContext,
    cancellation: crate::cancellation::Cancellation,
) -> Result<(PreparedCase, ExtensionContext), PreparationFailure> {
    let session = Session::open(selection, host.descriptor(), cancellation)?;
    let resolved = session.resolve(&options.project_root, &selection.case_id)?;
    let case = PreparedCase::from_value(resolved.clone())?;
    let prepared: Preparation = serde_json::from_value(
        session.prepare(&resolved, &options.condition)?,
    )
    .map_err(|cause| PreparationFailure {
        code: 70,
        error: RunError::with_source("could not decode validated extension preparation", cause),
    })?;
    if !prepared.requested_instrumentation.is_empty() {
        return Err(PreparationFailure {
            code: 64,
            error: "extension preparation requested unsupported instrumentation".into(),
        });
    }
    let fixture_setup = prepared
        .fixture_setup
        .map(FixtureSetup::prepare)
        .transpose()?;
    if fixture_setup.is_some()
        && !session.identity["capabilities"]
            .as_array()
            .expect("negotiated capabilities are an array")
            .iter()
            .any(|capability| capability == "sevro.fixture.setup")
    {
        return Err(PreparationFailure {
            code: 64,
            error: "fixture setup capability was not negotiated".into(),
        });
    }
    let mut data = resolved["extensionData"]
        .as_object()
        .expect("schema-validated resolved extension data is an object")
        .clone();
    data.extend(prepared.extension_data);
    Ok((
        case,
        ExtensionContext {
            identity: session.identity,
            redacted_configuration: session.redacted_configuration,
            data,
            fixture_setup,
            artifacts: prepared.artifacts,
        },
    ))
}

impl ExtensionContext {
    pub fn evidence(&self) -> Value {
        json!({
            "id":self.identity["id"],"version":self.identity["version"],
            "sourceDigest":self.identity["sourceDigest"],"configurationDigest":self.identity["configurationDigest"],
            "protocol":self.identity["protocol"],"capabilities":self.identity["capabilities"],
            "replacements":{"graders":self.identity["replacedBuiltinGraders"],"taskVerdictPolicy":self.identity["selectedTaskVerdictPolicy"]}
        })
    }
}
