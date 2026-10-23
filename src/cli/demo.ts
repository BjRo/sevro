import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./command";
import { InvocationError } from "./invocation";
import { displayFailure } from "./presentation";

/** Run the packaged deterministic case without inheriting a caller's project policy. */
export async function demoCommand(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  if (argv.some((arg) => arg !== "--json")) {
    displayFailure(
      new InvocationError("demo accepts only --json; run sevro demo --help"),
      json,
      64,
      "invalid demo invocation",
      "demo",
    );
    return;
  }
  let projectRoot: string;
  try {
    projectRoot = await mkdtemp(join(tmpdir(), "sevro-demo-"));
  } catch (cause) {
    displayFailure(
      new Error(
        `demo temporary project could not be created under ${tmpdir()}; set TMPDIR to a writable directory`,
        { cause },
      ),
      json,
      70,
      "demo preparation failed",
    );
    return;
  }
  await main(
    [
      "run",
      ...(json ? ["--json"] : []),
      "--case-file",
      join(import.meta.dir, "..", "..", "examples", "basic", "graded.json"),
      "--adapter-module",
      join(import.meta.dir, "..", "..", "examples", "basic", "host.ts"),
      "--project-root",
      projectRoot,
      "--results-root",
      join(process.cwd(), ".sevro", "results"),
    ],
    demoCleanup(projectRoot),
  );
}

function demoCleanup(projectRoot: string): () => Promise<void> {
  let attempted = false;
  return async () => {
    if (attempted) return;
    attempted = true;
    await rm(projectRoot, { recursive: true, force: true });
  };
}
