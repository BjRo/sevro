const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const key = Symbol.for('sevro.coverage.discovery.capture');
if (!globalThis[key]) {
  globalThis[key] = true;
  const dir = process.env.SEVRO_DISCOVERY_REPORT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${process.pid}.started.json`), JSON.stringify({ pid: process.pid, ppid: process.ppid, argv: process.argv }));
    process.on('exit', () => {
      writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, ppid: process.ppid, argv: process.argv, coverage: globalThis.__coverage__ ?? {} }));
    });
  }
}
