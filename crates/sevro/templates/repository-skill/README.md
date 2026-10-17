# Repository skill evaluation

This template mounts the actual startup-guide skill and requires Codex's explicit invocation evidence plus assertions for the start command and port. Missing evidence remains not_assessed.

Prerequisites: Bun, Git, Codex on PATH, supported native isolation (sandbox-exec on macOS or bubblewrap/socat on Linux), and a readable Codex authentication file. Choose the exact model and effort explicitly. Do not store credentials in run.json.

```sh
sevro run --run-manifest-file run.json --model YOUR_MODEL --effort YOUR_EFFORT --codex-auth-file /absolute/auth.json --dry
sevro run --run-manifest-file run.json --model YOUR_MODEL --effort YOUR_EFFORT --codex-auth-file /absolute/auth.json
sevro report --latest
```

Dry preparation checks mounts and declarations without calling the model. No authenticated model execution or skill dispatch is established by dry preparation. Live execution may incur provider charges. To create a negative control, change the expected port in extension-data.ts to 9000 while leaving the fixture at 3000; rerun and inspect the failed port assertion. Model compliance and measurements are unknown until actually executed.

Edit the copied skill and assertions, prepare again, then rerun the same model/effort/condition. Keep private .sevro evidence out of Git. command.json uses the initializer's absolute Bun and extension paths; regenerate it after moving this project.
