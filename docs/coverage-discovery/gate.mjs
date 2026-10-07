import { createCoverageMap } from 'istanbul-lib-coverage';
export function mergeChecked(baseline, records, requiredPids) {
  if (!records.length) throw new Error('Missing coverage reports');
  for (const pid of requiredPids) if (!records.some(r => r.pid === pid)) throw new Error(`Missing coverage report for started process ${pid}`);
  const map = createCoverageMap(baseline);
  for (const record of records) {
    if (!record.coverage || typeof record.coverage !== 'object') throw new Error('Missing coverage object');
    for (const [path, entry] of Object.entries(record.coverage)) {
      const expected = baseline[path];
      if (!expected) throw new Error(`Undeclared production file ${path}`);
      for (const [counter, locations] of [['s', 'statementMap'], ['f', 'fnMap'], ['b', 'branchMap']]) {
        if (!entry[counter] || !entry[locations]) throw new Error(`Missing ${counter === 'b' ? 'branch' : counter} data for ${path}`);
        if (JSON.stringify(entry[locations]) !== JSON.stringify(expected[locations])) throw new Error(`Coverage layout mismatch for ${path}: ${locations}`);
        if (Object.keys(entry[counter]).length !== Object.keys(expected[counter]).length) throw new Error(`Incomplete counters for ${path}: ${counter}`);
        for (const [id, expectedValue] of Object.entries(expected[counter])) {
          const value = entry[counter][id];
          const values = Array.isArray(value) ? value : [value];
          if (values.some(v => !Number.isInteger(v) || v < 0) || (counter === 'b' && (!Array.isArray(value) || value.length !== expectedValue.length))) throw new Error(`Invalid ${counter} counter for ${path}: ${id}`);
        }
      }
    }
    map.merge(record.coverage);
  }
  return map;
}
export function thresholdFailure(map) {
  const summary = map.getCoverageSummary().toJSON();
  const failed = ['statements', 'branches'].filter(metric => summary[metric].total > 0 && summary[metric].covered * 100 < summary[metric].total * 95);
  if (failed.length) throw new Error(`Below 95%: ${failed.join(', ')}`);
  return summary;
}
