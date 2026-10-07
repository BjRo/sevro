import { createInstrumenter } from 'istanbul-lib-instrument';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mergeChecked, thresholdFailure } from './gate.mjs';
import { transformSync } from '@babel/core';
import transformTypescript from '@babel/plugin-transform-typescript';
const root = import.meta.dir;
const observations = {};
function assert(condition, label) { if (!condition) throw new Error(label); }
function mustFail(label, fn, expected) {
  let message;
  try { fn(); } catch (error) { message = error.message; }
  assert(message?.includes(expected), `${label} must fail with ${expected}, got ${message}`);
  return { passed: true, message };
}
function records(dir) { return readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.started.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8'))); }
function pids(dir) { return readdirSync(dir).filter(f => f.endsWith('.started.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')).pid); }
function instrumentProbe(name, original) {
  mkdirSync(join(root, 'probe-source'), { recursive: true });
  mkdirSync(join(root, 'probe-run'), { recursive: true });
  const path = join(root, 'probe-source', `${name}.ts`);
  writeFileSync(path, original);
  const instrumenter = createInstrumenter({ esModules: true, parserPlugins: ['typescript'], compact: false, produceSourceMap: true });
  const instrumented = instrumenter.instrumentSync(original, path);
  const transformed = transformSync(instrumented, { filename: path, configFile: false, babelrc: false, plugins: [transformTypescript], inputSourceMap: instrumenter.lastSourceMap(), sourceMaps: true });
  const map = transformed.map;
  map.sources = [path];
  map.sourceRoot = '';
  map.mappings = ';' + map.mappings;
  const target = join(root, 'probe-run', `${name}.ts`);
  writeFileSync(target, '// @bun\n' + transformed.code + `\nimport ${JSON.stringify(join(root, 'capture.cjs'))};\n` + '\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64'));
  return { path, target, baseline: { [path]: instrumenter.lastFileCoverage() } };
}
const dir = join(root, 'reports/branch-probe');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const branch = instrumentProbe('branch', `export function pick(flag: boolean): number {\n  let result: number = 1;\n  if (flag) result = 2;\n  return result;\n}\nconsole.log(pick(true));\n`);
const child = Bun.spawnSync([process.execPath, branch.target], { cwd: '/tmp', env: { ...process.env, SEVRO_DISCOVERY_REPORT_DIR: dir }, stdout: 'pipe', stderr: 'pipe' });
assert(child.exitCode === 0 && child.stdout.toString().trim() === '2', 'branch probe runtime');
const branchRecords = records(dir);
const branchMap = mergeChecked(branch.baseline, branchRecords, pids(dir));
const branchSummary = branchMap.getCoverageSummary().toJSON();
assert(branchSummary.statements.pct === 100 && branchSummary.branches.pct === 50, 'independent coverage metrics');
observations.branchFailure = { summary: branchSummary, ...mustFail('missed branch', () => thresholdFailure(branchMap), 'branches') };
observations.missingReports = mustFail('missing reports', () => mergeChecked(branch.baseline, [], []), 'Missing coverage reports');
const broken = structuredClone(branchRecords);
delete broken[0].coverage[branch.path].b;
observations.missingBranches = mustFail('missing branch data', () => mergeChecked(branch.baseline, broken, pids(dir)), 'Missing branch data');
const baseline = JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8'));
const parserRecords = records(join(root, 'reports/parser'));
const parserMap = mergeChecked(baseline, parserRecords, pids(join(root, 'reports/parser')));
const unimported = join(root, 'source/src/cli.ts');
assert(!parserRecords.some(r => Object.hasOwn(r.coverage, unimported)), 'CLI is genuinely unimported');
assert(parserMap.fileCoverageFor(unimported).toSummary().statements.pct === 0, 'unimported zero counter denominator');
observations.unimportedProduction = { passed: true, path: unimported, statements: parserMap.fileCoverageFor(unimported).toSummary().statements };
const integrationDir = join(root, 'reports/integration');
const integrationRecords = records(integrationDir);
const missingChild = integrationRecords.find(r => r.argv[1].endsWith('/src/cli.ts'));
observations.missingChildReport = mustFail('missing child report', () => mergeChecked(baseline, integrationRecords.filter(r => r.pid !== missingChild.pid), pids(integrationDir)), `Missing coverage report for started process ${missingChild.pid}`);
const mapped = instrumentProbe('source-map', `export interface Shape {\n  value: number;\n}\n\nexport function fail(input: Shape): never {\n  throw new Error('source-map-probe');\n}\n\nfail({ value: 1 });\n`);
const mappedChild = Bun.spawnSync([process.execPath, mapped.target], { cwd: '/tmp', stdout: 'pipe', stderr: 'pipe' });
const stderr = mappedChild.stderr.toString();
const location = `${mapped.path}:6:`;
assert(mappedChild.exitCode !== 0 && stderr.includes(location), 'source map probe maps to original TS path and line');
const coverageLocation = Object.values(mapped.baseline[mapped.path].statementMap).find(v => v.start.line === 6);
assert(coverageLocation?.start.column === 2, 'counter maps to original throw statement');
observations.originalTypescriptMapping = { passed: true, expectedStackLocation: location, runtimeStackRemapped: stderr.includes(location), actualStack: stderr, statementLocation: coverageLocation, sourceLine: readFileSync(mapped.path, 'utf8').split('\n')[coverageLocation.start.line - 1] };
const foreignDir = join(root, 'reports/foreign-cwd');
rmSync(foreignDir, { recursive: true, force: true });
mkdirSync(foreignDir, { recursive: true });
const foreign = Bun.spawnSync([process.execPath, join(root, 'project/src/cli.ts'), 'run', '--json'], { cwd: '/tmp', env: { ...process.env, SEVRO_DISCOVERY_REPORT_DIR: foreignDir }, stdout: 'pipe', stderr: 'pipe' });
const foreignRecords = records(foreignDir);
assert(foreign.exitCode === 64 && foreignRecords.length === 1 && foreignRecords[0].coverage[unimported], 'capture survives different cwd');
observations.foreignWorkingDirectory = { passed: true, exitCode: foreign.exitCode, reportCount: foreignRecords.length };
const extensionRecords = records(join(root, 'reports/extension'));
const extensionMap = mergeChecked(baseline, extensionRecords, pids(join(root, 'reports/extension')));
const extensionPaths = ['src/extension-client.ts', 'src/extension-session.ts'].map(file => join(root, 'source', file));
for (const path of extensionPaths) assert(extensionMap.fileCoverageFor(path).toSummary().functions.covered > 0, `extension functions executed ${path}`);
assert(extensionRecords.filter(r => r.argv[1].endsWith('/src/cli.ts')).length === 3, 'three extension-related CLI processes captured');
assert(extensionRecords.filter(r => r.argv[1].endsWith('/tests/fixtures/extension.ts')).every(r => Object.keys(r.coverage).length === 0), 'extension fixture excluded from production denominator');
observations.extensionLifecycle = { passed: true, cliProcessCount: 3, fixtureProcessesExcluded: true, productionFiles: Object.fromEntries(extensionPaths.map(path => [path, extensionMap.fileCoverageFor(path).toSummary().toJSON()])) };
writeFileSync(join(root, 'probe-observations.json'), JSON.stringify(observations, null, 2));
console.log(JSON.stringify(observations));
