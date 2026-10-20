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
  it('rejects cross-origin and invalid scale requests, but allows zero replicas', async () => {
    const target = { context: 'test', kind: 'Deployment', namespace: 'backend', name: 'web', replicas: 0 };
    const crossOrigin = await fetch(`${base}scale?context=test`, { method: 'POST', headers: { origin: 'http://untrusted.invalid' }, body: JSON.stringify(target) });
    expect(crossOrigin.status).toBe(403);
    const invalid = await fetch(`${base}scale?context=test`, { method: 'POST', body: JSON.stringify({ ...target, replicas: -1 }) });
    expect(invalid.status).toBe(400); expect(run).not.toHaveBeenCalled();
    const valid = await fetch(`${base}scale?context=test`, { method: 'POST', body: JSON.stringify(target) });
    expect(valid.status).toBe(200);
    expect(run).toHaveBeenCalledWith(['--context', 'test', 'scale', 'deployments.apps', 'web', '-n', 'backend', '--replicas=0']);
  });
});
