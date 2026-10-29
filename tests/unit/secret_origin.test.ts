import { describe, expect, it, vi } from 'vitest';
import type { ResourceItem } from '../../src/types/k8s';
import { matchesSecret, resolveSecretOrigin, vaultSecretUrl } from '../../src/core/resources/secret_origin';
import { loadSecretOrigin } from '../../src/providers/secret_origin';

function resource(kind: string, name: string, spec: object = {}, namespace: string | undefined = 'apps', group = 'external-secrets.io'): ResourceItem {
  return { kind, name, namespace, uid: `${kind}-${name}`, apiVersion: `${group}/v1`, raw: { spec, metadata: { name, namespace } } };
}
const secret = resource('Secret', 'credentials', {}, 'apps', '');
const external = (spec: object = {}, namespace = 'apps') => resource('ExternalSecret', 'sync', { target: { name: 'credentials' }, secretStoreRef: { name: 'vault' }, data: [{ secretKey: 'password', remoteRef: { key: 'prod/db', property: 'password' } }], ...spec }, namespace);
const store = (vault: object = {}, namespace: string | undefined = 'apps', kind = 'SecretStore') => ({ ...resource(kind, 'vault', { provider: { vault: { server: 'https://vault.example', path: 'secret', version: 'v2', ...vault } } }, namespace), namespace: kind === 'ClusterSecretStore' ? undefined : namespace });
const definition = (kind: string, group = 'external-secrets.io') => resource('CustomResourceDefinition', `${kind.toLowerCase()}s.${group}`, { group, names: { kind }, scope: 'Namespaced' }, undefined, 'apiextensions.k8s.io');

describe('Secret sources', () => {
  it('only calls a Secret internal after successful source discovery', () => {
    expect(resolveSecretOrigin(secret, [])).toMatchObject({ type: 'internal' });
    expect(resolveSecretOrigin(secret, [], false)).toMatchObject({ type: 'unknown', incomplete: true });
    expect(resolveSecretOrigin(secret, [external({}, 'other'), store()])).toMatchObject({ type: 'internal' });
  });

  it('resolves default targets, explicit targets and UID-checked owners in the correct API group', () => {
    expect(matchesSecret(secret, external())).toBe(true);
    expect(matchesSecret(secret, resource('ExternalSecret', secret.name))).toBe(true);
    expect(matchesSecret(secret, resource('ExternalSecret', secret.name, {}, 'apps', 'unrelated.example'))).toBe(false);
    const owned = { ...secret, raw: { metadata: { ownerReferences: [{ apiVersion: 'external-secrets.io/v1', kind: 'ExternalSecret', name: 'sync', uid: 'old' }] } } };
    expect(matchesSecret(owned, external())).toBe(false);
    expect(resolveSecretOrigin(owned, [], false)).toMatchObject({ type: 'external', incomplete: true });
  });

  it('resolves multiple keys, extract and find paths and per-entry ClusterSecretStore overrides', () => {
    const origin = resolveSecretOrigin(secret, [external({ dataFrom: [{ extract: { key: 'secret/data/shared' } }, { find: { path: 'team' } }, { extract: { key: 'old' }, sourceRef: { storeRef: { name: 'vault', kind: 'ClusterSecretStore' } } }] }), store(), store({ path: 'legacy', version: 'v1' }, undefined, 'ClusterSecretStore')]);
    expect(origin.type).toBe('external');
    expect(origin.sources.map(source => source.provider)).toEqual(['Vault', 'Vault']);
    expect(origin.sources[0].locations).toEqual([
      { path: 'secret/prod/db', key: 'password', property: 'password', folder: undefined, url: 'https://vault.example/ui/vault/secrets/secret/kv/prod%2Fdb/details' },
      { path: 'secret/shared', folder: false, url: 'https://vault.example/ui/vault/secrets/secret/kv/shared/details' },
      { path: 'secret/team', folder: true, url: 'https://vault.example/ui/vault/secrets/secret/kv/list/team/' },
    ]);
    expect(origin.sources[1].locations[0].url).toBe('https://vault.example/ui/vault/secrets/legacy/show/old');
  });

  it('preserves a relative data/ directory and does not invent a mount or host', () => {
    const origin = resolveSecretOrigin(secret, [external({ data: [{ remoteRef: { key: 'data/actual-folder' } }] }), store()]);
    expect(origin.sources[0].locations[0].path).toBe('secret/data/actual-folder');
    expect(resolveSecretOrigin(secret, [external()]).sources[0]).toMatchObject({ provider: 'External provider', locations: [{ path: 'prod/db' }] });
    expect(resolveSecretOrigin(secret, [external()]).sources[0].locations[0].url).toBeUndefined();
    expect(resolveSecretOrigin(secret, [external(), store({ path: undefined })]).sources[0].locations[0].url).toBeUndefined();
  });

  it('distinguishes other providers and generator refs from Vault', () => {
    const aws = resource('SecretStore', 'vault', { provider: { aws: { service: 'SecretsManager' } } });
    expect(resolveSecretOrigin(secret, [external(), aws]).sources[0]).toMatchObject({ provider: 'aws', locations: [{ path: 'prod/db' }] });
    const generator = external({ data: [], dataFrom: [{ sourceRef: { generatorRef: { kind: 'Password', name: 'generated' } } }] });
    expect(resolveSecretOrigin(secret, [generator, store()]).sources[0].provider).toBe('External provider');
  });

  it('follows explicit cross-namespace VSO auth and connection refs and Vault namespaces', () => {
    const source = resource('VaultStaticSecret', 'sync', { destination: { name: secret.name }, mount: 'kv', path: 'apps/db', type: 'kv-v2', vaultAuthRef: 'infra/auth' }, 'apps', 'secrets.hashicorp.com');
    const auth = resource('VaultAuth', 'auth', { vaultConnectionRef: 'connections/vault', namespace: 'tenant/team' }, 'infra', 'secrets.hashicorp.com');
    const connection = resource('VaultConnection', 'vault', { address: 'https://vault.example/proxy/' }, 'connections', 'secrets.hashicorp.com');
    const origin = resolveSecretOrigin(secret, [source, auth, connection]);
    expect(origin.sources[0]).toMatchObject({ provider: 'Vault', locations: [{ path: 'kv/apps/db', url: 'https://vault.example/proxy/ui/vault/secrets/kv/kv/apps%2Fdb/details?namespace=tenant%2Fteam' }] });
    expect(resolveSecretOrigin(secret, [source]).sources[0]).toMatchObject({ provider: 'Vault', locations: [{ path: 'kv/apps/db', url: undefined }] });
  });

  it('keeps dynamic Vault paths visible without inventing a KV detail page', () => {
    const dynamic = resource('VaultDynamicSecret', 'sync', { destination: { name: secret.name }, mount: 'database', path: 'creds/reader' }, 'apps', 'secrets.hashicorp.com');
    expect(resolveSecretOrigin(secret, [dynamic]).sources[0].locations).toEqual([{ path: 'database/creds/reader', url: undefined }]);
  });

  it('encodes reserved characters, nested mounts, folders and namespaces and rejects invalid addresses', () => {
    expect(vaultSecretUrl('https://vault.example/prefix/?token=ignored#ignored', 'org/kv', 'a #?/b', 'v2', 'tenant')).toBe('https://vault.example/prefix/ui/vault/secrets/org%2Fkv/kv/a%20%23%3F%2Fb/details?namespace=tenant');
    expect(vaultSecretUrl('http://vault:8200', 'kv', '', 'v2', undefined, true)).toBe('http://vault:8200/ui/vault/secrets/kv/kv/list');
    for (const address of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@vault.example', 'vault.example']) expect(vaultSecretUrl(address, 'secret', 'db', 'v2')).toBeUndefined();
  });
});

describe('Secret source metadata loading', () => {
  it('loads source resources in the Secret namespace and deduplicates store reads', async () => {
    const reader = {
      getResources: vi.fn().mockResolvedValue([definition('ExternalSecret'), definition('SecretStore')]),
      getCustomResources: vi.fn(async (_context: string, name: string) => name.startsWith('externalsecrets.') ? [external({ dataFrom: [{ extract: { key: 'shared' } }] })] : [store()]),
    };
    const signal = new AbortController().signal;
    expect(await loadSecretOrigin('prod', secret, signal, reader)).toMatchObject({ type: 'external', sources: [{ provider: 'Vault' }] });
    expect(reader.getCustomResources).toHaveBeenCalledTimes(2);
    for (const call of reader.getCustomResources.mock.calls as unknown[][]) expect(call.slice(3)).toEqual(['apps', signal]);
  });

  it('reports a failed discovery or source read as unknown instead of internal', async () => {
    const reader = { getResources: vi.fn().mockRejectedValue(new Error('forbidden')), getCustomResources: vi.fn() };
    expect(await loadSecretOrigin('prod', secret, new AbortController().signal, reader)).toMatchObject({ type: 'unknown' });
    reader.getResources.mockResolvedValue([definition('ExternalSecret')]);
    reader.getCustomResources.mockRejectedValue(new Error('forbidden'));
    expect(await loadSecretOrigin('prod', secret, new AbortController().signal, reader)).toMatchObject({ type: 'unknown' });
  });

  it('loads cross-namespace VSO dependencies and cluster stores with their actual scope', async () => {
    const group = 'secrets.hashicorp.com';
    const source = resource('VaultStaticSecret', 'sync', { destination: { name: secret.name }, mount: 'secret', path: 'db', vaultAuthRef: 'infra/auth' }, 'apps', group);
    const auth = resource('VaultAuth', 'auth', { vaultConnectionRef: 'connections/vault' }, 'infra', group);
    const connection = resource('VaultConnection', 'vault', { address: 'https://vault.example' }, 'connections', group);
    const inventory = [source, auth, connection];
    const definitions = inventory.map(item => definition(item.kind, group));
    const reader = {
      getResources: vi.fn().mockResolvedValue(definitions),
      getCustomResources: vi.fn(async (_context: string, name: string) => inventory.filter(item => name === `${item.kind.toLowerCase()}s.${group}`)),
    };
    const signal = new AbortController().signal;
    expect(await loadSecretOrigin('prod', secret, signal, reader)).toMatchObject({ type: 'external', sources: [{ provider: 'Vault', locations: [{ url: 'https://vault.example/ui/vault/secrets/secret/kv/db/details' }] }] });
    expect(reader.getCustomResources.mock.calls.map((call: unknown[]) => call[3])).toEqual(['apps', 'infra', 'connections']);

    reader.getResources.mockResolvedValue([definition('ExternalSecret'), definition('ClusterSecretStore')]);
    reader.getCustomResources.mockImplementation(async (_context: string, name: string) => name.startsWith('externalsecrets.') ? [external({ secretStoreRef: { name: 'vault', kind: 'ClusterSecretStore' } })] : [store({}, undefined, 'ClusterSecretStore')]);
    reader.getCustomResources.mockClear();
    expect(await loadSecretOrigin('prod', secret, signal, reader)).toMatchObject({ type: 'external', sources: [{ provider: 'Vault' }] });
    expect(reader.getCustomResources.mock.calls.map((call: unknown[]) => call[3])).toEqual(['apps', null]);
  });
});
