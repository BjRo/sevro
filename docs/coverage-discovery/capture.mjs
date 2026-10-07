import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function dump() {
  const reports = process.env.SEVRO_DISCOVERY_REPORT_DIR;
  if (!reports) return;
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, `${process.pid}.json`), JSON.stringify({ pid: process.pid, ppid: process.ppid, argv: process.argv, coverage: globalThis.__coverage__ ?? {} }));
}
