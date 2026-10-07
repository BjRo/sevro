import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createCoverageMap } from 'istanbul-lib-coverage';
import { createContext } from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const root = import.meta.dir;
const project = join(root, 'project');
const modes = {
  parser: ['bun', 'test', 'tests/codex-events.test.ts'],
  integration: ['bun', 'test', 'tests/report.test.ts', '--test-name-pattern', 'public report command emits versioned JSON and readable rows', '--timeout', '15000'],
  extension: ['bun', 'test', 'tests/cli.test.ts', '--test-name-pattern', 'CLI resolves an explicit extension case and retains extension evidence', '--timeout', '15000'],
  isolation: ['bun', 'test', 'tests/mac-sandbox.test.ts', '--timeout', '15000'],
  cancellation: ['bun', 'test', 'tests/cli.test.ts', '--test-name-pattern', 'CLI SIG(INT|TERM) cancels host work and retains interruption evidence', '--timeout', '15000'],
};
for (const [mode, command] of Object.entries(modes)) {
  if (process.argv.length > 2 && !process.argv.slice(2).includes(mode)) continue;
  const dir = join(root, 'reports', mode);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const result = Bun.spawnSync(command, { cwd: project, env: { ...process.env, SEVRO_DISCOVERY_REPORT_DIR: dir }, stdout: 'pipe', stderr: 'pipe' });
  writeFileSync(join(root, `${mode}.log`), result.stdout.toString() + result.stderr.toString());
  const map = createCoverageMap(JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8')));
  const records = readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.started.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  for (const record of records) map.merge(record.coverage);
  const out = join(root, 'coverage', mode);
  const context = createContext({ dir: out, coverageMap: map });
  for (const type of ['json', 'json-summary', 'lcovonly', 'html']) reports.create(type).execute(context);
  const parser = join(root, 'source/src/hosts/codex-events.ts');
  const cli = join(root, 'source/src/cli.ts');
  const observation = {
    mode, exitCode: result.exitCode, reportCount: records.length,
    processes: records.map(r => ({ pid: r.pid, ppid: r.ppid, argv: r.argv, files: Object.keys(r.coverage).length, cliExecuted: Object.values(r.coverage[cli]?.s ?? {}).some(n => n > 0) })),
    total: map.getCoverageSummary().toJSON(),
    parser: map.fileCoverageFor(parser).toSummary().toJSON(),
    cli: map.fileCoverageFor(cli).toSummary().toJSON(),
  };
  writeFileSync(join(root, `${mode}-observation.json`), JSON.stringify(observation, null, 2));
  console.log(JSON.stringify(observation));
  if (result.exitCode !== 0) throw new Error(`prototype ${mode} failed: ${result.stderr}`);
}
