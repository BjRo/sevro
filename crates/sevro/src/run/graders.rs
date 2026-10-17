use super::preparation::Check;
use super::{RunError, RunResult};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

mod git_head;
mod schema;
pub(super) use git_head::{
    Context as GitHeadContext, capture_base as capture_git_head_base, prepare as prepare_git_head,
};
pub(super) use schema::SchemaPreparation;

#[derive(Default)]
pub(super) enum PreparedOutput {
    #[default]
    Output,
    Json {
        contains: Option<PreparedSubset>,
    },
    OutputContains(PreparedSubset),
    Regex(PreparedRegex),
    Schema(schema::PreparedSchema),
    GitHead(git_head::Kind),
}

pub(super) enum PreparedSubset {
    Scalar(Value),
    Array(Vec<PreparedSubset>),
    Object(BTreeMap<String, PreparedSubset>),
    Regex(regress::Regex),
}

pub(super) fn prepare_subset(expected: &Value) -> RunResult<PreparedSubset> {
    match expected {
        Value::Array(values) => values
            .iter()
            .map(prepare_subset)
            .collect::<RunResult<Vec<_>>>()
            .map(PreparedSubset::Array),
        Value::Object(values) => {
            if values.len() == 1
                && let Some(pattern) = values.get("$regex")
            {
                let pattern = pattern.as_str().ok_or("invalid subset regex")?;
                return regress::Regex::from_unicode(
                    pattern.encode_utf16().map(u32::from),
                    regress::Flags::default(),
                )
                .map(PreparedSubset::Regex)
                .map_err(|error| RunError::with_source("invalid subset regex", error));
            }
            values
                .iter()
                .map(|(key, value)| Ok((key.clone(), prepare_subset(value)?)))
                .collect::<RunResult<BTreeMap<_, _>>>()
                .map(PreparedSubset::Object)
        }
        _ => Ok(PreparedSubset::Scalar(expected.clone())),
    }
}

pub(super) struct PreparedRegex {
    pattern: regress::Regex,
    negate: bool,
    unicode: bool,
    sticky: bool,
}

pub(super) fn prepare_regex(configuration: &BTreeMap<String, Value>) -> RunResult<PreparedRegex> {
    for key in configuration.keys() {
        if !matches!(key.as_str(), "pattern" | "negate" | "flags") {
            return Err(format!("unsupported check configuration: {key}").into());
        }
    }
    let pattern = configuration
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or("invalid regex check configuration")?;
    let negate = match configuration.get("negate") {
        None => false,
        Some(value) => value.as_bool().ok_or("invalid regex check configuration")?,
    };
    let flags = match configuration.get("flags") {
        None => "",
        Some(value) => value.as_str().ok_or("invalid regex pattern or flags")?,
    };
    let mut seen = BTreeSet::from(['m']);
    for flag in flags.chars() {
        if !matches!(flag, 'd' | 'g' | 'i' | 'm' | 's' | 'u' | 'v' | 'y') || !seen.insert(flag) {
            return Err("invalid regex pattern or flags".into());
        }
    }
    if seen.contains(&'u') && seen.contains(&'v') {
        return Err("invalid regex pattern or flags".into());
    }
    let unicode = seen.contains(&'u') || seen.contains(&'v');
    let engine_flags = regress::Flags {
        multiline: true,
        icase: seen.contains(&'i'),
        dot_all: seen.contains(&'s'),
        unicode,
        unicode_sets: seen.contains(&'v'),
        ..regress::Flags::default()
    };
    let pattern = if unicode {
        regress::Regex::from_unicode(pattern.chars().map(u32::from), engine_flags)
    } else {
        regress::Regex::from_unicode(pattern.encode_utf16().map(u32::from), engine_flags)
    }
    .map_err(|error| RunError::with_source("invalid regex pattern or flags", error))?;
    Ok(PreparedRegex {
        pattern,
        negate,
        unicode,
        sticky: seen.contains(&'y'),
    })
}

impl PreparedRegex {
    fn failure(&self, message: &str) -> Option<&'static str> {
        let units: Vec<_> = message.encode_utf16().collect();
        let found = if self.unicode {
            self.pattern.find_from_utf16(&units, 0).next()
        } else {
            self.pattern.find_from_ucs2(&units, 0).next()
        };
        let matched = found.is_some_and(|matched| !self.sticky || matched.start() == 0);
        (matched == self.negate).then_some("regex assertion failed")
    }
}

#[derive(Clone, Copy)]
pub(super) enum GradingStatus {
    NotRequested,
    Completed,
    Unavailable,
    Error,
}

impl GradingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRequested => "not_requested",
            Self::Completed => "completed",
            Self::Unavailable => "unavailable",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum TaskVerdict {
    NotAssessed,
    Passed,
    Failed,
}

impl TaskVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotAssessed => "not_assessed",
            Self::Passed => "passed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum CheckStatus {
    Passed,
    Failed,
    Unavailable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CheckResult {
    pub id: String,
    pub grader: String,
    pub status: CheckStatus,
    pub detail: &'static str,
    pub evidence_refs: Vec<&'static str>,
}

pub(super) struct Assessment {
    pub checks: Vec<CheckResult>,
    pub metrics: Vec<Value>,
    pub domain_outcomes: Vec<Value>,
    pub grading: GradingStatus,
    pub task: TaskVerdict,
    pub git_head: Option<git_head::State>,
}

impl Assessment {
    pub(super) fn error() -> Self {
        Self {
            checks: Vec::new(),
            metrics: Vec::new(),
            domain_outcomes: Vec::new(),
            grading: GradingStatus::Error,
            task: TaskVerdict::NotAssessed,
            git_head: None,
        }
    }
}

fn output_failure(check: &Check, message: &str) -> RunResult<Option<&'static str>> {
    let contains = match &check.prepared {
        PreparedOutput::GitHead(_) => return Err("Git HEAD check requires fixture context".into()),
        PreparedOutput::Regex(regex) => return Ok(regex.failure(message)),
        PreparedOutput::Schema(schema) => {
            return schema
                .failure(message)
                .map_err(|error| RunError::with_source("output grading did not complete", error));
        }
        PreparedOutput::Json { contains } => {
            if check.configuration.get("exactDocument") == Some(&Value::Bool(true))
                && let Some(failure) = json_document_failure(message)
            {
                return Ok(Some(failure));
            }
            return Ok(json_pointer_failure(
                message,
                check
                    .configuration
                    .get("pointer")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                check.configuration.get("equals"),
                contains.as_ref(),
            ));
        }
        PreparedOutput::Output => None,
        PreparedOutput::OutputContains(contains) => Some(contains),
    };
    if check.configuration.get("validJson") == Some(&Value::Bool(true))
        && let Some(failure) = json_document_failure(message)
    {
        return Ok(Some(failure));
    }
    if let Some(pointer) = check.configuration.get("jsonPath").and_then(Value::as_str)
        && let Some(failure) = json_pointer_failure(
            message,
            pointer,
            check.configuration.get("expectJson"),
            contains,
        )
    {
        return Ok(Some(failure));
    }
    if check
        .configuration
        .get("expectExact")
        .is_some_and(|expected| expected.as_str() != Some(message))
    {
        return Ok(Some("exact output did not match"));
    }
    Ok(None)
}

fn json_pointer_failure(
    message: &str,
    pointer: &str,
    expected: Option<&Value>,
    contains: Option<&PreparedSubset>,
) -> Option<&'static str> {
    let Some((document, _)) = json_document(message) else {
        return Some("output is not valid JSON");
    };
    let mut selected = document.trim();
    for token in pointer.split('/').skip(1) {
        let token = token.replace("~1", "/").replace("~0", "~");
        let member = if selected.starts_with('[') {
            array_element(selected, &token)
        } else {
            object_member(selected, &token)
        };
        let Some(member) = member else {
            return Some("JSON pointer does not resolve");
        };
        selected = member;
    }
    if expected.is_some_and(|expected| !json_equals(selected, expected)) {
        return Some("JSON value did not equal expectation");
    }
    contains
        .filter(|expected| {
            !array_members(selected).is_some_and(|members| {
                members
                    .into_iter()
                    .any(|member| json_subset(member, expected))
            })
        })
        .map(|_| "JSON array did not contain expected item")
}

fn json_subset(selected: &str, expected: &PreparedSubset) -> bool {
    match expected {
        PreparedSubset::Array(expected) => array_members(selected).is_some_and(|actual| {
            expected
                .iter()
                .all(|part| actual.iter().any(|item| json_subset(item, part)))
        }),
        PreparedSubset::Object(expected) => object_members(selected).is_some_and(|actual| {
            expected
                .iter()
                .all(|(key, part)| actual.get(key).is_some_and(|item| json_subset(item, part)))
        }),
        PreparedSubset::Scalar(expected) => json_equals(selected, expected),
        PreparedSubset::Regex(pattern) => json_string_units(selected)
            .is_some_and(|units| pattern.find_from_ucs2(&units, 0).next().is_some()),
    }
}

fn json_string_units(selected: &str) -> Option<Vec<u16>> {
    let mut characters = selected.strip_prefix('"')?.strip_suffix('"')?.chars();
    let mut units = Vec::new();
    while let Some(character) = characters.next() {
        if character != '\\' {
            units.extend_from_slice(character.encode_utf16(&mut [0; 2]));
            continue;
        }
        let unit = match characters.next()? {
            '"' => 34,
            '\\' => 92,
            '/' => 47,
            'b' => 8,
            'f' => 12,
            'n' => 10,
            'r' => 13,
            't' => 9,
            'u' => {
                let mut unit = 0;
                for _ in 0..4 {
                    unit = unit * 16 + u16::try_from(characters.next()?.to_digit(16)?).ok()?;
                }
                unit
            }
            _ => return None,
        };
        units.push(unit);
    }
    Some(units)
}

fn json_equals(selected: &str, expected: &Value) -> bool {
    let mut pending = vec![(selected, expected)];
    while let Some((selected, expected)) = pending.pop() {
        let equal = match expected {
            Value::Null => selected == "null",
            Value::Bool(expected) => selected == if *expected { "true" } else { "false" },
            Value::String(expected) => {
                serde_json::from_str::<String>(selected).ok().as_ref() == Some(expected)
            }
            Value::Number(expected) => expected.as_f64().is_some_and(|expected| {
                selected
                    .parse::<f64>()
                    .is_ok_and(|actual| actual.to_bits() == expected.to_bits())
            }),
            Value::Array(expected) => {
                let Some(actual) = array_members(selected) else {
                    return false;
                };
                if actual.len() != expected.len() {
                    return false;
                }
                pending.extend(actual.into_iter().zip(expected));
                true
            }
            Value::Object(expected) => {
                let Some(actual) = object_members(selected) else {
                    return false;
                };
                if actual.len() != expected.len() {
                    return false;
                }
                for (key, expected) in expected {
                    let Some(actual) = actual.get(key) else {
                        return false;
                    };
                    pending.push((*actual, expected));
                }
                true
            }
        };
        if !equal {
            return false;
        }
    }
    true
}

fn array_members(document: &str) -> Option<Vec<&str>> {
    let mut remaining = document.strip_prefix('[')?.trim_start();
    let mut members = Vec::new();
    while !remaining.starts_with(']') {
        let (value, rest) = raw_prefix(remaining)?;
        members.push(value);
        let Some(rest) = rest.trim_start().strip_prefix(',') else {
            break;
        };
        remaining = rest.trim_start();
    }
    Some(members)
}

fn object_members(document: &str) -> Option<BTreeMap<String, &str>> {
    let mut remaining = document.strip_prefix('{')?.trim_start();
    let mut members = BTreeMap::new();
    while !remaining.starts_with('}') {
        let (key, rest) = raw_prefix(remaining)?;
        let key = serde_json::from_str::<String>(key).ok()?;
        let rest = rest.trim_start().strip_prefix(':')?.trim_start();
        let (value, rest) = raw_prefix(rest)?;
        members.insert(key, value);
        let Some(rest) = rest.trim_start().strip_prefix(',') else {
            break;
        };
        remaining = rest.trim_start();
    }
    Some(members)
}

fn raw_prefix(text: &str) -> Option<(&str, &str)> {
    let mut values = serde_json::Deserializer::from_str(text).into_iter::<serde::de::IgnoredAny>();
    values.next()?.ok()?;
    Some(text.split_at(values.byte_offset()))
}

fn object_member<'a>(document: &'a str, token: &str) -> Option<&'a str> {
    let mut remaining = document.trim().strip_prefix('{')?.trim_start();
    let mut selected = None;
    while !remaining.starts_with('}') {
        let (key, rest) = raw_prefix(remaining)?;
        let rest = rest.trim_start().strip_prefix(':')?.trim_start();
        let (value, rest) = raw_prefix(rest)?;
        if serde_json::from_str::<String>(key).ok().as_deref() == Some(token) {
            if selected.is_some() {
                return None;
            }
            selected = Some(value);
        }
        let Some(rest) = rest.trim_start().strip_prefix(',') else {
            break;
        };
        remaining = rest.trim_start();
    }
    selected
}

fn array_element<'a>(document: &'a str, token: &str) -> Option<&'a str> {
    let index: usize = token.parse().ok()?;
    if index.to_string() != token {
        return None;
    }
    let mut remaining = document.strip_prefix('[')?.trim_start();
    for _ in 0..index {
        let (_, rest) = raw_prefix(remaining)?;
        remaining = rest.trim_start().strip_prefix(',')?.trim_start();
    }
    let (value, _) = raw_prefix(remaining)?;
    Some(value)
}

fn json_document_failure(message: &str) -> Option<&'static str> {
    match json_document(message) {
        None => Some("output is not valid JSON"),
        Some((_, false)) => Some("output is not exactly one JSON document"),
        Some((_, true)) => None,
    }
}

fn json_document(message: &str) -> Option<(&str, bool)> {
    if serde_json::from_str::<serde::de::IgnoredAny>(message).is_ok() {
        return Some((message, true));
    }
    let (fence, json, remaining) = next_json_fence(message)?;
    if next_json_fence(remaining).is_some()
        || serde_json::from_str::<serde::de::IgnoredAny>(json).is_err()
    {
        return None;
    }
    let trimmed = message.trim_matches(|character: char| {
        (character.is_whitespace() && character != '\u{85}') || character == '\u{feff}'
    });
    Some((json, trimmed == fence))
}

fn next_json_fence(mut text: &str) -> Option<(&str, &str, &str)> {
    while let Some(start) = text.find("```") {
        let candidate = &text[start..];
        text = &candidate[1..];
        let (language, body) = candidate[3..].split_once('\n')?;
        let language = language.strip_suffix('\r').unwrap_or(language);
        if !language
            .trim_end_matches([' ', '\t'])
            .eq_ignore_ascii_case("json")
        {
            continue;
        }
        let end = body.find("\n```")?;
        let length = candidate.len() - body.len() + end + 4;
        return Some((&candidate[..length], &body[..end], &candidate[length..]));
    }
    None
}

pub(super) fn evaluate(
    checks: &[Check],
    final_message: Option<&str>,
    complete: bool,
    context: GitHeadContext<'_>,
) -> RunResult<Assessment> {
    let mut results: Vec<_> = checks
        .iter()
        .filter(|check| !matches!(check.prepared, PreparedOutput::GitHead(_)))
        .map(|check| {
            let (status, detail) = match final_message.filter(|_| complete) {
                None => (CheckStatus::Unavailable, "output observation unavailable"),
                Some(message) => output_failure(check, message)?
                    .map_or((CheckStatus::Passed, "ok"), |detail| {
                        (CheckStatus::Failed, detail)
                    }),
            };
            Ok(CheckResult {
                id: check.id.clone(),
                grader: check.grader.clone(),
                status,
                detail,
                evidence_refs: final_message
                    .map(|_| "sevro.observation.final-message")
                    .into_iter()
                    .collect(),
            })
        })
        .collect::<RunResult<_>>()?;
    let git_head = context.observe(checks)?;
    if let Some(state) = &git_head {
        for check in checks {
            if let PreparedOutput::GitHead(kind) = check.prepared {
                results.push(state.check(check, kind));
            }
        }
    }
    results.sort_by_key(|result| checks.iter().position(|check| check.id == result.id));
    let checks = results;
    let grading = if checks.is_empty() {
        GradingStatus::NotRequested
    } else if checks
        .iter()
        .any(|check| check.status == CheckStatus::Unavailable)
    {
        GradingStatus::Unavailable
    } else {
        GradingStatus::Completed
    };
    let task = if checks
        .iter()
        .any(|check| check.status == CheckStatus::Failed)
    {
        TaskVerdict::Failed
    } else if matches!(grading, GradingStatus::Completed) {
        TaskVerdict::Passed
    } else {
        TaskVerdict::NotAssessed
    };
    Ok(Assessment {
        checks,
        metrics: Vec::new(),
        domain_outcomes: Vec::new(),
        grading,
        task,
        git_head,
    })
}
