import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyDesktopArtifacts } from './desktop-pipeline.mjs';
import { REQUEST_INTERVAL_MS, VirusTotalClient, scanReleaseAssets, renderVirusTotalReport, writeVirusTotalReport } from './virustotal.mjs';

const dir = path.resolve(process.argv[2] || 'release-artifacts');
const output = path.resolve(process.argv[3] || 'antivirus-report');
const report = {
  schema: 1, provider: 'VirusTotal', status: 'error',
  tag: process.env.RELEASE_TAG, sha: process.env.SOURCE_SHA,
  startedAt: new Date().toISOString(), requestIntervalMs: REQUEST_INTERVAL_MS, files: [],
};
try {
  const client = new VirusTotalClient(process.env.VIRUSTOTAL_API_KEY);
  const assets = await verifyDesktopArtifacts(dir, report.tag, report.sha);
  await scanReleaseAssets(client, dir, assets, report, { progress: message => console.log(message) });
} catch (error) {
  report.status = 'error';
  // Avoid accidental exposure of a credential in a network exception.
  report.error = String(error.message).replaceAll(process.env.VIRUSTOTAL_API_KEY || '\0', '[redacted]');
  console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeVirusTotalReport(output, report);
  const markdownReport = renderVirusTotalReport(report);
  console.log('\n' + markdownReport + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdownReport);
  // Detections are findings in a completed advisory scan, not execution errors.
  if (report.status === 'error') process.exitCode = 1;
}
