import { createHash } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const API = 'https://www.virustotal.com/api/v3';
export const REQUEST_INTERVAL_MS = 16_000;
export const REPORT_NAMES = ['VIRUSTOTAL-REPORT.json', 'VIRUSTOTAL-REPORT.md'];
const CATEGORIES = ['harmless', 'undetected', 'malicious', 'suspicious', 'failure', 'timeout', 'confirmed-timeout', 'type-unsupported'];
const validAnalysisId = id => typeof id === 'string' && id.length > 0 && id.length <= 512 && /^[\w=+/-]+$/.test(id);

function trustedUrl(value) {
  const url = new URL(value);
  if (url.hostname !== 'www.virustotal.com' || url.username || url.password || url.port) {
    throw new Error('Unexpected VirusTotal upload host.');
  }
  // The documented large-file endpoint can return an old HTTP URL.
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') throw new Error('VirusTotal requires HTTPS.');
  return url.href;
}

/** All calls, including upload-URL lookup, uploads, polling and retries, share a queue. */
export class VirusTotalClient {
  constructor(apiKey, { fetch: fetchImpl = fetch, sleep: wait = sleep, now = () => performance.now(), wallTime = Date.now } = {}) {
    if (!apiKey?.trim()) throw new Error('Missing VIRUSTOTAL_API_KEY. See docs/RELEASING.md.');
    this.apiKey = apiKey.trim();
    this.fetch = fetchImpl;
    this.sleep = wait;
    this.now = now;
    this.wallTime = wallTime;
    this.deadline = now() + 45 * 60_000;
    // Also leave a gap after the preceding serialized workflow job.
    this.nextRequest = now() + REQUEST_INTERVAL_MS;
    this.requests = 0;
    this.queue = Promise.resolve();
  }

  request(url, bodyFactory) {
    const run = this.queue.then(() => this.perform(trustedUrl(url), bodyFactory));
    this.queue = run.catch(() => {});
    return run;
  }

  async perform(url, bodyFactory) {
    for (let retry = 0; retry <= 3; retry++) {
      const delay = Math.max(0, this.nextRequest - this.now());
      if (this.now() + delay >= this.deadline || this.requests >= 180) {
        throw new Error('VirusTotal scan exceeded its 45-minute/180-request budget.');
      }
      if (delay) await this.sleep(delay);
      const body = bodyFactory ? await bodyFactory() : undefined;
      this.nextRequest = this.now() + REQUEST_INTERVAL_MS;
      this.requests++;
      const response = await this.fetch(url, {
        method: body ? 'POST' : 'GET', headers: { 'x-apikey': this.apiKey }, body,
        redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(300_000, Math.ceil(this.deadline - this.now())))),
      });
      if (response.status === 429 && retry < 3) {
        const header = response.headers.get('retry-after');
        const seconds = header && /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - this.wallTime();
        this.nextRequest = Math.max(this.nextRequest, this.now() + Math.max(60_000, Number.isFinite(seconds) ? seconds : 0));
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`VirusTotal API returned HTTP ${response.status}; publication is blocked.`);
      }
      return response.json();
    }
  }

  async upload(file, name, size) {
    if (size <= 0 || size > 650 * 1024 * 1024) throw new Error(`Unsupported VirusTotal file size: ${name}`);
    let url = `${API}/files`;
    if (size > 32 * 1024 * 1024) url = (await this.request(`${API}/files/upload_url`)).data;
    const response = await this.request(url, async () => {
      const form = new FormData();
      form.append('file', await openAsBlob(file), name);
      return form;
    });
    if (response.data?.type !== 'analysis' || !validAnalysisId(response.data.id)) {
      throw new Error('VirusTotal did not return an analysis ID.');
    }
    return response.data.id;
  }

  analysis(id) { return this.request(`${API}/analyses/${encodeURIComponent(id)}`); }
  file(sha256) { return this.request(`${API}/files/${sha256}`); }
}

function validateVerdicts(stats, results) {
  if (!stats || !results || typeof results !== 'object' || Array.isArray(results)) throw new Error('Incomplete VirusTotal verdicts.');
  const counts = Object.fromEntries(CATEGORIES.map(category => [category, 0]));
  for (const result of Object.values(results)) {
    if (!result || !CATEGORIES.includes(result.category) || typeof result.engine_name !== 'string') {
      throw new Error('Invalid VirusTotal engine verdict.');
    }
    counts[result.category]++;
  }
  for (const category of CATEGORIES) {
    if (!Number.isSafeInteger(stats[category] ?? 0) || (stats[category] ?? 0) < 0 || counts[category] !== (stats[category] ?? 0)) {
      throw new Error('Inconsistent VirusTotal engine statistics.');
    }
  }
  if (counts.harmless + counts.undetected + counts.malicious + counts.suspicious === 0) {
    throw new Error('No antivirus engine completed a supported scan.');
  }
  return counts.malicious === 0 && counts.suspicious === 0;
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Upload every distinct payload first, then poll in rounds to share the API quota. */
export async function scanReleaseAssets(client, dir, assets, report, { progress = () => {} } = {}) {
  report.files = assets.filter(asset => !asset.name.endsWith('.sig')).map(asset => ({ ...asset, status: 'pending' }));
  report.excluded = assets.filter(asset => asset.name.endsWith('.sig')).map(asset => ({ ...asset, reason: 'Detached signature; not an executable payload.' }));
  const unique = new Map();
  for (const file of report.files) {
    const fullPath = path.join(dir, file.name);
    const info = await stat(fullPath);
    if (info.size !== file.size || await hashFile(fullPath) !== file.sha256) throw new Error(`Pre-scan checksum mismatch: ${file.name}`);
    let entry = unique.get(file.sha256);
    if (!entry) {
      progress(`Submitting ${file.name}`);
      const analysisId = await client.upload(fullPath, file.name, file.size);
      entry = { analysisId, aliases: [] };
      unique.set(file.sha256, entry);
    }
    Object.assign(file, { analysisId: entry.analysisId, status: 'submitted', url: `https://www.virustotal.com/gui/file/${file.sha256}` });
    entry.aliases.push(file);
  }
  const pending = new Set(unique.values());
  while (pending.size) {
    for (const entry of pending) {
      const response = await client.analysis(entry.analysisId);
      const analysis = response.data?.attributes;
      if (response.data?.id !== entry.analysisId || response.data?.type !== 'analysis' || !['queued', 'in-progress', 'completed'].includes(analysis?.status)) {
        throw new Error('Invalid VirusTotal analysis response.');
      }
      if (analysis.status !== 'completed') continue;
      const file = entry.aliases[0];
      const clear = validateVerdicts(analysis.stats, analysis.results);
      // Bind the completed analysis to the uploaded bytes, including API
      // versions whose analysis response omits meta.file_info.
      const uploaded = (await client.file(file.sha256)).data;
      if (uploaded?.type !== 'file' || uploaded.id !== file.sha256 || uploaded.attributes?.size !== file.size ||
          !Number.isSafeInteger(analysis.date) || analysis.date <= 0 ||
          !Number.isSafeInteger(uploaded.attributes.last_analysis_date) || uploaded.attributes.last_analysis_date < analysis.date) {
        throw new Error(`VirusTotal file identity or analysis date mismatch: ${file.name}`);
      }
      const currentClear = validateVerdicts(uploaded.attributes.last_analysis_stats, uploaded.attributes.last_analysis_results);
      for (const alias of entry.aliases) Object.assign(alias, {
        status: 'completed', analyzedAt: analysis.date, stats: analysis.stats, results: analysis.results,
        fileInfo: { sha256: uploaded.id, size: uploaded.attributes.size, date: uploaded.attributes.last_analysis_date,
          stats: uploaded.attributes.last_analysis_stats, results: uploaded.attributes.last_analysis_results },
      });
      pending.delete(entry);
      progress(`Completed ${file.name}: ${clear && currentClear ? 'no detections reported' : 'detections reported'}`);
    }
  }
  for (const file of report.files) {
    if (await hashFile(path.join(dir, file.name)) !== file.sha256) throw new Error(`Post-scan checksum mismatch: ${file.name}`);
  }
  report.status = report.files.length > 0 && report.files.every(file =>
    validateVerdicts(file.stats, file.results) && validateVerdicts(file.fileInfo.stats, file.fileInfo.results)) ? 'passed' : 'detected';
}

const cell = value => String(value).replace(/[|\r\n]/g, ' ');
export function renderVirusTotalReport(report) {
  const lines = ['# VirusTotal release scan', '', `Status: **${report.status}**`, '',
    `Tag: ${cell(report.tag)}; source commit: ${cell(report.sha)}`, '',
    `Started: ${report.startedAt}; finished: ${report.finishedAt}`, '',
    'API requests are serialized with at least 16 seconds between requests, including upload URL requests and polling.', '',
    '| File | SHA-256 | Malicious | Suspicious | Undetected / harmless | Failed / timeout / unsupported | Report |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |'];
  for (const file of report.files ?? []) {
    const stats = file.stats ?? {};
    const skipped = ['failure', 'timeout', 'confirmed-timeout', 'type-unsupported'].reduce((sum, category) => sum + (stats[category] ?? 0), 0);
    lines.push(`| ${cell(file.name)} | ${cell(file.sha256)} | ${stats.malicious ?? '—'} | ${stats.suspicious ?? '—'} | ${(stats.undetected ?? 0) + (stats.harmless ?? 0)} | ${skipped} | ${file.url ? `[${cell(file.status)}](${file.url})` : cell(file.status)} |`);
  }
  if (report.error) lines.push('', `Error: ${cell(report.error)}`);
  lines.push('', 'JSON includes individual engine verdicts and the latest file report. Detached signatures are excluded from scanning.', '',
    'No detections is not a guarantee of safety. Engines may not support every installer/archive or inspect all embedded payloads; unsupported scans and timeouts are reported above.', '');
  return lines.join('\n');
}

export async function writeVirusTotalReport(dir, report) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, REPORT_NAMES[0]), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(dir, REPORT_NAMES[1]), renderVirusTotalReport(report));
}

/** Recheck reports before the publisher creates a tag, draft, or any assets. */
export async function verifyVirusTotalReport(dir, tag, sha, assets) {
  const json = await readFile(path.join(dir, REPORT_NAMES[0]));
  const markdown = await readFile(path.join(dir, REPORT_NAMES[1]));
  const report = JSON.parse(json);
  if (report.schema !== 1 || report.provider !== 'VirusTotal' || report.status !== 'passed' || report.tag !== tag || report.sha !== sha ||
      !Number.isFinite(Date.parse(report.startedAt)) || !Number.isFinite(Date.parse(report.finishedAt)) ||
      Date.parse(report.finishedAt) < Date.parse(report.startedAt)) throw new Error('Invalid or unsuccessful VirusTotal release report.');
  const expected = new Map(assets.filter(asset => !asset.name.endsWith('.sig')).map(asset => [asset.name, asset]));
  if (!Array.isArray(report.files) || !expected.size || report.files.length !== expected.size) throw new Error('Incomplete VirusTotal release report.');
  for (const file of report.files) {
    const asset = expected.get(file.name);
    if (!asset || asset.sha256 !== file.sha256 || asset.size !== file.size || file.status !== 'completed' ||
        !validAnalysisId(file.analysisId) ||
        !Number.isSafeInteger(file.analyzedAt) || file.analyzedAt <= 0 ||
        file.url !== `https://www.virustotal.com/gui/file/${asset.sha256}` ||
        file.fileInfo?.sha256 !== asset.sha256 || file.fileInfo.size !== asset.size ||
        !Number.isSafeInteger(file.fileInfo.date) || file.fileInfo.date < file.analyzedAt ||
        !validateVerdicts(file.stats, file.results) || !validateVerdicts(file.fileInfo.stats, file.fileInfo.results)) {
      throw new Error(`VirusTotal report mismatch or detection: ${file.name}`);
    }
    expected.delete(file.name);
  }
  if (markdown.toString('utf8') !== renderVirusTotalReport(report)) throw new Error('VirusTotal Markdown report does not match JSON.');
  return [json, markdown].map((data, i) => ({ name: REPORT_NAMES[i], size: data.length, sha256: createHash('sha256').update(data).digest('hex') }));
}
