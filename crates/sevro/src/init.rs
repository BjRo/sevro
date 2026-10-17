use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const RESPONSE_FILES: &[(&str, &str)] = &[
    (
        "adapter.ts",
        include_str!("../templates/response/adapter.ts.txt"),
    ),
    ("case.json", include_str!("../templates/response/case.json")),
    ("README.md", include_str!("../templates/response/README.md")),
    (".gitignore", ".sevro/\n"),
    (
        "run.json",
        "{\n  \"format\": \"sevro.run.v1\",\n  \"settings\": {\n    \"case-file\": \"case.json\",\n    \"adapter-module\": \"adapter.ts\",\n    \"project-root\": \".\"\n  }\n}\n",
    ),
];

const CODING_FILES: &[(&str, &str)] = &[
    (
        "adapter.ts",
        include_str!("../templates/coding/adapter.ts.txt"),
    ),
    ("case.json", include_str!("../templates/coding/case.json")),
    ("README.md", include_str!("../templates/coding/README.md")),
    (".gitignore", ".sevro/\n"),
    (
        "run.json",
        "{\n  \"format\": \"sevro.run.v1\",\n  \"settings\": {\n    \"case-file\": \"case.json\",\n    \"adapter-module\": \"adapter.ts\",\n    \"project-root\": \".\",\n    \"shell-isolation\": true\n  }\n}\n",
    ),
];

const REPOSITORY_FILES: &[(&str, &str)] = &[
    (
        "extension.ts",
        include_str!("../templates/repository-skill/extension.ts.txt"),
    ),
    (
        "extension-data.ts",
        include_str!("../templates/repository-skill/extension-data.ts.txt"),
    ),
    (
        ".agents/skills/startup-guide/SKILL.md",
        include_str!("../templates/repository-skill/SKILL.md"),
    ),
    (
        "README.md",
        include_str!("../templates/repository-skill/README.md"),
    ),
    (
        "run.json",
        include_str!("../templates/repository-skill/run.json"),
    ),
    (".gitignore", ".sevro/\n"),
];

fn destination(args: &[String]) -> Result<(String, PathBuf), String> {
    let mut template = "response";
    let mut directory = "sevro-evaluation";
    let mut position = 0;
    while position < args.len() {
        if args[position] == "--" && position + 1 == args.len() {
            break;
        }
        let (name, value) = if let Some((name, value)) = args[position].split_once('=') {
            position += 1;
            (name, value)
        } else {
            let name = args[position].as_str();
            let value = args.get(position + 1).ok_or_else(|| {
                format!("option {name} requires an argument; run sevro init --help")
            })?;
            if value.starts_with('-') && value.len() > 1 {
                return Err(format!(
                    "option {name} requires an unambiguous argument; use {name}=VALUE or run sevro init --help"
                ));
            }
            position += 2;
            (name, value.as_str())
        };
        match name {
            "--template" => template = value,
            "--directory" => directory = value,
            _ => {
                return Err(
                    "use --template response, coding or repository-skill; run sevro init --help"
                        .into(),
                );
            }
        }
    }
    if !["response", "coding", "repository-skill"].contains(&template) {
        return Err(
            "use --template response, coding or repository-skill; run sevro init --help".into(),
        );
    }
    if directory.trim().is_empty() {
        return Err("--directory must name a new directory".into());
    }
    let path = std::env::current_dir()
        .map_err(|error| error.to_string())?
        .join(directory);
    let mut destination = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                destination.pop();
            }
            other => destination.push(other.as_os_str()),
        }
    }
    Ok((template.to_owned(), destination))
}

fn write_file(path: &Path, content: &str) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("invalid template file path")?)
        .map_err(|error| error.to_string())?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(content.as_bytes()))
        .map_err(|error| error.to_string())
}

fn repository_command(destination: &Path) -> Result<String, String> {
    let output = Command::new("bun")
        .args(["--print", "process.execPath"])
        .output()
        .map_err(|_| "repository-skill initialization requires Bun on PATH".to_owned())?;
    let executable = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() || !Path::new(&executable).is_absolute() {
        return Err("repository-skill initialization requires Bun on PATH".into());
    }
    let command = serde_json::json!([executable, destination.join("extension.ts")]);
    Ok(format!("{command}\n"))
}

fn write_template(template: &str, destination: &Path) -> Result<(), String> {
    let files = match template {
        "coding" => CODING_FILES,
        "repository-skill" => REPOSITORY_FILES,
        _ => RESPONSE_FILES,
    };
    for (name, content) in files {
        write_file(&destination.join(name), content)?;
    }
    if template == "repository-skill" {
        write_file(
            &destination.join("command.json"),
            &repository_command(destination)?,
        )?;
    }
    Ok(())
}

fn initialize(args: &[String]) -> Result<(String, PathBuf), String> {
    let (template, destination) = destination(args)?;
    let parent = destination.parent().ok_or("invalid init destination")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    fs::create_dir(&destination).map_err(|_| {
        format!(
            "init destination already exists or cannot be created: {}; choose a new --directory",
            destination.display()
        )
    })?;
    if let Err(error) = write_template(&template, &destination) {
        let _ = fs::remove_dir_all(&destination);
        return Err(error);
    }
    Ok((template, destination))
}

pub fn command(args: &[String]) -> i32 {
    match initialize(args) {
        Ok((template, destination)) => {
            let native = if template == "repository-skill" {
                " --model YOUR_MODEL --effort YOUR_EFFORT --codex-auth-file /absolute/auth.json"
            } else {
                ""
            };
            println!(
                "Created {template} evaluation at {}\nOpen README.md, then:\n  cd '{}'\n  sevro run --run-manifest-file run.json{native} --dry\n  sevro run --run-manifest-file run.json{native}",
                destination.display(),
                destination.display().to_string().replace('\'', "'\\''")
            );
            0
        }
        Err(message) => {
            eprintln!("sevro: {message}");
            64
        }
    }
}
