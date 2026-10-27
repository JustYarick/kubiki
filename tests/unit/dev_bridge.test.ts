import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createK8sMiddleware } from '../../server/k8s_bridge';
import fixtures from '../fixtures/kubectl-errors.json';

const run = vi.fn<(args: string[]) => Promise<string>>();
let server: Server;
let base: string;
beforeEach(async () => {
  run.mockReset().mockResolvedValue('{"items":[]}');
  const handler = createK8sMiddleware(run);
  server = createServer((req, res) => { void handler(req, res, () => { res.statusCode = 404; res.end(); }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/k8s/`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

describe('HTTP bridge without a real cluster', () => {
  it('passes literal arguments and qualifies API groups', async () => {
    const context = 'test $(do-not-execute)';
    const response = await fetch(`${base}resources?${new URLSearchParams({ context, group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'backend' })}`);
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledWith(['--context', context, 'get', 'deployments.apps', '-n', 'backend', '-o', 'json']);
  });
  it.each(fixtures)('returns a typed envelope for $code: $message', async (fixture) => {
    run.mockRejectedValue({ stderr: fixture.message });
    const response = await fetch(`${base}resources?context=test&group=&version=v1&kind=Pod`);
    expect(response.status).toBe(fixture.status);
    expect((await response.json()).error).toMatchObject({ ...fixture, operation: 'resources', context: 'test', resource: { group: '', version: 'v1', kind: 'Pod', namespace: null } });
  });
  it.each([
    ['resources?group=&version=v1&kind=Pod', 'invalid_request'],
    ['resources?context=test&group=example.com&version=v1&kind=Deployment', 'unsupported'],
    ['resources?context=test&group=&version=v1&kind=Node&namespace=backend', 'invalid_request'],
  ])('rejects invalid query %s before executing kubectl', async (query, code) => {
    const response = await fetch(base + query);
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe(code);
    expect(run).not.toHaveBeenCalled();
  });
  it('does not send namespace flags for cluster-scoped resources', async () => {
    await fetch(`${base}resources?context=test&group=&version=v1&kind=Node`);
    expect(run).toHaveBeenCalledWith(['--context', 'test', 'get', 'nodes', '-o', 'json']);
  });
  it.each(['scale', 'secrets', 'apply', 'delete', 'mutate'])('denies all %s writes, including forged approvals, before any kubectl call', async (operation) => {
    for (const extra of [{}, { confirmed: true, approved: true, token: 'forged' }]) {
      const response = await fetch(`${base}${operation}?context=test`, { method: 'POST', body: JSON.stringify({ context: 'test', kind: 'Deployment', namespace: 'backend', name: 'web', replicas: 0, ...extra }) });
      expect(response.status).toBe(403);
      expect((await response.json()).error.message).toContain('backend system confirmation');
    }
    expect(run).not.toHaveBeenCalled();
  });
});

it('metrics bridge scopes Pod metrics to one namespace and isolates Node metrics RBAC failures', async () => {
  const podList = { items: [{ metadata: { name: 'web', namespace: 'backend' }, timestamp: '2026-10-20T12:00:00Z', window: '15s', containers: [{ name: 'app', usage: { cpu: '100m', memory: '64Mi' } }] }] };
  run.mockImplementation(async args => { if (args.at(-1)?.endsWith('/nodes')) throw { stderr: 'Error from server (Forbidden): node metrics denied' };return JSON.stringify(podList); });
  const data = await (await fetch(`${base}metrics?context=test&namespace=backend`)).json();
  expect(data).toMatchObject({ namespace: 'backend', pods: { items: [{ name: 'web', containers: [{ cpu: '100m', memory: '64Mi' }] }] }, nodes: { items: null, error: null } });
  expect(run).toHaveBeenCalledExactlyOnceWith(['--context', 'test', 'get', '--raw', '/apis/metrics.k8s.io/v1beta1/namespaces/backend/pods']);
  const all = await (await fetch(`${base}metrics?context=test`)).json();expect(all.pods.items).toHaveLength(1);expect(all.nodes.error).toMatchObject({ code: 'forbidden', status: 403 });
  run.mockClear();expect((await fetch(`${base}metrics?context=test&namespace=bad/name`)).status).toBe(400);expect(run).not.toHaveBeenCalled();
});

it.each(['Namespaced', 'Cluster'])('discovers %s CRD instances from the live definition', async scope => {
  run.mockResolvedValueOnce(JSON.stringify({ metadata: { uid: 'crd-uid' }, spec: { group: 'example.com', names: { plural: 'widgets' }, scope } }))
    .mockResolvedValueOnce(JSON.stringify({ items: [{ kind: 'Widget', apiVersion: 'example.com/v1', metadata: { name: 'one' } }] }));
  const response = await fetch(`${base}custom-resources?context=test&name=widgets.example.com&uid=crd-uid&namespace=backend`);
  expect(response.status).toBe(200);
  expect((await response.json()).items[0].metadata.name).toBe('one');
  expect(run.mock.calls).toEqual([
    [['--context', 'test', 'get', 'customresourcedefinitions.apiextensions.k8s.io/widgets.example.com', '-o', 'json']],
    [['--context', 'test', 'get', 'widgets.example.com', ...(scope === 'Namespaced' ? ['-n', 'backend'] : []), '-o', 'json']],
  ]);
});

it('rejects replaced CRDs and invalid custom resource queries without listing instances', async () => {
  run.mockResolvedValue(JSON.stringify({ metadata: { uid: 'new-uid' } }));
  const response = await fetch(`${base}custom-resources?context=test&name=widgets.example.com&uid=old-uid`);
  expect(response.status).toBe(409);
  expect(run).toHaveBeenCalledTimes(1);
  run.mockClear();
  expect((await fetch(`${base}custom-resources?context=test&name=--raw&uid=old-uid`)).status).toBe(400);
  expect(run).not.toHaveBeenCalled();
});

it('discovers API resources in the selected context with literal arguments', async () => {
  run.mockResolvedValue('horizontalpodautoscalers hpa autoscaling/v1 true HorizontalPodAutoscaler get,list,watch');
  const response = await fetch(`${base}api-resources?context=production`);
  expect(response.status).toBe(200);
  expect(await response.json()).toContain('autoscaling/v1');
  expect(run).toHaveBeenCalledWith(['--context', 'production', 'api-resources', '--verbs=list', '-o', 'wide', '--no-headers']);
  run.mockClear();
  expect((await fetch(`${base}api-resources`)).status).toBe(400);
  expect(run).not.toHaveBeenCalled();
});

it('fetches lightweight resource counts with limit=1 and remainingItemCount', async () => {
  run.mockImplementation(async (args) => {
    const rawPath = args.at(-1) ?? '';
    if (rawPath === '/api/v1/namespaces/backend/pods?limit=1') {
      return JSON.stringify({ metadata: { remainingItemCount: 8999 }, items: [{ metadata: { name: 'pod-0' } }] });
    }
    if (rawPath === '/api/v1/nodes?limit=1') {
      return JSON.stringify({ metadata: { remainingItemCount: 179 }, items: [{ metadata: { name: 'node-0' } }] });
    }
    throw { stderr: 'Error from server (Forbidden): secrets is forbidden' };
  });
  const response = await fetch(`${base}resource-counts?context=production&namespace=backend&kinds=Pod,Node,Secret`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ Pod: 9000, Node: 180 });
});
