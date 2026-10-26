import { appendFile, readFile } from 'node:fs/promises';

let report;
try { report = JSON.parse(await readFile(process.argv[2] || 'test-results/report.json', 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.log('No Playwright report was produced; inspect the test step log.');
  process.exit(0);
}
const cases = [];
function visit(suites) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) for (const test of spec.tests) {
      cases.push({ file: spec.file.replace(/^.*tests\/e2e\//, ''), title: spec.title,
        duration: test.results.reduce((sum, result) => sum + result.duration, 0), status: test.status });
    }
    visit(suite.suites);
  }
}
visit(report.suites);
const stats = report.stats;
const cell = value => String(value).replace(/[|\r\n]/g, ' ');
const lines = ['## Browser tests', '',
  `${stats.expected} passed · ${stats.unexpected} failed · ${stats.skipped} skipped · ${stats.flaky} flaky`, '',
  `Elapsed: ${(stats.duration / 1000).toFixed(1)} s; workers: ${report.config.metadata?.actualWorkers ?? report.config.workers}; full layout matrix: ${report.config.metadata?.fullLayout ? 'yes' : 'no'}.`, '',
  '| Slowest scenario | Result | Seconds |', '| --- | --- | ---: |'];
for (const entry of cases.filter(entry => entry.duration > 0).sort((a, b) => b.duration - a.duration).slice(0, 10)) {
  lines.push(`| ${cell(entry.file)} — ${cell(entry.title)} | ${cell(entry.status)} | ${(entry.duration / 1000).toFixed(2)} |`);
}
lines.push('');
const summary = lines.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
