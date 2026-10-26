export function clearVerdicts() {
  return {
    stats: { harmless: 0, undetected: 1, malicious: 0, suspicious: 0, failure: 0, timeout: 0, 'confirmed-timeout': 0, 'type-unsupported': 0 },
    results: { example: { category: 'undetected', engine_name: 'Example engine', engine_version: '1', engine_update: '20260101', result: null } },
  };
}

export function releaseReport(assets, tag, sha) {
  return {
    schema: 1, provider: 'VirusTotal', status: 'passed', tag, sha,
    startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:05:00Z',
    files: assets.filter(asset => !asset.name.endsWith('.sig')).map(asset => ({
      ...asset, status: 'completed', analysisId: `analysis-${asset.sha256}`, analyzedAt: 1767225600,
      url: `https://www.virustotal.com/gui/file/${asset.sha256}`, ...clearVerdicts(),
      fileInfo: { sha256: asset.sha256, size: asset.size, date: 1767225600, ...clearVerdicts() },
    })),
  };
}
