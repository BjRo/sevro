use super::preparation::Check;
use super::{RunError, RunResult};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
pub(super) enum PreparedOutput {
    #[default]
    Output,
    Regex(PreparedRegex),
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
}

impl GradingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRequested => "not_requested",
            Self::Completed => "completed",
            Self::Unavailable => "unavailable",
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
}

fn output_failure(check: &Check, message: &str) -> Option<&'static str> {
    match &check.prepared {
        PreparedOutput::Regex(regex) => return regex.failure(message),
        PreparedOutput::Output => {}
    }
    if check.configuration.get("validJson") == Some(&Value::Bool(true))
        && let Some(failure) = json_document_failure(message)
    {
        return Some(failure);
    }
    if let Some(pointer) = check.configuration.get("jsonPath").and_then(Value::as_str)
        && let Some(failure) = json_pointer_failure(message, pointer)
    {
        return Some(failure);
    }
    if check
        .configuration
        .get("expectExact")
        .is_some_and(|expected| expected.as_str() != Some(message))
    {
        return Some("exact output did not match");
    }
    None
}

fn json_pointer_failure(message: &str, pointer: &str) -> Option<&'static str> {
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
    None
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
) -> RunResult<Assessment> {
    let checks: Vec<_> = checks
        .iter()
        .map(|check| {
            let (status, detail) = match final_message.filter(|_| complete) {
                None => (CheckStatus::Unavailable, "output observation unavailable"),
                Some(message) => output_failure(check, message)
                    .map_or((CheckStatus::Passed, "ok"), |detail| {
                        (CheckStatus::Failed, detail)
                    }),
            };
            CheckResult {
                id: check.id.clone(),
                grader: check.grader.clone(),
                status,
                detail,
                evidence_refs: final_message
                    .map(|_| "sevro.observation.final-message")
                    .into_iter()
                    .collect(),
            }
        })
        .collect();
    let (grading, task) = if checks.is_empty() {
        (GradingStatus::NotRequested, TaskVerdict::NotAssessed)
    } else if checks
        .iter()
        .any(|check| check.status == CheckStatus::Unavailable)
    {
        (GradingStatus::Unavailable, TaskVerdict::NotAssessed)
    } else if checks
        .iter()
        .any(|check| check.status == CheckStatus::Failed)
    {
        (GradingStatus::Completed, TaskVerdict::Failed)
    } else {
        (GradingStatus::Completed, TaskVerdict::Passed)
    };
    Ok(Assessment {
        checks,
        metrics: Vec::new(),
        domain_outcomes: Vec::new(),
        grading,
        task,
    })
}
