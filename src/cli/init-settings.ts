import { join } from "node:path";
import { runtimeModule } from "../runner-paths";

export function templateSettings(template: string) {
  if (template === "repository-skill")
    return {
      "project-root": ".",
      "extension-command-file": "command.json",
      "extension-source-file": [
        "extension.ts",
        "extension-data.ts",
        ".agents/skills/startup-guide/SKILL.md",
      ].map(runtimeModule),
      "case-id": "repository-skill",
      host: "codex",
    };
  return {
    "case-file": "case.json",
    "adapter-module": runtimeModule("adapter.ts"),
    "project-root": ".",
    ...(template === "coding" ? { "shell-isolation": true } : {}),
  };
}

export function templateCommand(destination: string) {
  return [process.execPath, join(destination, runtimeModule("extension.ts"))];
}

export function nativeReadme() {
  return `# Repository skill evaluation\n\nThis template mounts the actual startup-guide skill and requires Codex's explicit invocation evidence plus assertions for the start command and port. Missing evidence remains not_assessed.\n\nPrerequisites: Node.js 24.13.0 or newer, or Bun 1.3.13, plus Git, Codex on PATH, supported native isolation (sandbox-exec on macOS or bubblewrap/socat on Linux), and a readable Codex authentication file. Choose the exact model and effort explicitly. Do not store credentials in run.json.\n\n\`\`\`sh\nsevro run --run-manifest-file run.json --model YOUR_MODEL --effort YOUR_EFFORT --codex-auth-file /absolute/auth.json --dry\nsevro run --run-manifest-file run.json --model YOUR_MODEL --effort YOUR_EFFORT --codex-auth-file /absolute/auth.json\nsevro report --latest\n\`\`\`\n\nDry preparation checks mounts and declarations without calling the model. No authenticated model execution or skill dispatch is established by dry preparation. Live execution may incur provider charges. To create a negative control, change the expected port in the extension data file to 9000 while leaving the fixture at 3000; rerun and inspect the failed port assertion. Model compliance and measurements are unknown until actually executed.\n\nEdit the copied skill and assertions, prepare again, then rerun the same model/effort/condition. Keep private .sevro evidence out of Git. command.json uses the initializer's absolute selected runtime and extension paths; regenerate it after moving this project.\n`;
}
