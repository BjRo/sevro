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

/** @param {string[]} command @param {string} cwd */
function git(command, cwd) {
  const result = Bun.spawnSync(["git", ...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`Cannot isolate Git metadata: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** @param {string} repo */
export function candidateFiles(repo) {
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

/** @param {string} project @param {string} root @param {string[]} files */
function snapshotIdentity(project, root, files) {
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

/** @param {string} repo @param {string} root */
export function copySnapshot(repo, root) {
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

/** @param {ReturnType<typeof createInstrumenter>} instrumenter @param {string} code @param {string} path */
function eraseTypes(instrumenter, code, path) {
  const input = instrumenter.lastSourceMap();
  const inputMap = inputSourceMap(input, path);
  const result = path.endsWith(".ts")
    ? transformSync(code, {
        filename: path,
        configFile: false,
        babelrc: false,
        plugins: [transformTypescript],
        inputSourceMap: inputMap,
        sourceMaps: true,
      })
    : { code, map: inputMap };
  if (!result?.map || !result.code)
    throw new Error(`Missing instrumentation map for ${path}`);
  return { code: result.code, map: result.map };
}

/** @param {ReturnType<ReturnType<typeof createInstrumenter>['lastSourceMap']>} input @param {string} path */
function inputSourceMap(input, path) {
  return {
    ...input,
    version: Number(input.version),
    file: input.file ?? path,
    sourcesContent: input.sourcesContent ?? [readFileSync(path, "utf8")],
  };
}

/** @param {string} code @param {string} mappings */
function markBun(code, mappings) {
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

/** @param {string} path @param {string} target @param {string} capturePath */
export function instrumentFile(path, target, capturePath) {
  const esModules = path.endsWith(".ts");
  const instrumenter = createInstrumenter({
    esModules,
    parserPlugins: ["typescript"],
    produceSourceMap: true,
    compact: false,
  });
  const code = instrumenter.instrumentSync(readFileSync(path, "utf8"), path);
  const transformed = eraseTypes(instrumenter, code, path);
  const marked = esModules
    ? markBun(transformed.code, transformed.map.mappings)
    : { code: transformed.code, mappings: transformed.map.mappings };
  const map = {
    ...transformed.map,
    sources: [path],
    sourceRoot: "",
    mappings: marked.mappings,
  };
  const capture = JSON.stringify(capturePath);
  const hook = esModules
    ? `\nimport ${capture};\n`
    : `\nrequire(${capture});\n`;
  writeFileSync(
    target,
    marked.code +
      hook +
      "\n//# sourceMappingURL=data:application/json;base64," +
      Buffer.from(JSON.stringify(map)).toString("base64"),
  );
  return instrumenter.lastFileCoverage();
}

/** @param {string} repo @param {string} root */
export function prepare(repo, root) {
  const snapshot = copySnapshot(repo, root);
  /** @type {import('istanbul-lib-coverage').CoverageMapData} */
  const baseline = {};
  for (const file of new Bun.Glob("src/**/*").scanSync({
    cwd: repo,
    onlyFiles: true,
  })) {
    if (!/\.(?:ts|cjs)$/.test(file) || /\.d\.[cm]?ts$/.test(file)) continue;
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
