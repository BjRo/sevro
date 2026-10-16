use super::super::{RunError, RunResult};
use rquickjs::{Context, Function, Runtime};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};

#[derive(Debug)]
pub(crate) struct SchemaFailure(String);

impl fmt::Display for SchemaFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl std::error::Error for SchemaFailure {}

#[derive(Default)]
pub(crate) struct SchemaPreparation {
    owner: Option<Arc<Owner>>,
}

impl SchemaPreparation {
    pub fn prepare(
        &mut self,
        configuration: &BTreeMap<String, Value>,
    ) -> RunResult<PreparedSchema> {
        for key in configuration.keys() {
            if !matches!(key.as_str(), "schema" | "exactDocument") {
                return Err(format!("unsupported check configuration: {key}").into());
            }
        }
        let schema = configuration
            .get("schema")
            .filter(|schema| schema.is_object())
            .ok_or("schema check requires an inline JSON Schema object")?;
        let exact_document = match configuration.get("exactDocument") {
            None => false,
            Some(value) => value.as_bool().ok_or("exactDocument must be boolean")?,
        };
        let source = serde_json::to_string(schema)
            .map_err(|error| RunError::with_source("invalid inline JSON Schema", error))?;
        let owner = match &self.owner {
            Some(owner) => Arc::clone(owner),
            None => {
                let owner = Owner::start()?;
                self.owner = Some(Arc::clone(&owner));
                owner
            }
        };
        let validator = owner
            .compile(source)
            .map_err(|error| RunError::with_source("invalid inline JSON Schema", error))?;
        Ok(PreparedSchema {
            owner,
            validator,
            exact_document,
        })
    }
}

pub(crate) struct PreparedSchema {
    owner: Arc<Owner>,
    validator: usize,
    exact_document: bool,
}

impl PreparedSchema {
    pub fn failure(&self, message: &str) -> Result<Option<&'static str>, SchemaFailure> {
        let Some((document, exact)) = super::json_document(message) else {
            return Ok(Some("output is not valid JSON"));
        };
        if self.exact_document && !exact {
            return Ok(Some("output is not exactly one JSON document"));
        }
        self.owner
            .validate(self.validator, document.to_owned())
            .map(|passed| (!passed).then_some("output did not match JSON Schema"))
    }
}

enum Request {
    Compile {
        schema: String,
        reply: mpsc::Sender<Result<usize, SchemaFailure>>,
    },
    Validate {
        validator: usize,
        document: String,
        reply: mpsc::Sender<Result<bool, SchemaFailure>>,
    },
}

struct Owner {
    requests: Option<mpsc::Sender<Request>>,
    thread: Option<JoinHandle<()>>,
}

impl Owner {
    fn start() -> RunResult<Arc<Self>> {
        let (requests, receiver) = mpsc::channel();
        let (ready, result) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("sevro-schema".to_owned())
            .spawn(move || run_owner(receiver, ready))
            .map_err(|error| RunError::with_source("schema runtime could not start", error))?;
        let owner = Arc::new(Self {
            requests: Some(requests),
            thread: Some(thread),
        });
        receive(result)
            .map_err(|error| RunError::with_source("schema runtime could not start", error))?;
        Ok(owner)
    }

    fn send(&self, request: Request) -> Result<(), SchemaFailure> {
        self.requests
            .as_ref()
            .ok_or_else(|| SchemaFailure("schema owner stopped".to_owned()))?
            .send(request)
            .map_err(|error| SchemaFailure(error.to_string()))
    }

    fn compile(&self, schema: String) -> Result<usize, SchemaFailure> {
        let (reply, result) = mpsc::channel();
        self.send(Request::Compile { schema, reply })?;
        receive(result)
    }

    fn validate(&self, validator: usize, document: String) -> Result<bool, SchemaFailure> {
        let (reply, result) = mpsc::channel();
        self.send(Request::Validate {
            validator,
            document,
            reply,
        })?;
        receive(result)
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        drop(self.requests.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn receive<T>(result: mpsc::Receiver<Result<T, SchemaFailure>>) -> Result<T, SchemaFailure> {
    result
        .recv()
        .map_err(|error| SchemaFailure(error.to_string()))?
}

fn run_owner(requests: mpsc::Receiver<Request>, ready: mpsc::Sender<Result<(), SchemaFailure>>) {
    let context = Runtime::new().and_then(|runtime| Context::full(&runtime));
    let context = match context {
        Ok(context) => context,
        Err(error) => {
            let _ = ready.send(Err(SchemaFailure(error.to_string())));
            return;
        }
    };
    context.with(|context| {
        let engine = Engine::new(&context);
        match engine {
            Ok(mut engine) => {
                if ready.send(Ok(())).is_ok() {
                    for request in requests {
                        engine.handle(request);
                    }
                }
            }
            Err(error) => {
                let _ = ready.send(Err(SchemaFailure(error.to_string())));
            }
        }
    });
}

struct Engine<'js> {
    compile: Function<'js>,
    take_warnings: Function<'js>,
    evaluate: Function<'js>,
    validators: Vec<Function<'js>>,
}

impl<'js> Engine<'js> {
    fn new(context: &rquickjs::Ctx<'js>) -> rquickjs::Result<Self> {
        context.eval::<(), _>(include_str!("../../../assets/schema/ajv-8.20.0.bundle.js"))?;
        context.eval::<(), _>(
            "globalThis.schemaWarnings = []; globalThis.console = {log(){}, warn(...args){schemaWarnings.push(args.join(' '));}, error(){}};",
        )?;
        Ok(Self {
            compile: context
                .eval("(raw) => new Ajv2020({strict:false}).compile(JSON.parse(raw))")?,
            take_warnings: context.eval("() => schemaWarnings.splice(0)")?,
            evaluate: context.eval("(validator, raw) => validator(JSON.parse(raw))")?,
            validators: Vec::new(),
        })
    }

    fn handle(&mut self, request: Request) {
        match request {
            Request::Compile { schema, reply } => {
                let compiled = self.compile.call((schema,));
                let warnings: rquickjs::Result<Vec<String>> = self.take_warnings.call(());
                let compiled = warnings
                    .and_then(|warnings| {
                        for warning in warnings {
                            eprintln!("{warning}");
                        }
                        compiled
                    })
                    .map(|validator| {
                        let id = self.validators.len();
                        self.validators.push(validator);
                        id
                    });
                let _ = reply.send(compiled.map_err(|error| SchemaFailure(error.to_string())));
            }
            Request::Validate {
                validator,
                document,
                reply,
            } => {
                let result = self
                    .validators
                    .get(validator)
                    .ok_or_else(|| SchemaFailure("unknown prepared schema".to_owned()))
                    .and_then(|validator| {
                        self.evaluate
                            .call((validator.clone(), document))
                            .map_err(|error| SchemaFailure(error.to_string()))
                    });
                let _ = reply.send(result);
            }
        }
    }
}
