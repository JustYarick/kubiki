import { normalizeMetricList } from '../src/providers/overview_metrics.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
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
      const methods: Record<string, string> = { 'api-resources': 'GET', contexts: 'GET', ping: 'GET', namespaces: 'GET', resources: 'GET', 'custom-resources': 'GET', logs: 'GET', scale: 'POST', secrets: 'POST', metrics: 'GET', apply: 'POST', delete: 'POST', mutate: 'POST' };
      if (!methods[operation]) throw requestError('not_found', 'Endpoint not found', info, 404);
      if (req.method !== methods[operation]) throw requestError('invalid_request', 'Method not allowed', info, 405);
      if (operation === 'scale' || operation === 'secrets' || operation === 'apply' || operation === 'delete' || operation === 'mutate') throw requestError('forbidden', 'Kubernetes changes require the desktop application and backend system confirmation. HTTP bridge is read-only', info, 403);
      if (operation === 'contexts') {
        const data = JSON.parse(await kubectl(['config', 'view', '-o', 'json']));
        return send((data.contexts ?? []).map((entry: any) => ({ name: entry.name, cluster: entry.context?.cluster, user: entry.context?.user, namespace: entry.context?.namespace, is_current: entry.name === data['current-context'] })));
      }
      if (!context?.trim()) throw invalid('A Kubernetes context is required');
      const contextArgs = ['--context', context];
      if (operation === 'api-resources') return send(await kubectl([...contextArgs, 'api-resources', '--verbs=list', '-o', 'wide', '--no-headers']));
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
        if (!type || query.group !== type.group || !/^v[1-9]\d*(?:(?:alpha|beta)\d+)?$/.test(query.version)) throw requestError('unsupported', `Unsupported resource kind or API group/version: ${kind}`, info, 400);
        if (!type.namespaced && query.namespace !== null) throw invalid('Cluster-scoped resources cannot have a namespace');
        const namespaceArgs = !type.namespaced ? [] : query.namespace && query.namespace !== 'all' ? ['-n', query.namespace] : ['-A'];
        const plural = type.group ? `${type.plural}.${type.group}` : type.plural;
        const data = JSON.parse(await kubectl([...contextArgs, 'get', plural, ...namespaceArgs, '-o', 'json']));
        return send(data);
      }
      if (operation === 'custom-resources') {
        const name = url.searchParams.get('name') ?? '';
        const uid = url.searchParams.get('uid');
        const namespace = url.searchParams.get('namespace');
        if (!/^[a-z0-9][a-z0-9.-]*$/.test(name) || !uid) throw invalid('CRD name and UID are required');
        if (namespace !== null && !isValidNamespaceName(namespace)) throw invalid('Invalid namespace');
        const crd = JSON.parse(await kubectl([...contextArgs, 'get', `customresourcedefinitions.apiextensions.k8s.io/${name}`, '-o', 'json']));
        if (crd.metadata?.uid !== uid) throw requestError('conflict', 'This CRD has been replaced. Refresh the resource list.', info, 409);
        const { group, names, scope } = crd.spec ?? {};
        if (!/^[a-z0-9][a-z0-9.-]*$/.test(group ?? '') || !/^[a-z][a-z0-9-]*$/.test(names?.plural ?? '') || !['Namespaced', 'Cluster'].includes(scope)) throw invalid('Invalid CRD definition');
        const namespaceArgs = scope === 'Namespaced' ? namespace ? ['-n', namespace] : ['-A'] : [];
        return send(JSON.parse(await kubectl([...contextArgs, 'get', `${names.plural}.${group}`, ...namespaceArgs, '-o', 'json'])));
      }
      if (operation === 'logs') {
        const name = url.searchParams.get('name');
        const namespace = url.searchParams.get('namespace');
        const container = url.searchParams.get('container');
        if (!name || !namespace) throw invalid('Pod name and namespace are required');
        return send(await kubectl([...contextArgs, 'logs', `pod/${name}`, '-n', namespace, ...(container ? ['-c', container] : []), '--tail=500', '--timestamps=true']));
      }
    } catch (error) {
      const failure = normalizeK8sError(error, info);
      res.statusCode = failure.status ?? 500;
      return send({ error: { code: failure.code, message: failure.message, status: failure.status, retryable: failure.retryable, ...info } });
    }
  };
}
