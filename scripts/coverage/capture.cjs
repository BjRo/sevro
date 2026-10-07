const { mkdirSync, writeFileSync, renameSync } = require("node:fs");
const { join } = require("node:path");
/** @param {string} directory @param {string} name @param {unknown} record */
function writeRecord(directory, name, record) {
  const target = join(directory, name);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record));
  renameSync(temporary, target);
}

/** @returns {import('./types').Capture | undefined} */
function register() {
  const directory = process.env.SEVRO_COVERAGE_REPORTS;
  if (!directory) return;
  const runId = process.env.SEVRO_COVERAGE_RUN_ID;
  const layout = process.env.SEVRO_COVERAGE_LAYOUT;
  if (!runId || !layout) throw new Error("Missing coverage capture identity");
  mkdirSync(directory, { recursive: true });
  const identity = {
    version: 1,
    runId,
    layout,
    pid: process.pid,
    ppid: process.ppid,
    argv: process.argv,
  };
  writeRecord(directory, `${process.pid}.started.json`, identity);
  /** @param {'checkpoint' | 'complete'} completion */
  const dump = (completion = "checkpoint") => {
    writeRecord(directory, `${process.pid}.${completion}.json`, {
      ...identity,
      completion,
      coverage: globalThis.__coverage__ ?? {},
    });
  };
  // A checkpoint is a lower bound. It may undercount a forcibly killed child's
  // final work, but can never turn an unobserved branch into a covered branch.
  dump();
  const timer = setInterval(dump, 25);
  timer.unref();
  process.on("exit", () => {
    dump("complete");
  });
  return { dump, directory, identity, writeRecord };
}

globalThis.__sevroQualityCapture ??= register();
module.exports = globalThis.__sevroQualityCapture;
