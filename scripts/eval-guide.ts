import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guideRoot, guideSources } from "./guide/fixture";

const temporary = await mkdtemp(join(tmpdir(), "sevro-guide-command-"));
try {
  const commandFile = join(temporary, "command.json");
  await writeFile(
    commandFile,
    JSON.stringify([
      process.execPath,
      join(guideRoot, "scripts/guide/extension.ts"),
    ]),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      join(guideRoot, "src/cli.ts"),
      "run",
      "--extension-command-file",
      commandFile,
      ...(await guideSources().then((paths) =>
        paths.flatMap((path) => ["--extension-source-file", path]),
      )),
      "--project-root",
      guideRoot,
      "--results-root",
      join(guideRoot, ".guide-results"),
      "--runner-checkout-root",
      guideRoot,
      "--condition",
      "passive",
      "--trials",
      "1",
      "--threshold",
      "1",
      "--shell-isolation",
      "--protected-root",
      guideRoot,
      ...Bun.argv.slice(2),
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  const interrupt = () => {
    child.kill("SIGINT");
  };
  const terminate = () => {
    child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    process.exitCode = await child.exited;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
