use super::{RunError, RunResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

static REQUIRED_EVIDENCE_ID: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    jsonschema::draft202012::options()
        .build(&json!({"pattern":"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$"}))
        .expect("required-evidence identifier pattern is valid")
});

#[derive(Deserialize, Serialize)]
pub(super) struct Check {
    pub id: String,
    pub grader: String,
    pub configuration: BTreeMap<String, Value>,
    #[serde(skip)]
    pub prepared: super::graders::PreparedOutput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreparedCase {
    pub id: String,
    pub prompt: String,
    pub follow_up_prompt: Option<String>,
    pub fixture: FixtureDeclaration,
    pub checks: Vec<Check>,
    pub required_evidence: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureInput {
    kind: Option<String>,
    files: Option<BTreeMap<String, String>>,
    source_ref: Option<String>,
    staged: Option<Vec<String>>,
    hooks: Option<BTreeMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(try_from = "Value")]
pub(super) enum FixtureDeclaration {
    Generated(super::fixtures::GeneratedFixture),
    Inline {
        files: BTreeMap<String, String>,
    },
    Repository {
        source_ref: String,
        files: Option<BTreeMap<String, String>>,
        staged: Option<Vec<String>>,
        hooks: Option<BTreeMap<String, String>>,
    },
}

impl TryFrom<Value> for FixtureDeclaration {
    type Error = RunError;

    fn try_from(value: Value) -> RunResult<Self> {
        if value.get("kind").and_then(Value::as_str) == Some("generated") {
            return serde_json::from_value(value)
                .map(Self::Generated)
                .map_err(|error| RunError::with_source("invalid generated fixture", error));
        }
        let input: FixtureInput = serde_json::from_value(value)
            .map_err(|error| RunError::with_source(error.to_string(), error))?;
        Self::try_from(input)
    }
}

impl TryFrom<FixtureInput> for FixtureDeclaration {
    type Error = RunError;

    fn try_from(input: FixtureInput) -> RunResult<Self> {
        if let Some(source_ref) = input.source_ref {
            if source_ref.is_empty()
                || input
                    .kind
                    .as_deref()
                    .is_some_and(|kind| kind != "repository")
            {
                return Err("invalid repository fixture".into());
            }
            return Ok(Self::Repository {
                source_ref,
                files: input.files,
                staged: input.staged,
                hooks: input.hooks,
            });
        }
        if input.kind.as_deref().is_some_and(|kind| kind != "inline") {
            return Err("unsupported fixture kind".into());
        }
        let files = input.files.ok_or("inline fixture requires files")?;
        for path in files.keys() {
            fixture_path(path)?;
        }
        Ok(Self::Inline { files })
    }
}

impl PreparedCase {
    pub fn read(path: &Path) -> RunResult<Self> {
        let bytes = fs::read(path).map_err(|error| {
            RunError::with_source(
                format!("cannot read case file {}: {error}", path.display()),
                error,
            )
        })?;
        let mut value: Value = serde_json::from_slice(&bytes)
            .map_err(|error| RunError::with_source(format!("invalid case file: {error}"), error))?;
        if let Some(issue) = direct_case_issue(&value) {
            return Err(invalid_case_file(path, &issue).into());
        }
        if let Some(fixture) = value.get_mut("fixture").and_then(Value::as_object_mut)
            && !fixture.contains_key("kind")
            && !fixture.contains_key("sourceRef")
        {
            fixture.retain(|key, _| key == "files");
        }
        Self::from_value_at(value, Some(path))
    }

    pub fn from_value(value: Value) -> RunResult<Self> {
        Self::from_value_at(value, None)
    }

    fn from_value_at(value: Value, path: Option<&Path>) -> RunResult<Self> {
        let mut case: Self = serde_json::from_value(value)
            .map_err(|error| RunError::with_source(format!("invalid case file: {error}"), error))?;
        let validation = match &case.fixture {
            FixtureDeclaration::Generated(fixture) => fixture.validate(),
            FixtureDeclaration::Repository {
                files,
                staged,
                hooks,
                ..
            } => super::fixtures::validate_repository_fixture(
                files.as_ref(),
                staged.as_deref().unwrap_or_default(),
                hooks.as_ref(),
            ),
            _ => Ok(()),
        };
        validation.map_err(|error| {
            let issue = format!("fixture: {error}; correct the fixture declaration");
            let message = match path {
                Some(path) => invalid_case_file(path, &issue),
                None => format!("invalid resolved case file: {issue}"),
            };
            RunError::with_source(message, error)
        })?;
        if case.id.is_empty() || case.prompt.is_empty() {
            return Err("case id and prompt must be nonempty strings".into());
        }
        if case
            .follow_up_prompt
            .as_ref()
            .is_some_and(|prompt| prompt.trim().is_empty())
        {
            return Err("followUpPrompt must be a nonblank string".into());
        }
        let mut required_evidence = BTreeSet::new();
        if case
            .required_evidence
            .iter()
            .any(|id| !required_evidence.insert(id) || !REQUIRED_EVIDENCE_ID.is_valid(&json!(id)))
        {
            return Err("invalid required evidence IDs".into());
        }
        let mut ids = BTreeSet::new();
        let mut schemas = super::graders::SchemaPreparation::default();
        for check in &mut case.checks {
            if check.id.is_empty() {
                return Err("duplicate or empty check ID: ".into());
            }
            if !ids.insert(&check.id) {
                return Err("case check IDs must be unique".into());
            }
            if check.grader == "sevro.git-head" {
                let prepared = super::graders::prepare_git_head(&check.configuration)?;
                if matches!(case.fixture, FixtureDeclaration::Inline { .. }) {
                    return Err("Git HEAD checks require a Git fixture".into());
                }
                check.prepared = super::graders::PreparedOutput::GitHead(prepared);
                continue;
            }
            if check.grader == "sevro.regex" {
                check.prepared = super::graders::PreparedOutput::Regex(
                    super::graders::prepare_regex(&check.configuration)?,
                );
                continue;
            }
            if check.grader == "sevro.schema" {
                check.prepared =
                    super::graders::PreparedOutput::Schema(schemas.prepare(&check.configuration)?);
                continue;
            }
            if check.grader == "sevro.json" {
                for (key, value) in &check.configuration {
                    match key.as_str() {
                        "pointer" => validate_json_pointer(value)?,
                        "equals" | "contains" => {}
                        "exactDocument" => {
                            if !value.is_boolean() {
                                return Err("exactDocument must be boolean".into());
                            }
                        }
                        _ => return Err(format!("unsupported check configuration: {key}").into()),
                    }
                }
                check.prepared = super::graders::PreparedOutput::Json {
                    contains: check
                        .configuration
                        .get("contains")
                        .map(super::graders::prepare_subset)
                        .transpose()?,
                };
                continue;
            }
            if check.grader != "sevro.output" {
                if path.is_some()
                    && !matches!(
                        check.grader.as_str(),
                        "sevro.regex"
                            | "sevro.json"
                            | "sevro.schema"
                            | "sevro.shell"
                            | "sevro.git-head"
                            | "sevro.semantic"
                    )
                {
                    return Err("case declares an unavailable extension grader".into());
                }
                return Err(format!(
                    "grader preparation is not yet supported in Rust: {}",
                    check.grader
                )
                .into());
            }
            for (key, value) in &check.configuration {
                match key.as_str() {
                    "expectJson" | "containsJson" => {}
                    "expectExact" => {
                        if !value.is_string() {
                            return Err("expectExact must be a string".into());
                        }
                    }
                    "validJson" => {
                        if !value.is_boolean() {
                            return Err("validJson must be a boolean".into());
                        }
                    }
                    "jsonPath" => {
                        validate_json_pointer(value)?;
                    }
                    _ => {
                        return Err(format!(
                            "output check configuration is not yet supported in Rust: {key}"
                        )
                        .into());
                    }
                }
            }
            if (check.configuration.contains_key("expectJson")
                || check.configuration.contains_key("containsJson"))
                && !check.configuration.contains_key("jsonPath")
            {
                return Err("JSON expectations require a pointer".into());
            }
            if let Some(contains) = check.configuration.get("containsJson") {
                check.prepared = super::graders::PreparedOutput::OutputContains(
                    super::graders::prepare_subset(contains)?,
                );
            }
        }
        Ok(case)
    }
}

fn validate_json_pointer(value: &Value) -> RunResult<()> {
    let pointer = value.as_str().ok_or("JSON pointer must be a string")?;
    if (!pointer.is_empty() && !pointer.starts_with('/'))
        || pointer
            .split('~')
            .skip(1)
            .any(|escape| !escape.starts_with('0') && !escape.starts_with('1'))
    {
        return Err("invalid JSON pointer".into());
    }
    Ok(())
}

fn invalid_case_file(path: &Path, issue: &str) -> String {
    format!(
        "resolved case file is unreadable or invalid at {}: invalid resolved case file: {issue}; supply --case-file with readable JSON and correct the named field",
        path.display()
    )
}

fn direct_case_issue(value: &Value) -> Option<String> {
    if value
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(str::is_empty)
    {
        return Some("id: expected a nonempty string".into());
    }
    if !value
        .get("prompt")
        .and_then(Value::as_str)
        .is_some_and(|prompt| !prompt.is_empty())
    {
        return Some("prompt: expected a nonempty string".into());
    }
    if value.get("followUpPrompt").is_some_and(|prompt| {
        prompt
            .as_str()
            .is_none_or(|prompt| prompt.trim().is_empty())
    }) {
        return Some("followUpPrompt: omit or supply a nonblank string".into());
    }
    if !value.get("fixture").is_some_and(Value::is_object) {
        return Some("fixture: expected an object".into());
    }
    if value
        .pointer("/fixture/kind")
        .is_some_and(|kind| kind != "generated")
    {
        return Some("fixture.kind: omit for inline/repository fixtures, or use generated".into());
    }
    if (value.pointer("/fixture/kind").and_then(Value::as_str) == Some("generated")
        || value
            .pointer("/fixture/sourceRef")
            .and_then(Value::as_str)
            .is_some_and(|source| !source.is_empty()))
        && value.pointer("/fixture/hooks").is_some_and(|hooks| {
            hooks
                .as_object()
                .is_none_or(|entries| entries.values().any(|content| !content.is_string()))
        })
    {
        return Some("fixture: invalid fixture hooks; correct the fixture declaration".into());
    }
    if value.pointer("/fixture/kind").and_then(Value::as_str) == Some("generated")
        && ["files", "staged", "commitFiles"]
            .iter()
            .any(|field| value["fixture"].get(field).is_some_and(Value::is_null))
    {
        return Some("fixture: invalid generated fixture; correct the fixture declaration".into());
    }
    if value
        .pointer("/fixture/sourceRef")
        .is_some_and(Value::is_null)
        || (value.pointer("/fixture/sourceRef").is_some()
            && value.pointer("/fixture/staged").is_some_and(Value::is_null))
    {
        return Some("fixture: invalid repository fixture; correct the fixture declaration".into());
    }
    if let Some(fixture) = value.get("fixture").and_then(Value::as_object)
        && !fixture.contains_key("kind")
        && !fixture.contains_key("sourceRef")
    {
        let Some(files) = fixture.get("files").and_then(Value::as_object) else {
            return Some(
                "fixture.files: expected an object mapping file paths to string contents".into(),
            );
        };
        if let Some((path, _)) = files.iter().find(|(_, content)| !content.is_string()) {
            return Some(format!(
                "fixture.files[{}]: expected string contents",
                json!(path)
            ));
        }
    }
    if value
        .as_object()
        .is_some_and(|case| !case.contains_key("checks"))
    {
        return Some("checks: expected an array of check objects".into());
    }
    if let Some(checks) = value.get("checks").and_then(Value::as_array) {
        for (index, check) in checks.iter().enumerate() {
            if check.get("configuration").is_some_and(Value::is_null) {
                return Some(format!("checks[{index}].configuration: expected an object"));
            }
        }
    }
    None
}

pub(super) fn fixture_path(path: &str) -> RunResult<()> {
    if path.is_empty()
        || path.contains(['\\', ':', '\0'])
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!("invalid fixture path: {path}").into());
    }
    Ok(())
}
