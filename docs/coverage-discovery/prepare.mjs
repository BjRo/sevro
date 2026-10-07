import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInstrumenter } from 'istanbul-lib-instrument';
import { transformSync } from '@babel/core';
import transformTypescript from '@babel/plugin-transform-typescript';

const repo = process.env.SEVRO_DISCOVERY_REPO ?? '/Users/bjro/Sources/sevro';
const root = import.meta.dir;
const project = join(root, 'project');
const source = join(root, 'source');
mkdirSync(project, { recursive: true });
for (const entry of ['src', 'scripts', 'tests', 'examples', 'schemas', 'docs', 'README.md', 'LICENSE', 'package.json', 'bun.lock', 'tsconfig.json']) {
  cpSync(join(repo, entry), join(project, entry), { recursive: true });
}
if (!existsSync(join(project, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(project, 'node_modules'));
cpSync(join(repo, 'src'), join(source, 'src'), { recursive: true });
const preload = join(root, 'preload.mjs');
writeFileSync(join(project, 'bunfig.toml'), `preload = [${JSON.stringify(preload)}]\n[test]\npreload = [${JSON.stringify(join(root, 'test-preload.mjs'))}]\n`);
const baseline = {};
for (const file of new Bun.Glob('src/**/*').scanSync({ cwd: project, onlyFiles: true })) {
  if (!/\.(?:ts|cjs)$/.test(file) || /\.d\.[cm]?ts$/.test(file)) continue;
  const path = join(source, file);
  const instrumenter = createInstrumenter({ esModules: !file.endsWith('.cjs'), parserPlugins: ['typescript'], produceSourceMap: true, compact: false });
  const instrumented = instrumenter.instrumentSync(readFileSync(path, 'utf8'), path);
  const transformed = file.endsWith('.ts') ? transformSync(instrumented, { filename: path, configFile: false, babelrc: false, plugins: [transformTypescript], inputSourceMap: instrumenter.lastSourceMap(), sourceMaps: true }) : { code: instrumented, map: instrumenter.lastSourceMap() };
  const map = transformed.map;
  map.sources = [path];
  map.sourceRoot = '';
  const marker = file.endsWith('.ts') ? '// @bun\n' : '';
  let code = transformed.code;
  if (marker && code.startsWith('#!')) {
    const newline = code.indexOf('\n');
    code = code.slice(0, newline + 1) + marker + code.slice(newline + 1);
    const mappings = map.mappings.split(';');
    mappings.splice(1, 0, '');
    map.mappings = mappings.join(';');
  } else if (marker) {
    code = marker + code;
    map.mappings = ';' + map.mappings;
  }
  const capture = JSON.stringify(join(root, 'capture.cjs'));
  const hook = file.endsWith('.cjs') ? `\nrequire(${capture});\n` : `\nimport ${capture};\n`;
  writeFileSync(join(project, file), code + hook + '\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64'));
  baseline[path] = instrumenter.lastFileCoverage();
}
writeFileSync(join(root, 'baseline.json'), JSON.stringify(baseline));
writeFileSync(join(root, 'environment.json'), JSON.stringify({ bun: Bun.version, platform: process.platform, arch: process.arch, sourceRevision: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repo }).stdout.toString().trim(), productionFiles: Object.keys(baseline).length }, null, 2));
console.log(JSON.stringify({ project, productionFiles: Object.keys(baseline).length }));
