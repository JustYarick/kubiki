import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const media = path.join(root, 'website/media');
const temporary = await mkdtemp(path.join(tmpdir(), 'kubiki-website-media-'));
const { values } = parseArgs({ options: { scene: { type: 'string', multiple: true } } });
const baseURL = 'http://127.0.0.1:1432';
const viewport = { width: 1440, height: 900 };
execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });

async function click(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('Capture target has no visible bounds');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await pause(160);
  await page.evaluate(({ x, y }) => window.__kubikiRipple?.(x, y), {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  await locator.click();
  await pause(550);
}

const explorer = page => page.getByTestId('explorer-panel');
const details = page => page.getByTestId('resource-details');
const table = page => page.getByTestId('resource-table');

async function pods(page) {
  await explorer(page).getByRole('button', { name: /^Workloads(?: \d+)?$/ }).click();
  await explorer(page).locator('[data-resource-type="Pod"]').click();
  await expect(table(page).locator('tbody tr').first()).toBeVisible();
}

async function gateway(page) {
  await pods(page);
  await page.getByPlaceholder('Filter pods…').fill('api-gateway');
  return table(page).getByText('api-gateway-7f9c8b6d5-q7x9z', { exact: true });
}

const scenes = {
  overview: {
    async prepare(page) {
      await page.getByRole('button', { name: 'Open Overview', exact: true }).click();
      await expect(page.getByRole('img', { name: 'CPU usage history', exact: true })).toHaveAttribute('data-samples', /[1-9]/);
      await expect.poll(async () => Number(await page.getByRole('img', { name: 'CPU usage history', exact: true }).getAttribute('data-samples'))).toBeGreaterThan(1);
    },
    async act(page) {
      const cpu = page.getByRole('img', { name: 'CPU usage history', exact: true });
      const box = await cpu.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5, { steps: 15 });
        await pause(400);
        await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.45, { steps: 22 });
      }
      await pause(650);
      const overview = page.getByTestId('cluster-overview');
      await overview.evaluate(element => element.scrollTo({ top: 440, behavior: 'smooth' }));
      await pause(1100);
      await click(page, page.getByRole('button', { name: 'Critical problems', exact: true }));
      await pause(900);
      await click(page, page.getByRole('button', { name: 'Warning problems', exact: true }));
      await pause(800);
      await overview.evaluate(element => element.scrollTo({ top: 0, behavior: 'smooth' }));
      await pause(900);
    },
  },
  resources: {
    prepare: pods,
    async act(page) {
      const search = page.getByPlaceholder('Filter pods…');
      await click(page, search);
      await search.pressSequentially('payment-worker', { delay: 65 });
      await pause(650);
      await click(page, table(page).getByText('payment-worker-67f98b984-pv4n8', { exact: true }));
      await expect(details(page)).toContainText('CrashLoopBackOff');
      await search.fill('');
      await pause(1000);
      await click(page, details(page).getByRole('tab', { name: 'Events', exact: true }));
      await pause(1050);
      await click(page, details(page).getByRole('tab', { name: 'Related', exact: true }));
      await expect(details(page).getByRole('region', { name: 'Resource relationships' })).toBeVisible();
      await pause(1100);
      await click(page, details(page).getByRole('tab', { name: 'Overview', exact: true }));
    },
  },
  yaml: {
    async prepare(page) {
      await (await gateway(page)).dblclick();
      if (await details(page).getByRole('button', { name: 'Close details', exact: true }).isVisible()) {
        await details(page).getByRole('button', { name: 'Close details', exact: true }).click();
      }
      await expect(page.locator('main .monaco-editor')).toBeVisible();
      await expect(page.locator('main .view-lines')).toContainText('api-gateway');
    },
    async act(page) {
      await click(page, page.getByRole('button', { name: 'Find', exact: true }));
      await expect(page.locator('.monaco-editor .find-widget')).toBeVisible();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.insertText('containers');
      await pause(1100);
      await page.keyboard.press('Escape');
      await click(page, page.getByRole('button', { name: 'Show server fields', exact: true }));
      await pause(1100);
      await click(page, page.getByRole('button', { name: 'Show server fields', exact: true }));
      await click(page, page.getByRole('button', { name: 'Split Editor', exact: true }));
      await pause(1300);
    },
  },
  topology: {
    async prepare(page) {
      await explorer(page).getByRole('button', { name: /^Network(?: \d+)?$/ }).click();
      await explorer(page).locator('[data-resource-type="Service"]').click();
      await page.getByPlaceholder('Filter services…').fill('payments-redis');
      await table(page).locator('tbody tr').filter({ has: page.getByText('payments-prod', { exact: true }) }).click();
      await details(page).getByRole('button', { name: 'Topology', exact: true }).click();
      await details(page).getByRole('button', { name: 'Close details', exact: true }).click();
      await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
      await expect(page.getByText('Arranging topology…')).toHaveCount(0);
      await page.getByTestId('topology-events').getByRole('button', { name: /^Recent events/ }).click();
      await pause(900);
    },
    async act(page) {
      await click(page, page.locator('.react-flow__controls-zoomin'));
      await pause(800);
      await click(page, page.locator('.react-flow__controls-fitview'));
      await pause(800);
      const node = page.locator('.react-flow__node').filter({ has: page.getByTitle('payments-redis', { exact: true }) }).filter({ has: page.locator('[data-resource-kind="Service"]') });
      await click(page, node);
      await expect(details(page)).toBeVisible();
      await pause(1200);
      await click(page, details(page).getByRole('button', { name: 'Close details', exact: true }));
      await pause(800);
    },
  },
  helm: {
    async prepare(page) {
      await explorer(page).getByRole('button', { name: /^Helm(?: \d+)?$/ }).click();
      await page.getByRole('button', { name: 'Open Helm Releases', exact: true }).click();
      await expect(page.getByTestId('helm-releases').getByRole('row').nth(1)).toBeVisible();
    },
    async act(page) {
      const view = page.getByTestId('helm-releases');
      const search = view.getByRole('textbox', { name: 'Search Helm releases by name or namespace' });
      await click(page, search);
      await search.pressSequentially('payments-prod-api', { delay: 60 });
      await pause(700);
      await click(page, view.getByRole('row', { name: 'Inspect Helm release payments-prod-api in payments-prod', exact: true }));
      await search.fill('');
      await pause(800);
      await click(page, details(page).getByRole('tab', { name: 'History', exact: true }));
      await pause(800);
      await click(page, details(page).getByRole('button', { name: 'Inspect Helm revision 1', exact: true }));
      await pause(800);
      await click(page, details(page).getByRole('tab', { name: 'Manifest', exact: true }));
      await pause(1200);
    },
  },
  agent: {
    initScript: () => {
      const w = window;
      const roPolicy = {
        resources: true, events: true, logs: true, metrics: true,
        clusterResources: false, secrets: 'none', configMaps: 'metadata',
        workloadConfiguration: false, annotations: false, customResources: 'metadata',
        contexts: ['*'], namespaces: ['*'], writes: [], maxReplicas: 10,
        rules: [], deniedPaths: [], alwaysAsk: [], planDisabledTools: [], actionDisabledTools: [],
      };
      const rwPolicy = { ...roPolicy, writes: ['create', 'update', 'scale', 'restart'] };
      const settings = {
        runtime: 'kubiki',
        providers: [{ id: 'anthropic', name: 'Anthropic Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' }],
        defaultProvider: 'anthropic',
        defaultModel: 'claude-sonnet-4',
        options: {},
        policy: rwPolicy,
        instructions: '',
        confirmReads: false,
        mcpServer: { enabled: true, port: 3847, requireAuth: false },
        mcpProfiles: [
          { id: 'read-only', name: 'Read-only', inheritShared: false, policy: roPolicy },
          { id: 'action', name: 'Action', inheritShared: true, policy: rwPolicy },
        ],
        activeMcpProfileId: 'read-only',
        kubikiPlanProfileId: 'read-only',
        kubikiActionProfileId: 'action',
      };
      const history = new Map();
      const sessions = new Map();
      const callbacks = new Map();
      let sequence = 0;
      const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      w.__TAURI_INTERNALS__ = {
        transformCallback: (cb) => { callbacks.set(++sequence, cb); return sequence; },
        unregisterCallback: (id) => callbacks.delete(id),
        invoke: async (command, args = {}) => {
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten' || command.startsWith('stop_')) return ++sequence;
          if (command === 'ai_history_load') return { conversations: [...history.values()], preferences: { enabled: true, retentionDays: 30, allowExport: true }, migrated: true };
          if (command === 'ai_history_sync') { for (const id of args.deleted ?? []) history.delete(id); for (const c of args.documents ?? []) history.set(c.id, structuredClone(c)); return; }
          if (command === 'ai_get_settings') return { settings: structuredClone(settings), credentials: { anthropic: true } };
          if (command === 'ai_list_skills') return [];
          if (command === 'ai_list_models') return [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200000, maxOutputTokens: 8192, tools: true }];
          if (command === 'ai_preview_policy') return { explanation: { allowed: false, explanation: 'Plan forbids writes', dataAccess: 'content', writeAllowed: false }, issues: [] };
          if (command === 'ai_mcp_set_scope') return;
          if (command === 'ai_mcp_http_status') return { enabled: true, running: true, port: 3847, requireAuth: false, url: 'http://127.0.0.1:3847/mcp', scope: { context: 'kubiki-demo', namespaces: ['backend'], allNamespaces: false }, error: null, token: null };
          if (command === 'ai_create_session') {
            const id = `demo-${++sequence}`;
            const session = { ...args.request, id, mode: 'ask', phase: 'plan', policy: roPolicy };
            sessions.set(id, session);
            return session;
          }
          if (command === 'ai_set_mode' || command === 'ai_set_phase') {
            const s = sessions.get(args.sessionId) ?? { scope: { context: 'kubiki-demo', namespaces: ['backend'], allNamespaces: false }, mode: 'ask', phase: 'plan', policy: roPolicy };
            if (args.mode) s.mode = args.mode;
            if (args.phase) s.phase = args.phase;
            return { id: args.sessionId, scope: s.scope, mode: s.mode, phase: s.phase, policy: s.policy };
          }
          if (command === 'ai_stop') return;
          if (command === 'ai_send_message') {
            const emit = (ev) => args.onEvent.onmessage(ev);
            const scope = sessions.get(args.sessionId)?.scope ?? { context: 'kubiki-demo', namespaces: ['backend'], allNamespaces: false };
            emit({ type: 'status', status: 'running' });
            await delay(220);
            emit({ type: 'text_delta', text: '<think>Inspecting Pod payment-worker-67f98b984-pv4n8 container termination state and recent warning events in namespace backend.</think>' });
            await delay(260);
            emit({ type: 'tool_started', call: { id: 'diag-1', name: 'get_pod_diagnostics', arguments: { namespace: 'backend', name: 'payment-worker-67f98b984-pv4n8' } } });
            await delay(420);
            emit({ type: 'tool_completed', id: 'diag-1', result: { evidenceId: 'ev-pod-1', evidence: { completeness: 'complete' }, issuesSummary: ['Container payment-worker in CrashLoopBackOff (6 restarts)', 'Last termination: OOMKilled (exitCode 137)'], phase: 'Running', waitingReason: 'CrashLoopBackOff', lastTerminatedReason: 'OOMKilled', exitCode: 137, restartCount: 6, memoryLimit: '256Mi' } });
            await delay(220);
            emit({ type: 'tool_started', call: { id: 'evt-1', name: 'get_events', arguments: { namespace: 'backend', involvedObject: 'payment-worker-67f98b984-pv4n8' } } });
            await delay(360);
            emit({ type: 'tool_completed', id: 'evt-1', result: { evidenceId: 'ev-evt-1', items: [{ reason: 'OOMKilling', message: 'Memory cgroup out of memory: Killed process payment-worker' }, { reason: 'BackOff', message: 'Back-off restarting failed container payment-worker' }] } });
            await delay(220);
            emit({ type: 'text_delta', text: '**Root cause:** `payment-worker` hits its `256Mi` memory ceiling during batch processing (`OOMKilled`, exit code `137`, 6 restarts).\n\n' });
            await delay(220);
            emit({ type: 'text_delta', text: '| Signal | Observed Value |\n| --- | --- |\n| Container State | `CrashLoopBackOff` (6 restarts) |\n| Last Termination | `OOMKilled` (`exitCode: 137`) |\n| Current Limit | `256Mi` |\n' });
            await delay(260);
            const plan = {
              schemaVersion: 1,
              sessionId: args.sessionId,
              id: 'remediation-plan-1',
              version: 1,
              title: 'Raise payment-worker memory limit to 512Mi',
              kind: 'remediation',
              diagnosis: 'Container exceeded its 256Mi memory limit (OOMKilled, exitCode 137).',
              uncertainty: 'Monitor heap usage after rollout to confirm 512Mi headroom.',
              bodyMarkdown: 'Update the Deployment container memory limit from `256Mi` to `512Mi` and verify rollout readiness.',
              scope,
              evidenceIds: ['ev-pod-1', 'ev-evt-1'],
              status: 'draft',
              policyRevision: 0,
              createdAt: new Date().toISOString(),
              steps: [{
                id: 'step-memory',
                title: 'Update Deployment payment-worker memory limit to 512Mi',
                action: 'update',
                target: { group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'backend', name: 'payment-worker' },
                reason: 'Eliminate OOMKilled restarts observed in container diagnostics',
                risk: 'Higher per-pod memory reservation on scheduling nodes',
                verification: 'Deployment readyReplicas matches spec.replicas without restarts',
                dependsOn: [],
                dependsOnAccepted: [],
              }],
            };
            emit({ type: 'tool_started', call: { id: 'plan-1', name: 'propose_plan', arguments: { title: plan.title } } });
            emit({ type: 'plan_updated', plan });
            emit({ type: 'tool_completed', id: 'plan-1', result: { planArtifact: plan, executed: false } });
            emit({ type: 'usage', inputTokens: 1420, outputTokens: 285 });
            emit({ type: 'status', status: 'completed' });
            return;
          }
          return null;
        },
      };
    },
    async prepare(page) {
      await pods(page);
      await page.getByPlaceholder('Filter pods…').fill('payment-worker-67f98b984-pv4n8');
      await table(page).getByText('payment-worker-67f98b984-pv4n8', { exact: true }).click();
      await expect(details(page)).toContainText('CrashLoopBackOff');
      await expect(details(page).getByRole('button', { name: 'Investigate with AI', exact: true })).toBeVisible();
    },
    async act(page) {
      await click(page, details(page).getByRole('button', { name: 'Investigate with AI', exact: true }));
      const agent = page.getByRole('region', { name: 'AI Agent workspace', exact: true });
      await expect(agent).toBeVisible();
      await pause(550);
      await click(page, agent.getByRole('button', { name: 'Send', exact: true }));
      await expect(agent.getByRole('article', { name: 'Agent response' }).last()).toContainText('OOMKilled', { timeout: 15000 });
      await expect(agent.getByRole('button', { name: 'Send', exact: true })).toBeVisible({ timeout: 15000 });
      await pause(1200);
    },
  },
};

const selected = values.scene ?? Object.keys(scenes);
for (const name of selected) if (!scenes[name]) throw new Error(`Unknown scene: ${name}`);

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1432', '--strictPort'], {
  cwd: root,
  env: { ...process.env, KUBECONFIG: path.join(root, 'tests/fixtures/empty-kubeconfig.yaml') },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let browser;
let succeeded = false;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Capture server did not start')), 30000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Capture server exited: ${code}`)); });
    server.stderr.on('data', chunk => process.stderr.write(chunk));
    server.stdout.on('data', chunk => { if (chunk.toString().includes(baseURL)) { clearTimeout(timer); resolve(); } });
  });

  await mkdir(media, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined),
    args: ['--no-sandbox'],
  });

  for (const name of selected) {
    console.log(`Recording website media for ${name}…`);
    const videoDir = path.join(temporary, name);
    await mkdir(videoDir, { recursive: true });
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      locale: 'en-US',
      recordVideo: { dir: videoDir, size: viewport },
    });
    const errors = [];
    await context.route('**/api/k8s/**', route => { errors.push(`Unexpected cluster request: ${route.request().url()}`); return route.abort(); });
    await context.addInitScript(() => {
      localStorage.setItem('kubiki.settings.v3', JSON.stringify({ state: { uiScale: 100, sidebarWidth: 220, inspectorWidth: 520 }, version: 0 }));
    });
    if (scenes[name].initScript) {
      await context.addInitScript(scenes[name].initScript);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));

    const video = page.video();
    const recordStart = performance.now();
    await page.goto(`${baseURL}/?demo=1`);
    await expect(page.getByTitle('Switch Kubernetes Cluster Context', { exact: true })).toContainText('kubiki-demo');
    await page.evaluate(() => document.fonts.ready);
    await scenes[name].prepare(page);

    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = `
        @keyframes kubikiRippleAnim {
          0% { transform: translate(-50%,-50%) scale(0.35); opacity: 0.9; }
          100% { transform: translate(-50%,-50%) scale(2.1); opacity: 0; }
        }
      `;
      document.head.append(style);
      const cursor = document.createElement('div');
      cursor.innerHTML = '<svg width="20" height="26" viewBox="0 0 20 26"><path d="M2 2 L2 21 L7 16 L11 24 L15 22 L11 14 L18 14 Z" fill="#ffffff" stroke="#0d1017" stroke-width="1.6"/></svg>';
      cursor.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(900px,180px);filter:drop-shadow(0 2px 6px rgba(0,0,0,0.55));';
      document.body.append(cursor);
      document.addEventListener('mousemove', event => { cursor.style.transform = `translate(${event.clientX}px,${event.clientY}px)`; });
      window.__kubikiRipple = (x, y) => {
        const ring = document.createElement('div');
        ring.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:24px;height:24px;border-radius:999px;border:2px solid #6fa0ff;background:rgba(53,116,240,0.22);z-index:2147483646;pointer-events:none;animation:kubikiRippleAnim 420ms cubic-bezier(.22,1,.36,1) forwards;`;
        document.body.append(ring);
        setTimeout(() => ring.remove(), 460);
      };
    });

    await pause(300);
    const clipStartSec = (performance.now() - recordStart) / 1000;
    await pause(700);
    await scenes[name].act(page);
    await pause(1100);
    const clipEndSec = (performance.now() - recordStart) / 1000;

    if (errors.length) throw new Error(errors.join('\n'));
    const fullPng = path.join(temporary, `${name}-poster.png`);
    await page.screenshot({ path: fullPng });

    await context.close();
    const rawVideo = await video.path();

    const webmPath = path.join(media, `${name}.webm`);
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', clipStartSec.toFixed(2),
      '-to', clipEndSec.toFixed(2),
      '-i', rawVideo,
      '-an', '-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0',
      '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1',
      '-pix_fmt', 'yuv420p',
      webmPath,
    ], { stdio: 'inherit' });

    const mp4Path = path.join(media, `${name}.mp4`);
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', clipStartSec.toFixed(2),
      '-to', clipEndSec.toFixed(2),
      '-i', rawVideo,
      '-an', '-c:v', 'libopenh264', '-b:v', '1100k',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      mp4Path,
    ], { stdio: 'inherit' });

    const webpFull = path.join(media, `${name}.webp`);
    const webpSmall = path.join(media, `${name}-960.webp`);
    execFileSync('magick', [fullPng, '-strip', '-quality', '92', webpFull], { stdio: 'inherit' });
    execFileSync('magick', [fullPng, '-resize', '960x', '-strip', '-quality', '88', webpSmall], { stdio: 'inherit' });

    const webmSize = ((await stat(webmPath)).size / 1024).toFixed(0);
    const mp4Size = ((await stat(mp4Path)).size / 1024).toFixed(0);
    console.log(`${name}: ${webmSize} KB WebM / ${mp4Size} KB MP4 (${(clipEndSec - clipStartSec).toFixed(1)}s) + WebP posters`);
  }
  succeeded = true;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  if (succeeded) await rm(temporary, { recursive: true, force: true });
  else console.error(`Capture diagnostics: ${temporary}`);
}
