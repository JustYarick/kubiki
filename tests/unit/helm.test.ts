import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHelmMiddleware } from '../../server/helm_bridge';
import { K8sProvider } from '../../src/providers/k8s_provider';
import { helmUpdatedAt, parseHelmReleases, validateHelmDocument, validateHelmTarget } from '../../src/providers/helm_types';
import { useWorkspaceStore } from '../../src/state/workspace_store';

const release = { name: 'web', namespace: 'backend', revision: '2', updated: '2026-10-20 12:00:00.123456 +0000 UTC', status: 'deployed', chart: 'web-1', app_version: '1' };
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
afterEach(() => vi.unstubAllGlobals());

describe('Helm transport contract', () => {
  it('requires explicit targets, positive revisions and valid inventory summaries', () => {
    for (const name of ['--help', '../name', '', 'x..y', 'x.-y']) expect(() => validateHelmTarget('prod', 'backend', name)).toThrow();
    expect(() => validateHelmTarget('', 'backend', 'web')).toThrow();
    expect(() => validateHelmTarget('prod', '-all', 'web')).toThrow();
    for (const document of ['upgrade', 'delete', 'repo']) expect(() => validateHelmDocument(document, 1)).toThrow();
    expect(() => validateHelmDocument('values', 0)).toThrow();
    expect(() => parseHelmReleases([{ ...release, revision: 'invalid' }])).toThrow();
    expect(parseHelmReleases([release])).toEqual([release]);
  });
  it('uses native read commands with the selected context and revision', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, location: { search: '' } });
    invoke.mockReset().mockResolvedValueOnce([release]).mockResolvedValueOnce('key: value').mockResolvedValueOnce([]);
    const provider = new K8sProvider();
    await provider.getHelmInventory('prod', 'backend');
    expect(invoke).toHaveBeenNthCalledWith(1, 'get_helm_inventory', expect.objectContaining({ context: 'prod', namespace: 'backend' }));
    expect(await provider.getHelmContent('prod', 'backend', 'web', 2, 'values')).toBe('key: value');
    expect(invoke).toHaveBeenNthCalledWith(2, 'get_helm_content', expect.objectContaining({ context: 'prod', namespace: 'backend', name: 'web', revision: 2, document: 'values' }));
    await provider.getHelmRepositories();
    expect(invoke).toHaveBeenNthCalledWith(3, 'list_helm_repositories', expect.any(Object));
    invoke.mockResolvedValueOnce([{ ...release, namespace: 'other' }]);
    await expect(provider.getHelmInventory('prod', 'backend')).rejects.toMatchObject({ code: 'internal' });
  });
  it('keeps Helm tabs distinct, reuses each tab and parses Go timestamps chronologically', () => {
    const previous = useWorkspaceStore.getState();
    useWorkspaceStore.setState({ tabs: [], activeTabId: '', splitTabId: null });
    try {
      previous.openHelm('releases'); previous.openHelm('repositories'); previous.openHelm('releases');
      expect(useWorkspaceStore.getState().tabs.map(tab => tab.type)).toEqual(['helm-releases', 'helm-repositories']);
      expect(useWorkspaceStore.getState().activeTabId).toBe('tab-helm-releases');
    } finally { useWorkspaceStore.setState(previous); }
    expect(helmUpdatedAt(release.updated)).toBe(Date.parse('2026-10-20T12:00:00.123Z'));
    expect(helmUpdatedAt('2026-10-20 15:00:00.123 +0300 MSK')).toBe(helmUpdatedAt(release.updated));
  });
});

describe('Helm HTTP bridge', () => {
  const run = vi.fn<(args: string[], signal?: AbortSignal) => Promise<string>>();
  let server: Server; let base: string;
  beforeEach(async () => {
    run.mockReset().mockResolvedValue('[]');
    const handler = createHelmMiddleware(run);
    server = createServer((req, res) => { void handler(req, res, () => { res.statusCode = 404; res.end(); }); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/k8s/helm/`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  it('returns the complete snapshot with one Helm call and a literal context flag', async () => {
    run.mockResolvedValue(JSON.stringify(Array.from({ length: 401 }, (_, i) => ({ ...release, name: `web-${i}` }))));
    const response = await fetch(`${base}inventory?${new URLSearchParams({ context: 'prod $(literal)', namespace: 'backend' })}`);
    expect(response.status).toBe(200);
    const data = await response.json(); expect(data).toHaveLength(401);expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toEqual(['--kube-context=prod $(literal)', 'list', '--output=json', '--max=0', '--namespace=backend', '--deployed', '--failed', '--pending', '--uninstalled', '--superseded', '--uninstalling']);
  });
  it('keeps history/content pinned and repository reads local', async () => {
    run.mockResolvedValue('key: value');
    const response = await fetch(`${base}content?context=prod&namespace=backend&name=web&revision=2&document=values`);
    expect(await response.json()).toBe('key: value');
    expect(run.mock.calls.at(-1)?.[0]).toEqual(['--kube-context=prod', '--namespace=backend', 'get', 'values', 'web', '--revision=2', '--output=yaml']);
    run.mockResolvedValue('[]');
    await fetch(`${base}history?context=prod&namespace=backend&name=web`);
    expect(run.mock.calls.at(-1)?.[0]).toEqual(['--kube-context=prod', '--namespace=backend', 'history', 'web', '--output=json', '--max=256']);
    await fetch(`${base}repositories`);
    expect(run.mock.calls.at(-1)?.[0]).toEqual(['repo', 'list', '--output=json']);
  });
  it.each(['inventory?namespace=backend', 'content?context=prod&namespace=backend&name=--help&revision=1&document=values', 'content?context=prod&namespace=backend&name=web&revision=0&document=values', 'content?context=prod&namespace=backend&name=web&revision=1&document=uninstall'])('rejects %s before running Helm', async query => {
    expect((await fetch(base + query)).status).toBe(400); expect(run).not.toHaveBeenCalled();
  });
  it.each(['inventory', 'content', 'history', 'repositories'])('rejects POST to %s', async operation => {
    expect((await fetch(base + operation, { method: 'POST' })).status).toBe(405); expect(run).not.toHaveBeenCalled();
  });
  it.each(['GET', 'POST', 'PUT', 'DELETE'])('blocks %s mutations before executing any Helm command', async method => {
    const response = await fetch(base + 'mutate', { method });
    expect(response.status).toBe(403); expect(run).not.toHaveBeenCalled();
    expect((await response.json()).error.message).toContain('system confirmation');
  });
  it('does not hide repository permission failures or corrupt output behind an empty state', async () => {
    run.mockRejectedValueOnce({ stderr: 'Error: no repositories to show\n' });
    expect(await (await fetch(base + 'repositories')).json()).toEqual([]);
    run.mockRejectedValueOnce({ stderr: 'Error: permission denied reading repositories.yaml' });
    expect((await fetch(base + 'repositories')).status).toBe(503);
    run.mockResolvedValueOnce('{broken json}');
    expect((await fetch(base + 'repositories')).status).toBe(500);
  });
  it.each([[{ code: 'ENOENT' }, 503, 'bridge_unavailable'], [{ killed: true }, 504, 'timeout'], [{ stderr: 'Error: secrets is forbidden' }, 403, 'forbidden']])('surfaces process/cluster errors %j', async (error, status, code) => {
    run.mockRejectedValue(error);
    const response = await fetch(base + 'inventory?context=prod');
    expect(response.status).toBe(status); expect((await response.json()).error.code).toBe(code);
  });
});
