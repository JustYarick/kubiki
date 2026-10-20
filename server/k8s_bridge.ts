import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RESOURCE_TYPES, type ResourceQuery } from '../src/core/resources/resource_types.ts';
import { kubectlError, normalizeK8sError, requestError, type RequestInfo } from '../src/providers/errors.ts';

const execFileAsync = promisify(execFile);
export type KubectlExecutor = (args: string[]) => Promise<string>;
const execute: KubectlExecutor = async (args) => (await execFileAsync('kubectl', [...args, '--request-timeout=10s'], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 })).stdout;

/** Injectable executor lets HTTP contract tests run without contacting a cluster. */
export function createK8sMiddleware(run: KubectlExecutor = execute) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/k8s/')) return next();
    const url = new URL(req.url, 'http://localhost');
    const context = url.searchParams.get('context') ?? undefined;
    const operation = url.pathname.slice('/api/k8s/'.length);
    const info: RequestInfo = { operation, context };
    res.setHeader('Content-Type', 'application/json');
    const send = (data: unknown) => res.end(JSON.stringify(data));
    // Literal argv only; never interpolate resource names or context into a shell.
    const kubectl = async (args: string[]) => {
      try { return await run(args); } catch (error) { throw kubectlError(error, info); }
    };
    const invalid = (message: string) => requestError('invalid_request', message, info, 400);
    try {
      const methods: Record<string, string> = { contexts: 'GET', ping: 'GET', namespaces: 'GET', resources: 'GET', logs: 'GET', scale: 'POST' };
      if (!methods[operation]) throw requestError('not_found', 'Endpoint not found', info, 404);
      if (req.method !== methods[operation]) throw requestError('invalid_request', 'Method not allowed', info, 405);
      if (operation === 'contexts') {
        const data = JSON.parse(await kubectl(['config', 'view', '-o', 'json']));
        return send((data.contexts ?? []).map((entry: any) => ({ name: entry.name, cluster: entry.context?.cluster, user: entry.context?.user, namespace: entry.context?.namespace, is_current: entry.name === data['current-context'] })));
      }
      if (!context?.trim()) throw invalid('A Kubernetes context is required');
      const contextArgs = ['--context', context];
      if (operation === 'ping') {
        const data = JSON.parse(await kubectl([...contextArgs, 'version', '-o', 'json']));
        if (!data.serverVersion) throw requestError('unavailable', 'The API server did not return its version', info, 503);
        return send({ status: 'connected', version: data.serverVersion });
      }
      if (operation === 'namespaces') {
        const data = JSON.parse(await kubectl([...contextArgs, 'get', 'namespaces', '-o', 'json']));
        return send((data.items ?? []).map((namespace: any) => namespace.metadata.name));
      }
      if (operation === 'resources') {
        const kind = url.searchParams.get('kind') ?? '';
        const type = RESOURCE_TYPES.find((type) => type.kind === kind);
        const query: ResourceQuery = { context, kind, group: url.searchParams.get('group') ?? '', version: url.searchParams.get('version') ?? '', namespace: url.searchParams.get('namespace') };
        info.resource = query;
        if (!type || query.group !== type.group || query.version !== type.version) throw requestError('unsupported', `Unsupported resource kind or API group/version: ${kind}`, info, 400);
        if (!type.namespaced && query.namespace !== null) throw invalid('Cluster-scoped resources cannot have a namespace');
        const namespaceArgs = !type.namespaced ? [] : query.namespace && query.namespace !== 'all' ? ['-n', query.namespace] : ['-A'];
        const plural = type.group ? `${type.plural}.${type.group}` : type.plural;
        const data = JSON.parse(await kubectl([...contextArgs, 'get', plural, ...namespaceArgs, '-o', 'json']));
        return send(data);
      }
      if (operation === 'logs') {
        const name = url.searchParams.get('name');
        const namespace = url.searchParams.get('namespace');
        const container = url.searchParams.get('container');
        if (!name || !namespace) throw invalid('Pod name and namespace are required');
        return send(await kubectl([...contextArgs, 'logs', `pod/${name}`, '-n', namespace, ...(container ? ['-c', container] : []), '--tail=500', '--timestamps=true']));
      }
      if (operation === 'scale') {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw requestError('forbidden', 'Cross-origin mutations are forbidden', info, 403);
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 16384) throw invalid('Request body too large'); }
        let data: any;
        try { data = JSON.parse(body); } catch { throw invalid('Invalid JSON request body'); }
        const { kind, name, namespace, replicas, context: targetContext } = data ?? {};
        if (!['Deployment', 'StatefulSet'].includes(kind) || !Number.isInteger(replicas) || replicas < 0 || replicas > 100000 || typeof name !== 'string' || !name || typeof namespace !== 'string' || !namespace || targetContext !== context) throw invalid('Invalid scale request');
        const type = RESOURCE_TYPES.find((type) => type.kind === kind)!;
        await kubectl([...contextArgs, 'scale', `${type.plural}.${type.group}`, name, '-n', namespace, `--replicas=${replicas}`]);
        return send({ success: true });
      }
    } catch (error) {
      const failure = normalizeK8sError(error, info);
      res.statusCode = failure.status ?? 500;
      return send({ error: { code: failure.code, message: failure.message, status: failure.status, retryable: failure.retryable, ...info } });
    }
  };
}
