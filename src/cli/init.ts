import { examplePath, sourceRuntime } from "../runner-paths";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  nativeReadme,
  templateCommand,
  templateSettings,
} from "./init-settings";

function initOptions(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      template: { type: "string", default: "response" },
      directory: { type: "string", default: "sevro-evaluation" },
    },
  });
  if (
    positionals.length ||
    !["response", "coding", "repository-skill"].includes(values.template)
  )
    throw new Error(
      "use --template response, coding or repository-skill; run sevro init --help",
    );
  if (!values.directory.trim())
    throw new Error("--directory must name a new directory");
  return { template: values.template, destination: resolve(values.directory) };
}

async function reserveDirectory(destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await mkdir(destination);
  } catch (cause) {
    throw new Error(
      `init destination already exists or cannot be created: ${destination}; choose a new --directory`,
      { cause },
    );
  }
}

function starterReadme(template: string) {
  if (template === "repository-skill") return nativeReadme();
  const assertion =
    template === "coding"
      ? "positive, negative and zero addition assertions against edited add.sh"
      : "an exact response assertion";
  const prerequisites =
    template === "coding"
      ? "Node.js 24.13.0 or newer, or Bun 1.3.13, plus sandbox-exec on macOS or bubblewrap/socat on Linux"
      : "Node.js 24.13.0 or newer, or Bun 1.3.13";
  return `# ${template} evaluation\n\nThis deterministic adapter exercises ${assertion}, without model credentials. Prerequisites: ${prerequisites}.\n\n\`\`\`sh\nsevro run --run-manifest-file run.json --dry\nsevro run --run-manifest-file run.json\nsevro report --latest\nSEVRO_TEMPLATE_FAIL=1 sevro run --run-manifest-file run.json\n\`\`\`\n\nThe negative control must report task=failed and exit 1. Dry preparation is not an assessment.\nEdit case.json and ${sourceRuntime ? "adapter.ts" : "adapter.js"}, prepare, then run again. Keep private .sevro evidence out of Git.\nFor a native model, replace the adapter route explicitly with --host, --model and --effort; Codex also requires --codex-auth-file. No model execution or native skill dispatch is established by this adapter.\n`;
}

async function initialize(template: string, destination: string) {
  await reserveDirectory(destination);
  try {
    await cp(examplePath("templates", template), destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await writeFile(
      join(destination, "run.json"),
      JSON.stringify(
        { format: "sevro.run.v1", settings: templateSettings(template) },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    if (template === "repository-skill")
      await writeFile(
        join(destination, "command.json"),
        JSON.stringify(templateCommand(destination)) + "\n",
        { flag: "wx" },
      );
    await writeFile(join(destination, ".gitignore"), ".sevro/\n", {
      flag: "wx",
    });
    await writeFile(join(destination, "README.md"), starterReadme(template), {
      flag: "wx",
    });
  } catch (cause) {
    await rm(destination, { recursive: true, force: true });
    throw cause;
  }
}

export async function initCommand(argv: string[]): Promise<number> {
  try {
    const { template, destination } = initOptions(argv);
    await initialize(template, destination);
    const quoted = `'${destination.replaceAll("'", "'\\''")}'`;
    const native =
      template === "repository-skill"
        ? " --model YOUR_MODEL --effort YOUR_EFFORT --codex-auth-file /absolute/auth.json"
        : "";
    process.stdout.write(
      `Created ${template} evaluation at ${destination}\nOpen README.md, then:\n  cd ${quoted}\n  sevro run --run-manifest-file run.json${native} --dry\n  sevro run --run-manifest-file run.json${native}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `sevro: ${error instanceof Error ? error.message : "initialization failed"}\n`,
    );
    return 64;
  }
}
