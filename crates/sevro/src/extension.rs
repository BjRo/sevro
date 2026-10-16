use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

mod transport;

const PROTOCOL: &str = "sevro.extension.v1";
const ENGINE_CAPABILITIES: [&str; 3] = [
    "sevro.host.exec",
    "sevro.fixture.setup",
    "sevro.case.host-route",
];

pub(crate) struct Selection {
    pub command_file: PathBuf,
    pub source_files: Vec<PathBuf>,
    pub case_id: String,
    pub configuration_file: Option<PathBuf>,
    pub redacted_configuration_file: Option<PathBuf>,
}

#[derive(Debug)]
pub(crate) struct Failure {
    pub code: i32,
    pub message: String,
}

impl Failure {
    fn invocation(message: &str) -> Self {
        Self {
            code: 64,
            message: message.into(),
        }
    }

    fn protocol(message: &str) -> Self {
        Self {
            code: 70,
            message: message.into(),
        }
    }
}

type Result<T> = std::result::Result<T, Failure>;

pub(crate) struct Session {
    pub identity: Value,
    pub redacted_configuration: Value,
    command: Vec<String>,
    source_files: Vec<PathBuf>,
    source_digest: String,
    configuration: Value,
    cancellation: crate::cancellation::Cancellation,
    host: Value,
    validator: jsonschema::Validator,
}

impl Session {
    pub fn open(
        selection: &Selection,
        host: Value,
        cancellation: crate::cancellation::Cancellation,
    ) -> Result<Self> {
        let command = load_command(&selection.command_file)?;
        let configuration = load_configuration(
            selection.configuration_file.as_deref(),
            "extension configuration file",
        )?;
        let redacted_configuration = load_configuration(
            selection.redacted_configuration_file.as_deref(),
            "redacted extension configuration file",
        )?;
        if !configuration.is_object() || !redacted_configuration.is_object() {
            return Err(Failure::invocation(
                "extension configuration must be JSON objects",
            ));
        }
        let source_digest = source_digest(&command, &selection.source_files)?;
        let schema: Value =
            serde_json::from_str(include_str!("../../../schemas/extension-v1.schema.json"))
                .expect("embedded extension schema is valid JSON");
        let validator = jsonschema::draft202012::options()
            .build(&schema)
            .expect("embedded extension schema is valid");
        let mut session = Self {
            identity: Value::Null,
            redacted_configuration,
            command,
            source_files: selection.source_files.clone(),
            source_digest: source_digest.clone(),
            configuration,
            cancellation,
            host,
            validator,
        };
        let description: Description = serde_json::from_value(session.exchange(
            "describe",
            json!({
                "protocols":[PROTOCOL], "engineCapabilities":ENGINE_CAPABILITIES,
                "hostCapabilities":session.host["capabilities"]
            }),
        )?)
        .expect("validated description has its declared shape");
        let capabilities = negotiated_capabilities(&description, &session.host)?;
        session.identity = json!({
            "id":description.extension.id,"version":description.extension.version,
            "protocol":PROTOCOL,"capabilities":capabilities,
            "graders":description.graders,"taskVerdictPolicies":description.task_verdict_policies,
            "sourceDigest":source_digest,
            "configurationDigest":hash_json(&json!({
                "command":session.command,"configuration":session.redacted_configuration,"taskVerdictPolicy":null,"replacedBuiltinGraders":[]
            })),
            "selectedTaskVerdictPolicy":null,"replacedBuiltinGraders":[]
        });
        Ok(session)
    }

    pub fn resolve(&self, project_root: &Path, case_id: &str) -> Result<Value> {
        let project_url = url::Url::from_file_path(project_root)
            .map_err(|_| Failure::invocation("project root must be absolute"))?;
        let result = self.exchange(
            "resolve",
            json!({
                "projectRoot":project_url.as_str(),"selectors":{"caseIds":[case_id]},
                "host":self.host,"configuration":self.configuration
            }),
        )?;
        let cases = result["cases"]
            .as_array()
            .expect("validated resolve cases are an array");
        let mut ids = BTreeSet::new();
        if cases
            .iter()
            .any(|case| !ids.insert(case["id"].as_str().expect("validated case id")))
        {
            return Err(Failure::protocol("extension resolved duplicate case IDs"));
        }
        cases
            .iter()
            .find(|case| case["id"] == case_id)
            .cloned()
            .ok_or_else(|| Failure::invocation("extension did not resolve the selected case"))
    }

    pub fn prepare(&self, case: &Value, condition: &str) -> Result<Value> {
        self.exchange(
            "prepare",
            json!({
                "case":case,"host":{"id":self.host["id"],"capabilities":self.host["capabilities"]},
                "condition":condition,"configuration":self.configuration
            }),
        )
    }

    fn exchange(&self, method: &str, params: Value) -> Result<Value> {
        if method != "describe" {
            self.verify_sources(method)?;
        }
        let protocol = if method == "describe" {
            "sevro.discovery.v1"
        } else {
            PROTOCOL
        };
        let id = uuid::Uuid::new_v4().to_string();
        let request = json!({"protocol":protocol,"id":id,"method":method,"params":params});
        if !self.validator.is_valid(&request) {
            return Err(Failure::protocol("invalid extension request"));
        }
        let payload = serde_json::to_vec(&request).expect("JSON request is serializable");
        let bytes = transport::exchange_process(&self.command, &payload, &self.cancellation)?;
        // The v1 UTF-8 decoder consumes an initial byte-order mark before JSON parsing.
        let document = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        let response: Value = serde_json::from_slice(document)
            .map_err(|_| Failure::protocol("extension did not return one UTF-8 JSON response"))?;
        if !self.validator.is_valid(&response) || response.get("params").is_some() {
            return Err(Failure::protocol("invalid extension response"));
        }
        if response["protocol"] != protocol || response["id"] != id || response["method"] != method
        {
            return Err(Failure::protocol(
                "extension response does not match request",
            ));
        }
        if let Some(error) = response.get("error") {
            return Err(Failure::protocol(&format!(
                "extension reported {}",
                error["code"].as_str().expect("validated error code")
            )));
        }
        self.verify_sources(method)?;
        Ok(response["result"].clone())
    }

    fn verify_sources(&self, method: &str) -> Result<()> {
        if source_digest(&self.command, &self.source_files)? != self.source_digest {
            return Err(Failure::protocol(if method == "describe" {
                "extension source changed during discovery"
            } else {
                "extension source changed during run"
            }));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Description {
    extension: ExtensionIdentity,
    protocols: Vec<String>,
    required_capabilities: Vec<String>,
    optional_capabilities: Vec<String>,
    graders: Vec<String>,
    task_verdict_policies: Vec<String>,
}

#[derive(Deserialize)]
struct ExtensionIdentity {
    id: String,
    version: String,
}

fn negotiated_capabilities(description: &Description, host: &Value) -> Result<Vec<String>> {
    if !description
        .protocols
        .iter()
        .any(|protocol| protocol == PROTOCOL)
    {
        return Err(Failure::protocol("extension has no compatible protocol"));
    }
    let mut supported: BTreeSet<&str> = ENGINE_CAPABILITIES.into_iter().collect();
    supported.extend(
        host["capabilities"]
            .as_array()
            .expect("selected host capabilities are an array")
            .iter()
            .map(|item| {
                item.as_str()
                    .expect("selected host capabilities are strings")
            }),
    );
    for capability in &description.required_capabilities {
        if !supported.contains(capability.as_str()) {
            return Err(Failure::protocol(&format!(
                "unsupported required capability: {capability}"
            )));
        }
    }
    let mut capabilities = description.required_capabilities.clone();
    for capability in &description.optional_capabilities {
        if supported.contains(capability.as_str()) && !capabilities.contains(capability) {
            capabilities.push(capability.clone());
        }
    }
    Ok(capabilities)
}

fn load_command(path: &Path) -> Result<Vec<String>> {
    let bytes = fs::read(path)
        .map_err(|_| Failure::invocation("extension command file is unreadable or invalid"))?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Failure::invocation("extension command file is unreadable or invalid"))?;
    let command: Vec<String> = serde_json::from_value(value)
        .map_err(|_| Failure::invocation("extension command must be an absolute argv array"))?;
    if command.is_empty()
        || command.iter().any(String::is_empty)
        || !Path::new(&command[0]).is_absolute()
    {
        return Err(Failure::invocation(
            "extension command must be an absolute argv array",
        ));
    }
    Ok(command)
}

fn load_configuration(path: Option<&Path>, label: &str) -> Result<Value> {
    let Some(path) = path else {
        return Ok(json!({}));
    };
    let configuration: Value = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(|| Failure::invocation(&format!("{label} is unreadable or invalid")))?;
    Ok(configuration)
}

fn source_digest(command: &[String], sources: &[PathBuf]) -> Result<String> {
    // CLI selection requires sources and canonicalizes every path before opening a session.
    // Duplicates remain a session refusal after aliases have resolved to absolute paths.
    if sources.iter().collect::<BTreeSet<_>>().len() != sources.len() {
        return Err(Failure::protocol(
            "extension source files must be unique absolute paths",
        ));
    }
    let executable = PathBuf::from(&command[0]);
    let mut closure = vec![executable.clone()];
    closure.extend(sources.iter().filter(|path| **path != executable).cloned());
    let hashes: Vec<String> = closure
        .iter()
        .map(|path| {
            fs::read(path)
                .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
                .map_err(|_| Failure::protocol("declared extension source is unreadable"))
        })
        .collect::<Result<_>>()?;
    Ok(hash_json(&json!(hashes)))
}

fn hash_json(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_jcs::to_vec(value).expect("validated JSON is canonicalizable"))
    )
}
