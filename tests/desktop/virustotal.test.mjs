import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, open, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { REQUEST_INTERVAL_MS, VirusTotalClient, scanReleaseAssets, verifyVirusTotalReport, writeVirusTotalReport } from '../../scripts/virustotal.mjs';
import { clearVerdicts, releaseReport } from './virustotal-fixture.mjs';

function mockClient(handler) {
  let now = 0;
  const calls = [];
  const client = new VirusTotalClient('test-key', {
    now: () => now, wallTime: () => Date.UTC(2026, 0, 1) + now,
    sleep: async ms => { now += ms; },
    fetch: async (url, options) => {
      calls.push({ url, options, at: now });
      assert.equal(options.headers['x-apikey'], 'test-key');
      assert.equal(options.redirect, 'error');
      return handler(url, options, calls.length);
    },
  });
  return { client, calls };
}

const json = value => Response.json(value);
const api = 'https://www.virustotal.com/api/v3';

test('concurrent API calls are queued with at least 16 seconds between every request', async () => {
  const { client, calls } = mockClient(() => json({}));
  await Promise.all([client.analysis('one'), client.file('a'.repeat(64)), client.analysis('two')]);
  assert.deepEqual(calls.map(call => call.at), [16_000, 32_000, 48_000]);
});

test('429 retries honor Retry-After and still share the same rate limiter', async () => {
  const { client, calls } = mockClient((url, options, count) => count === 1
    ? new Response(null, { status: 429, headers: { 'retry-after': '70' } }) : json({}));
  await client.analysis('one');
  await client.analysis('two');
  assert.deepEqual(calls.map(call => call.at), [16_000, 86_000, 102_000]);
});

test('HTTP-date Retry-After, bounded retries and authentication errors fail safely', async () => {
  const { client, calls } = mockClient(() => new Response(null, {
    status: 429, headers: { 'retry-after': 'Thu, 01 Jan 2026 00:02:00 GMT' },
  }));
  await assert.rejects(client.analysis('one'), /HTTP 429/);
  assert.deepEqual(calls.map(call => call.at), [16_000, 120_000, 180_000, 240_000]);
  const denied = mockClient(() => new Response(null, { status: 401 }));
  await assert.rejects(denied.client.analysis('one'), /HTTP 401/);
  assert.equal(denied.calls.length, 1);
  assert.throws(() => new VirusTotalClient(''), /Missing VIRUSTOTAL_API_KEY/);
});

test('large-file URL lookup, upload and analysis calls are all paced; keys cannot leave VirusTotal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kubiki-vt-upload-'));
  try {
    const file = path.join(dir, 'app.bin');
    const handle = await open(file, 'w');
    await handle.truncate(33 * 1024 * 1024);
    await handle.close();
    const { client, calls } = mockClient((url, options) => {
      if (url.endsWith('/upload_url')) return json({ data: 'http://bigfiles.virustotal.com/_ah/upload/single-use' });
      if (options.method === 'POST') {
        assert.equal(options.body.get('file').size, 33 * 1024 * 1024);
        assert.equal(options.body.get('file').name, 'app.bin');
        return json({ data: { type: 'analysis', id: 'analysis-id' } });
      }
      return json({});
    });
    assert.equal(await client.upload(file, 'app.bin', 33 * 1024 * 1024), 'analysis-id');
    await client.analysis('analysis-id');
    assert.deepEqual(calls.map(call => call.at), [16_000, 32_000, 48_000]);
    assert.equal(calls[1].url, 'https://bigfiles.virustotal.com/_ah/upload/single-use');
    await assert.rejects(client.upload(file, 'app.bin', 651 * 1024 * 1024), /file size/);
    for (const data of ['https://attacker.example/upload', 'https://bigfiles.virustotal.com:8443/upload',
      'https://user@www.virustotal.com/upload', 'https://bigfiles.virustotal.com.evil.example/upload']) {
      const malicious = mockClient(() => json({ data }));
      await assert.rejects(malicious.client.upload(file, 'app.bin', 33 * 1024 * 1024), /upload host/);
      assert.equal(malicious.calls.length, 1);
    }
    const apiOnly = mockClient(() => json({}));
    await assert.rejects(apiOnly.client.request('https://bigfiles.virustotal.com/api/v3/files/x'), /API host/);
    assert.equal(apiOnly.calls.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an upload without a valid analysis ID is rejected immediately', async t => {
  const fixture = await payloadFixture(t);
  const { client } = mockClient(() => json({ data: { type: 'analysis' } }));
  await assert.rejects(client.upload(path.join(fixture.dir, 'app.exe'), 'app.exe', fixture.assets[0].size), /analysis ID/);
});

async function payloadFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kubiki-vt-scan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('application bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const assets = ['app.exe', 'cli.exe', 'app.exe.sig'].map(name => ({ name, size: bytes.length, sha256 }));
  for (const asset of assets) await writeFile(path.join(dir, asset.name), bytes);
  return { dir, assets, sha256 };
}

function scanApi(fixture, { category = 'undetected', queued = false, mutate, wrongHash = false, incomplete = false, analysisId = 'analysis-id', meta = {} } = {}) {
  let polls = 0;
  const verdicts = clearVerdicts();
  if (category !== 'undetected') {
    verdicts.stats.undetected = 0;
    verdicts.stats[category] = 1;
    verdicts.results.example.category = category;
  }
  if (incomplete) { verdicts.stats = {}; verdicts.results = {}; }
  return mockClient(async (url, options) => {
    if (options.method === 'POST') return json({ data: { type: 'analysis', id: 'analysis-id' } });
    if (url.includes('/analyses/')) {
      polls++;
      return json({ data: { type: 'analysis', id: analysisId, attributes: {
        status: queued && polls === 1 ? 'queued' : 'completed', date: 1767225600, ...verdicts,
      } }, meta });
    }
    if (mutate) await mutate();
    return json({ data: { type: 'file', id: wrongHash ? '0'.repeat(64) : fixture.sha256,
      attributes: { size: fixture.assets[0].size, last_analysis_date: 1767225600,
        last_analysis_stats: verdicts.stats, last_analysis_results: verdicts.results } } });
  });
}

test('scan waits for completed verdicts, deduplicates identical bytes and preserves per-file reports', async t => {
  const fixture = await payloadFixture(t);
  const { client, calls } = scanApi(fixture, { queued: true });
  const report = releaseReport(fixture.assets, 'v1.0.0', 'a'.repeat(40));
  await scanReleaseAssets(client, fixture.dir, fixture.assets, report);
  assert.equal(report.status, 'passed');
  assert.equal(report.files.length, 2);
  assert.equal(report.excluded.length, 1);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.deepEqual(calls.map(call => call.url), [`${api}/files`, `${api}/analyses/analysis-id`, `${api}/analyses/analysis-id`, `${api}/files/${fixture.sha256}`]);
  assert.ok(calls.every((call, i) => i === 0 || call.at - calls[i - 1].at >= REQUEST_INTERVAL_MS));
  await writeVirusTotalReport(fixture.dir, report);
  const reports = await verifyVirusTotalReport(fixture.dir, report.tag, report.sha, fixture.assets);
  assert.equal(reports.length, 2);
});

test('malicious and suspicious verdicts block a release; unsupported-only and empty analyses cannot pass', async t => {
  const fixture = await payloadFixture(t);
  for (const category of ['malicious', 'suspicious']) {
    const { client } = scanApi(fixture, { category });
    const report = releaseReport(fixture.assets, 'v1.0.0', 'a'.repeat(40));
    await scanReleaseAssets(client, fixture.dir, fixture.assets, report);
    assert.equal(report.status, 'detected');
    await writeVirusTotalReport(fixture.dir, report);
    await assert.rejects(verifyVirusTotalReport(fixture.dir, report.tag, report.sha, fixture.assets), /unsuccessful/);
  }
  for (const options of [{ category: 'type-unsupported' }, { incomplete: true }]) {
    const { client } = scanApi(fixture, options);
    await assert.rejects(scanReleaseAssets(client, fixture.dir, fixture.assets, {}), /No antivirus engine/);
  }
});

test('canonical analysis IDs returned by VirusTotal are accepted and adopted for later polls', async t => {
  const fixture = await payloadFixture(t);
  const canonical = `f-${fixture.sha256}-1767225600`;
  const { client, calls } = scanApi(fixture, {
    queued: true, analysisId: canonical,
    meta: { file_info: { sha256: fixture.sha256, size: fixture.assets[0].size } },
  });
  const report = releaseReport(fixture.assets, 'v1.0.0', 'a'.repeat(40));
  await scanReleaseAssets(client, fixture.dir, fixture.assets, report);
  assert.equal(report.status, 'passed');
  assert.equal(report.files[0].analysisId, canonical);
  assert.equal(calls[0].url, `${api}/files`);
  const polls = calls.filter(call => call.url.startsWith(`${api}/analyses/`));
  assert.ok(polls[0].url.startsWith(`${api}/analyses/analysis-id`));
  assert.ok(polls.slice(1).every(call => call.url.startsWith(`${api}/analyses/${encodeURIComponent(canonical)}`)));
  await writeVirusTotalReport(fixture.dir, report);
  await verifyVirusTotalReport(fixture.dir, report.tag, report.sha, fixture.assets);
});

test('analysis responses for other files are rejected', async t => {
  const fixture = await payloadFixture(t);
  for (const options of [{ analysisId: 'unrelated-analysis-id' },
    { analysisId: 'unrelated-analysis-id', meta: { file_info: { sha256: '0'.repeat(64), size: fixture.assets[0].size } } }]) {
    const { client } = scanApi(fixture, options);
    await assert.rejects(scanReleaseAssets(client, fixture.dir, fixture.assets, {}), /does not belong to/);
  }
});

test('wrong remote hash and changes to local payloads during scanning are rejected', async t => {
  const fixture = await payloadFixture(t);
  const wrong = scanApi(fixture, { wrongHash: true });
  await assert.rejects(scanReleaseAssets(wrong.client, fixture.dir, fixture.assets, {}), /identity/);
  const mutated = scanApi(fixture, { mutate: () => writeFile(path.join(fixture.dir, 'app.exe'), 'tampered') });
  await assert.rejects(scanReleaseAssets(mutated.client, fixture.dir, fixture.assets, {}), /Post-scan checksum/);
});

test('endless queued analyses stop at the deadline instead of spending an unbounded daily quota', async t => {
  const fixture = await payloadFixture(t);
  const { client, calls } = mockClient((url, options) => json({ data: {
    type: 'analysis', id: 'analysis-id', attributes: { status: 'queued' },
  } }));
  await assert.rejects(scanReleaseAssets(client, fixture.dir, fixture.assets, {}), /budget/);
  assert.ok(calls.length < 180);
});

test('missing API key produces a failed report and a nonzero exit without uploading anything', async t => {
  const fixture = await payloadFixture(t);
  const output = path.join(fixture.dir, 'report');
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/scan-desktop-release.mjs', fixture.dir, output], {
    env: { ...process.env, VIRUSTOTAL_API_KEY: '', GITHUB_STEP_SUMMARY: '', RELEASE_TAG: 'v1.0.0', SOURCE_SHA: 'a'.repeat(40) },
  }), error => error.code === 1);
  const report = JSON.parse(await readFile(path.join(output, 'VIRUSTOTAL-REPORT.json'), 'utf8'));
  assert.equal(report.status, 'error');
  assert.match(report.error, /Missing VIRUSTOTAL_API_KEY/);
  assert.match(await readFile(path.join(output, 'VIRUSTOTAL-REPORT.md'), 'utf8'), /Status: \*\*error\*\*/);
});
