use super::ReportResult;
use jsonschema::{Registry, Validator};
use serde_json::{Value, json};

pub(super) struct Validators {
    result: Validator,
    evidence: Validator,
    report: Validator,
}

impl Validators {
    pub(super) fn new() -> ReportResult<Self> {
        let schemas = [
            (
                "urn:sevro:schema:cli-result:v1",
                include_str!("../../../../schemas/cli-result-v1.schema.json"),
            ),
            (
                "urn:sevro:schema:run-evidence:v1",
                include_str!("../../../../schemas/run-evidence-v1.schema.json"),
            ),
            (
                "urn:sevro:schema:report:v1",
                include_str!("../../../../schemas/report-v1.schema.json"),
            ),
        ];
        let mut registry = Registry::new();
        for (id, content) in schemas {
            let schema: Value = serde_json::from_str(content).map_err(|error| error.to_string())?;
            registry = registry
                .add(id, schema)
                .map_err(|error| error.to_string())?;
        }
        let registry = registry.prepare().map_err(|error| error.to_string())?;
        let compile = |id: &str| {
            jsonschema::draft202012::options()
                .with_registry(&registry)
                .build(&json!({"$ref":id}))
                .map_err(|error| error.to_string())
        };
        Ok(Self {
            result: compile("urn:sevro:schema:cli-result:v1")?,
            evidence: compile("urn:sevro:schema:run-evidence:v1")?,
            report: compile("urn:sevro:schema:report:v1")?,
        })
    }

    pub(super) fn result(&self, value: &Value) -> ReportResult<()> {
        validate(&self.result, value, "invalid Sevro CLI result")
    }

    pub(super) fn evidence(&self, value: &Value) -> ReportResult<()> {
        validate(&self.evidence, value, "invalid Sevro run evidence")
    }

    pub(super) fn report(&self, value: &Value) -> ReportResult<()> {
        validate(&self.report, value, "invalid Sevro report")
    }
}

fn validate(validator: &Validator, value: &Value, message: &str) -> ReportResult<()> {
    if validator.is_valid(value) {
        Ok(())
    } else {
        Err(message.into())
    }
}
