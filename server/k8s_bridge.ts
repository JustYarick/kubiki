import { normalizeMetricList } from '../src/providers/overview_metrics.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { encodeSecretRows } from '../src/core/resources/secret_data.ts';
import { RESOURCE_TYPES, isValidNamespaceName, type ResourceQuery } from '../src/core/resources/resource_types.ts';
import { kubectlError, normalizeK8sError, requestError, type RequestInfo } from '../src/providers/errors.ts';

export type KubectlExecutor = (args: string[], input?: string) => Promise<string>;
const execute: KubectlExecutor = (args, input) => new Promise((resolve, reject) => {
  const child = execFile('kubectl', [...args, '--request-timeout=10s'], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) { Object.assign(error, { stderr }); reject(error); } else resolve(stdout);
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
});

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
      const methods: Record<string, string> = { contexts: 'GET', ping: 'GET', namespaces: 'GET', resources: 'GET', logs: 'GET', scale: 'POST', secrets: 'POST', metrics: 'GET' };
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
      if (operation === 'metrics') {
        const namespace = url.searchParams.get('namespace');
        if (namespace !== null && (!isValidNamespaceName(namespace) || namespace === 'all')) throw invalid('Invalid metrics namespace');
        const source = async (kind: 'pods' | 'nodes') => {
          const path = `/apis/metrics.k8s.io/v1beta1/${namespace && kind === 'pods' ? `namespaces/${namespace}/` : ''}${kind}`;
          try { return { items: normalizeMetricList(JSON.parse(await kubectl([...contextArgs, 'get', '--raw', path])), kind), error: null }; }
          catch (error) { const failure = normalizeK8sError(error, { operation: `${kind}_metrics`, context });return { items: null, error: { code: failure.code, message: failure.message, status: failure.status, retryable: failure.retryable, operation: `${kind}_metrics`, context } }; }
        };
        const [pods, nodes] = await Promise.all([source('pods'), namespace ? Promise.resolve({ items: null, error: null }) : source('nodes')]);
        return send({ context, namespace, pods, nodes });
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
      if (operation === 'secrets') {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw requestError('forbidden', 'Cross-origin mutations are forbidden', info, 403);
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 2 * 1024 * 1024) throw invalid('Request body too large'); }
        let request: any;
        try { request = JSON.parse(body); } catch { throw invalid('Invalid JSON request body'); }
        const { resource, resource_version, data } = request ?? {};
        if (!resource || resource.context !== context || resource.kind !== 'Secret' || resource.group !== '' || resource.version !== 'v1' || typeof resource.name !== 'string' || !resource.name || resource.name.length > 253 || !resource.name.split('.').every((label: string) => isValidNamespaceName(label)) || typeof resource.namespace !== 'string' || !isValidNamespaceName(resource.namespace) || resource.namespace === 'all' || typeof resource.uid !== 'string' || !resource.uid || typeof resource_version !== 'string' || !resource_version || !data || typeof data !== 'object' || Array.isArray(data) || Object.values(data).some(v => typeof v !== 'string')) throw invalid('An exact Secret identity, version and base64 data are required');
        try { encodeSecretRows(Object.entries(data).map(([key, value], id) => ({ id, key, value: value as string, mode: 'base64' }))); }
        catch { throw invalid('Invalid Secret keys, base64 values or data exceeds 1 MiB'); }
        const target = [...contextArgs, 'get', 'secret', resource.name, '-n', resource.namespace, '-o', 'json'];
        const current = JSON.parse(await kubectl(target));
        if (current.metadata?.uid !== resource.uid || current.metadata?.resourceVersion !== resource_version) throw requestError('conflict', 'Secret changed or was recreated. Reload before editing again', info, 409);
        if (current.immutable) throw invalid('This Secret is immutable');
        current.data = data;
        delete current.stringData;
        try { return send(JSON.parse(await run([...contextArgs, 'replace', '-f', '-', '-o', 'json'], JSON.stringify(current)))); }
        catch (error) {
          const failure = kubectlError(error, info);
          throw requestError(failure.code, 'Secret update failed; check permissions, connectivity and object version. Refresh to verify saved state', info, failure.status);
        }
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
