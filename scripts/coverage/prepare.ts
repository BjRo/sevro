import type { CoverageMapData } from "istanbul-lib-coverage";
import {
  cpSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  readdirSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createInstrumenter } from "istanbul-lib-instrument";
import { transformSync } from "@babel/core";
import transformTypescript from "@babel/plugin-transform-typescript";
import { productionSources } from "../typescript-inventory.mjs";

function git(command: string[], cwd: string) {
  const result = Bun.spawnSync(["git", ...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`Cannot isolate Git metadata: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

export function candidateFiles(repo: string) {
  return git(
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    repo,
  )
    .split("\0")
    .filter(
      (file) =>
        file &&
        !/^(?:\.git|node_modules|\.quality|\.guide-evals|\.worktrees)(?:\/|$)/.test(
          file,
        ),
    )
    .filter((file) => existsSync(join(repo, file)))
    .sort();
}

function snapshotIdentity(project: string, root: string, files: string[]) {
  const inputs = files.map((file) => ({
    file,
    sha256: createHash("sha256")
      .update(readFileSync(join(project, file)))
      .digest("hex"),
  }));
  const content = createHash("sha256")
    .update(JSON.stringify(inputs))
    .digest("hex");
  writeFileSync(
    join(root, "snapshot.json"),
    JSON.stringify({ content, inputs }, null, 2),
  );
  return content;
}

export function copySnapshot(repo: string, root: string) {
  const project = join(root, "project");
  const source = join(root, "source");
  git(["clone", "--no-hardlinks", "--no-checkout", repo, project], repo);
  git(["checkout", "--detach", git(["rev-parse", "HEAD"], repo)], project);
  for (const entry of readdirSync(project)) {
    if (entry !== ".git")
      rmSync(join(project, entry), { recursive: true, force: true });
  }
  const files = candidateFiles(repo);
  for (const file of files) {
    mkdirSync(dirname(join(project, file)), { recursive: true });
    cpSync(join(repo, file), join(project, file));
  }
  const content = snapshotIdentity(project, root, files);
  symlinkSync(join(repo, "node_modules"), join(project, "node_modules"));
  cpSync(join(repo, "src"), join(source, "src"), { recursive: true });
  const hooks = join(project, "scripts/coverage");
  writeFileSync(
    join(project, "bunfig.toml"),
    `[test]\npreload = [${JSON.stringify(join(hooks, "test-preload.ts"))}]\n`,
  );
  return { project, source, hooks, content };
}

function eraseTypes(
  instrumenter: ReturnType<typeof createInstrumenter>,
  code: string,
  path: string,
) {
  const input = instrumenter.lastSourceMap();
  const inputMap = inputSourceMap(input, path);
  const result = transformSync(code, {
    filename: path,
    configFile: false,
    babelrc: false,
    plugins: [transformTypescript],
    inputSourceMap: inputMap,
    sourceMaps: true,
  });
  if (!result?.map || !result.code)
    throw new Error(`Missing instrumentation map for ${path}`);
  return { code: result.code, map: result.map };
}

function inputSourceMap(
  input: ReturnType<ReturnType<typeof createInstrumenter>["lastSourceMap"]>,
  path: string,
) {
  return {
    ...input,
    version: Number(input.version),
    file: input.file ?? path,
    sourcesContent: input.sourcesContent ?? [readFileSync(path, "utf8")],
  };
}

function markBun(code: string, mappings: string) {
  if (!code.startsWith("#!"))
    return { code: `// @bun\n${code}`, mappings: `;${mappings}` };
  const newline = code.indexOf("\n");
  const lines = mappings.split(";");
  lines.splice(1, 0, "");
  return {
    code: `${code.slice(0, newline + 1)}// @bun\n${code.slice(newline + 1)}`,
    mappings: lines.join(";"),
  };
}

export function instrumentFile(
  path: string,
  target: string,
  capturePath: string,
) {
  const instrumenter = createInstrumenter({
    esModules: true,
    parserPlugins: ["typescript"],
    produceSourceMap: true,
    compact: false,
  });
  const code = instrumenter.instrumentSync(readFileSync(path, "utf8"), path);
  const transformed = eraseTypes(instrumenter, code, path);
  const marked = markBun(transformed.code, transformed.map.mappings);
  const map = {
    ...transformed.map,
    sources: [path],
    sourceRoot: "",
    mappings: marked.mappings,
  };
  const capture = JSON.stringify(capturePath);
  const hook = `\nimport ${capture};\n`;
  writeFileSync(
    target,
    marked.code +
      hook +
      "\n//# sourceMappingURL=data:application/json;base64," +
      Buffer.from(JSON.stringify(map)).toString("base64"),
  );
  return instrumenter.lastFileCoverage();
}

export function prepare(repo: string, root: string) {
  const files = productionSources(repo);
  const snapshot = copySnapshot(repo, root);

  const baseline: CoverageMapData = {};
  for (const file of files) {
    const path = join(snapshot.source, file);
    baseline[path] = instrumentFile(
      path,
      join(snapshot.project, file),
      join(snapshot.hooks, "capture.cjs"),
    );
  }
  const layout = createHash("sha256")
    .update(JSON.stringify(baseline))
    .digest("hex");
  writeFileSync(join(root, "baseline.json"), JSON.stringify(baseline));
  return { ...snapshot, baseline, layout };
}
