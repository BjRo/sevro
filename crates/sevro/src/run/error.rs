use std::error::Error;
use std::fmt;

pub(super) struct RunError {
    message: String,
    source: Option<Box<dyn Error + Send + Sync + 'static>>,
}

impl RunError {
    pub fn with_source(
        message: impl Into<String>,
        source: impl Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            message: message.into(),
            source: Some(Box::new(source)),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for RunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl fmt::Debug for RunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The underlying cause can include data deliberately omitted from diagnostics.
        formatter
            .debug_tuple("RunError")
            .field(&self.message)
            .finish()
    }
}

impl Error for RunError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source.as_deref().map(|source| source as &dyn Error)
    }
}

impl From<String> for RunError {
    fn from(message: String) -> Self {
        Self {
            message,
            source: None,
        }
    }
}

impl From<&str> for RunError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

impl From<std::io::Error> for RunError {
    fn from(source: std::io::Error) -> Self {
        Self::with_source(source.to_string(), source)
    }
}

impl From<serde_json::Error> for RunError {
    fn from(source: serde_json::Error) -> Self {
        Self::with_source(source.to_string(), source)
    }
}

impl From<jsonschema::ReferencingError> for RunError {
    fn from(source: jsonschema::ReferencingError) -> Self {
        Self::with_source(source.to_string(), source)
    }
}

impl From<jsonschema::ValidationError<'_>> for RunError {
    fn from(source: jsonschema::ValidationError<'_>) -> Self {
        Self::with_source(source.to_string(), source.to_owned())
    }
}
