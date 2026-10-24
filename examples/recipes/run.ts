import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostArguments, recipeInputs, semanticArguments } from "./run-inputs";
import {
  runtimeFile,
  runtimePrerequisites,
  selectedOptions,
} from "./run-options";

const options = selectedOptions();
runtimePrerequisites(options.recipe);
const mode = options.dry ? "dry" : options.fail ? "fail" : "pass";
const state = resolve(
  ".sevro-recipes",
  options.recipe,
  options.route,
  options.goalsOnly ? "goals" : mode,
);
await mkdir(join(state, "project"), { recursive: true });
await mkdir(join(state, "config"), { recursive: true });
const root = await realpath(state);
const cli =
  process.env.SEVRO_RECIPE_CLI ??
  resolve(
    import.meta.dirname,
    import.meta.filename.endsWith(".ts")
      ? "../../src/cli.ts"
      : "../../src/cli.js",
  );
const args = [
  process.execPath,
  cli,
  "run",
  "--json",
  "--project-root",
  join(root, "project"),
  "--config-root",
  join(root, "config"),
  "--results-root",
  join(root, "results"),
  "--runtime-config-file",
  runtimeFile(options),
  "--condition",
  "passive",
  "--trials",
  "1",
  "--threshold",
  "1",
  "--shell-isolation",
  "--protected-root",
  import.meta.dirname,
  ...(await recipeInputs(options, root)),
  ...(await hostArguments(options, root)),
  ...(await semanticArguments(options, root)),
  ...(options.dry ? ["--dry"] : []),
];
const child = spawn(process.execPath, args.slice(1), {
  env: { ...process.env, SEVRO_RECIPE_FAIL: options.fail ? "1" : "0" },
  stdio: ["ignore", "pipe", "inherit"],
});
const [output, code] = await Promise.all([
  new Response(
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  ).text(),
  new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  }),
]);
await writeFile(join(root, "result.json"), output);
process.stderr.write(`Recipe result: ${join(root, "result.json")}\n`);
process.stdout.write(output);
process.exit(code);
