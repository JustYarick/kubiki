import { chromium } from '@playwright/test';

// Run against pnpm preview; see docs/11-TOPOLOGY-PERFORMANCE.md for methodology.
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const lists = { Namespace: [{ metadata: { uid: 'ns', name: 'perf' } }], Pod: [], Service: [], Node: [], ReplicaSet: [], Deployment: [], ConfigMap: [] };
for (let i = 0; i < 8; i++) lists.Node.push({ metadata: { uid: `node-${i}`, name: `worker-${i}` } });
for (let i = 0; i < 10; i++) {
  lists.Deployment.push({ metadata: { uid: `dep-${i}`, name: `web-${i}`, namespace: 'perf' }, spec: { replicas: 18 }, status: { readyReplicas: 18 } });
  lists.ReplicaSet.push({ metadata: { uid: `rs-${i}`, name: `web-${i}-rs`, namespace: 'perf', ownerReferences: [{ uid: `dep-${i}`, kind: 'Deployment', name: `web-${i}` }] }, spec: { replicas: 18 }, status: { readyReplicas: 18 } });
  lists.Service.push({ metadata: { uid: `svc-${i}`, name: `service-${i}`, namespace: 'perf' }, spec: { selector: { app: `web-${i}` } } });
  lists.ConfigMap.push({ metadata: { uid: `config-${i}`, name: `config-${i}`, namespace: 'perf' } });
}
for (let i = 0; i < 180; i++) lists.Pod.push({ metadata: { uid: `pod-${i}`, name: `pod-${i}`, namespace: 'perf', labels: { app: `web-${i % 10}` }, ownerReferences: [{ uid: `rs-${i % 10}`, kind: 'ReplicaSet', name: `web-${i % 10}-rs` }] }, spec: { nodeName: `worker-${i % 8}`, containers: [{ name: 'app' }], volumes: [{ name: 'config', configMap: { name: `config-${i % 10}` } }] }, status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }] } });
await page.route('**/api/k8s/**', (route) => {
  const url = new URL(route.request().url());
  const json = url.pathname.endsWith('/contexts') ? [{ name: 'test', is_current: true }] : url.pathname.endsWith('/ping') ? { version: { gitVersion: 'v1.34.0' } } : url.pathname.endsWith('/namespaces') ? ['perf'] : { items: lists[url.searchParams.get('kind')] ?? [] };
  return route.fulfill({ json });
});
await page.goto(process.env.BENCH_URL || 'http://127.0.0.1:1422');
await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
await page.getByRole('button', { name: 'Diagram scope', exact: true }).click();
await page.getByRole('option', { name: /^Namespace: perf / }).click();
await page.locator('.react-flow__node').first().waitFor({ timeout: 15000 });
await page.getByRole('status').filter({ hasText: 'Arranging topology' }).waitFor({ state: 'hidden' });
await page.waitForTimeout(1000);
const client = await page.context().newCDPSession(page);
await client.send('Performance.enable');
if (process.env.BENCH_THROTTLE) await client.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.BENCH_THROTTLE) });
for (let i = 0; i < Number(process.env.BENCH_ZOOM || 0); i++) await page.getByRole('button', { name: /^zoom in$/i }).click();
await page.waitForTimeout(500);
const box = await page.locator('.react-flow__pane').boundingBox();
let draggedNode;
let initialNodePosition;
let origin = { x: box.x + box.width / 2, y: box.y + box.height * .75 };
if (process.env.BENCH_MODE === 'node') {
  for (const node of await page.locator('.react-flow__node').all()) {
    const candidate = await node.boundingBox();
    if (candidate.x > box.x + 100 && candidate.x < box.x + box.width - 300 && candidate.y > box.y + 50 && candidate.y < box.y + box.height - 100) { origin = { x: candidate.x + candidate.width / 2, y: candidate.y + candidate.height / 2 }; draggedNode = node; initialNodePosition = await node.getAttribute('style'); break; }
  }
}
const counts = { nodes: await page.locator('.react-flow__node').count(), edges: await page.locator('.react-flow__edge').count(), labels: await page.locator('.react-flow__edge-text').count() };
if (process.env.BENCH_MODE === 'node' && !draggedNode) throw new Error('No visible node was found for the drag benchmark');
const before = await client.send('Performance.getMetrics');
await page.evaluate(() => {
  window.benchFrames = []; window.benchMeasuring = true;
  let previous = performance.now();
  const frame = (now) => { window.benchFrames.push(now - previous); previous = now; if (window.benchMeasuring) requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
});
const started = performance.now();
const transformBefore = await page.locator('.react-flow__viewport').getAttribute('style');
await page.mouse.move(origin.x, origin.y);
await page.mouse.down({ button: process.env.BENCH_MODE === 'node' ? 'left' : 'middle' });
for (let i = 0; i < 120; i++) {
  await page.mouse.move(origin.x + Math.sin(i / 12) * 150, origin.y + Math.cos(i / 12) * 70);
}
await page.mouse.up({ button: process.env.BENCH_MODE === 'node' ? 'left' : 'middle' });
const frames = await page.evaluate(() => { window.benchMeasuring = false; return window.benchFrames; });
const transformAfter = await page.locator('.react-flow__viewport').getAttribute('style');
const after = await client.send('Performance.getMetrics');
const metrics = Object.fromEntries(after.metrics.map(({ name, value }) => [name, value - (before.metrics.find((metric) => metric.name === name)?.value ?? 0)]));
const sorted = [...frames].sort((a, b) => a - b);
console.log(JSON.stringify({ mode: process.env.BENCH_MODE || 'pan', throttle: Number(process.env.BENCH_THROTTLE || 1), gestureMs: performance.now() - started, nodeMoved: draggedNode ? initialNodePosition !== await draggedNode.getAttribute('style') : undefined, counts, moved: transformBefore !== transformAfter, frameCount: frames.length, meanFrameMs: frames.reduce((a, b) => a + b, 0) / frames.length, p95FrameMs: sorted[Math.floor(sorted.length * .95)], over32ms: frames.filter((frame) => frame > 32).length, scriptMs: metrics.ScriptDuration * 1000, layoutMs: metrics.LayoutDuration * 1000, styleMs: metrics.RecalcStyleDuration * 1000, taskMs: metrics.TaskDuration * 1000 }));
if (process.env.BENCH_SCREENSHOT) await page.screenshot({ path: process.env.BENCH_SCREENSHOT });
} finally {
  await browser.close();
}
