import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseHelmHistory, parseHelmReleases, parseHelmRepositories, validateHelmDocument, validateHelmTarget } from '../src/providers/helm_types.ts';
import { normalizeK8sError, requestError } from '../src/providers/errors.ts';
import { queuedRead } from '../src/providers/read_queue.ts';

export type HelmExecutor = (args: string[], signal?: AbortSignal) => Promise<string>;
const execute: HelmExecutor = (args, signal) => new Promise((resolve, reject) => {
  const child = execFile('helm', args, { signal, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stderr })); else resolve(stdout);
  });
  child.stdin?.end();
});

/** All routes are reads; no arbitrary args, repository updates or release mutations. */
export function createHelmMiddleware(run: HelmExecutor = execute) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/k8s/helm/')) return next();
    const url = new URL(req.url, 'http://localhost');
    const operation = url.pathname.slice('/api/k8s/helm/'.length);
    const context = url.searchParams.get('context') ?? undefined;
    const info = { operation: 'helm', context };
    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const invalid = (message: string) => requestError('invalid_request', message, info, 400);
    res.setHeader('Content-Type', 'application/json');
    const send = (data: unknown) => res.end(JSON.stringify(data));
    const helm = async (args: string[], emptyRepos = false) => {
      try { return await queuedRead(() => run(args, controller.signal), controller.signal); }
      catch (error) {
        const e = error as { code?: string; killed?: boolean; stderr?: string; message?: string };
        if (e.code === 'ENOENT') throw requestError('bridge_unavailable', 'Helm is not installed or is not available in PATH. Install Helm and restart Kubiki.', info, 503);
        if (e.killed) throw requestError('timeout', 'Helm request timed out. Check cluster connectivity and retry.', info, 504);
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw requestError('internal', 'Helm output exceeds the display limit. Use the Helm CLI for this release.', info, 413);
        const message = e.stderr?.trim() || 'Helm command failed';
        if (emptyRepos && message.replace(/^Error: /, '') === 'no repositories to show') return '[]';
        const lower = message.toLowerCase();
        if (lower.includes('forbidden')) throw requestError('forbidden', message, info, 403);
        if (lower.includes('unauthorized') || lower.includes('provide credentials')) throw requestError('unauthorized', message, info, 401);
        if (lower.includes('release: not found') || lower.includes('release: not loaded')) throw requestError('not_found', message, info, 404);
        if (/deadline exceeded|i\/o timeout|request timed out/.test(lower)) throw requestError('timeout', message, info, 504);
        throw requestError('unavailable', message, info, 503);
      }
    };
    const list = (text: string): unknown => text.trim() ? JSON.parse(text) ?? [] : [];
    try {
      if (operation === 'mutate') throw requestError('forbidden', 'Helm changes require desktop backend system confirmation. HTTP bridge is read-only.', info, 403);
      if (!['inventory', 'repositories', 'history', 'content', 'charts'].includes(operation)) throw requestError('not_found', 'Endpoint not found', info, 404);
      if (req.method !== 'GET') throw requestError('invalid_request', 'Method not allowed', info, 405);
      if (operation === 'repositories') return send(parseHelmRepositories(list(await helm(['repo', 'list', '--output=json'], true))));
      if (operation === 'charts') {
        const query = url.searchParams.get('query') ?? '';
        if (query.length > 200 || query.startsWith('-') || /[\x00-\x1f\x7f]/.test(query)) throw invalid('Invalid chart search');
        return send(list(await helm(['search', 'repo', query, '--output=json', '--versions'])));
      }
      const namespace = url.searchParams.get('namespace');
      validateHelmTarget(context ?? '', namespace);
      const args = [`--kube-context=${context}`];
      if (operation === 'inventory') {
        args.push('list', '--output=json', '--max=0', namespace ? `--namespace=${namespace}` : '--all-namespaces', '--deployed', '--failed', '--pending', '--uninstalled', '--superseded', '--uninstalling');
        const items = parseHelmReleases(list(await helm(args)));
        if (namespace && items.some(item => item.namespace !== namespace)) throw requestError('internal', 'Helm returned releases outside the requested namespace', info, 500);
        return send(items);
      }
      const name = url.searchParams.get('name') ?? '';
      validateHelmTarget(context!, namespace, name);
      args.push(`--namespace=${namespace}`);
      if (operation === 'history') return send(parseHelmHistory(list(await helm([...args, 'history', name, '--output=json', '--max=256']))));
      const document = url.searchParams.get('document') ?? '';
      const revision = Number(url.searchParams.get('revision'));
      validateHelmDocument(document, revision);
      return send(await helm([...args, 'get', document, name, `--revision=${revision}`, ...(document === 'values' ? ['--output=yaml'] : [])]));
    } catch (error) {
      const failure = normalizeK8sError(error, info);
      res.statusCode = failure.status ?? 500;
      send({ error: { code: failure.code, message: failure.message, status: failure.status, retryable: failure.retryable, ...info } });
    }
  };
}
