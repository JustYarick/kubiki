import type { ResourceItem } from '../../types/k8s';

export const SECRET_SOURCE_KINDS: Record<string, readonly string[]> = {
  'external-secrets.io': ['ExternalSecret'],
  'secrets.hashicorp.com': ['VaultStaticSecret', 'VaultDynamicSecret', 'VaultPKISecret'],
};

export interface SecretLocation {
  path: string;
  key?: string;
  property?: string;
  url?: string;
  folder?: boolean;
}
export interface SecretSource {
  resource?: ResourceItem;
  provider: string;
  server?: string;
  store?: string;
  locations: SecretLocation[];
  note?: string;
}
export interface SecretOrigin {
  type: 'internal' | 'external' | 'unknown';
  sources: SecretSource[];
  incomplete?: boolean;
}

const spec = (item?: ResourceItem) => item?.raw?.spec ?? item?.spec ?? {};
const metadata = (item: ResourceItem) => item.raw?.metadata ?? item.metadata ?? {};
const trimPath = (value: string) => value.replace(/^\/+|\/+$/g, '');
export const apiGroup = (item: ResourceItem) => item.apiVersion.split('/')[0];

export function isSecretSource(item: ResourceItem): boolean {
  return SECRET_SOURCE_KINDS[apiGroup(item)]?.includes(item.kind) ?? false;
}

export function matchesSecret(secret: ResourceItem, source: ResourceItem): boolean {
  if (!isSecretSource(source) || secret.namespace !== source.namespace) return false;
  const owners = metadata(secret).ownerReferences ?? [];
  const owner = owners.find((ref: any) => ref.apiVersion?.split('/')[0] === apiGroup(source) && ref.kind === source.kind && ref.name === source.name);
  if (owner) return !owner.uid || owner.uid === source.uid;
  const target = apiGroup(source) === 'external-secrets.io' ? spec(source).target?.name ?? source.name : spec(source).destination?.name;
  return target === secret.name;
}

function find(resources: ResourceItem[], group: string, kind: string, name: string, namespace?: string) {
  return resources.find(item => apiGroup(item) === group && item.kind === kind && item.name === name && item.namespace === namespace);
}

/** Only HTTP(S) addresses from the integration configuration can become external links. */
export function vaultSecretUrl(server: unknown, mount: string, path: string, version: 'v1' | 'v2', namespace?: string, folder = false): string | undefined {
  if (typeof server !== 'string' || !mount || (!path && !folder)) return;
  try {
    const url = new URL(server);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    // Preserve reverse-proxy prefixes. A mount can itself contain slashes.
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const route = version === 'v2'
      ? folder ? `kv/list${path ? `/${encodedPath}/` : ''}` : `kv/${encodeURIComponent(path)}/details`
      : `${folder ? 'list' : 'show'}/${encodedPath}`;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/ui/vault/secrets/${encodeURIComponent(trimPath(mount))}/${route}`;
    url.search = '';
    url.hash = '';
    if (namespace) url.searchParams.set('namespace', namespace);
    return url.toString();
  } catch { return; }
}

function vaultLocation(config: any, key: string, extra: Partial<SecretLocation> = {}): SecretLocation {
  const mount = typeof config.path === 'string' ? trimPath(config.path) : '';
  const version = config.version === 'v1' ? 'v1' : 'v2';
  let path = trimPath(key);
  // ESO accepts both a path relative to the mount and a full Vault API path.
  if (mount && path.startsWith(`${mount}/`)) {
    path = path.slice(mount.length + 1);
    if (version === 'v2' && path.startsWith('data/')) path = path.slice(5);
  }
  return {
    ...extra,
    path: mount ? `${mount}/${path}`.replace(/\/$/, '') : key,
    url: vaultSecretUrl(config.server, mount, path, version, config.namespace, extra.folder),
  };
}

function externalSecret(source: ResourceItem, resources: ResourceItem[]): SecretSource[] {
  const config = spec(source);
  const entries = [
    ...(config.data ?? []).map((entry: any) => ({ ref: entry.sourceRef?.generatorRef ? undefined : entry.sourceRef?.storeRef ?? config.secretStoreRef, path: entry.remoteRef?.key, key: entry.secretKey, property: entry.remoteRef?.property })),
    ...(config.dataFrom ?? []).map((entry: any) => ({ ref: entry.sourceRef?.generatorRef ? undefined : entry.sourceRef?.storeRef ?? config.secretStoreRef, path: entry.extract?.key ?? (entry.find ? entry.find.path ?? '' : undefined), folder: !!entry.find })),
  ];
  if (!entries.length) entries.push({ ref: config.secretStoreRef });
  const groups = new Map<string, SecretSource>();
  for (const entry of entries) {
    const kind = entry.ref?.kind ?? 'SecretStore';
    const name = entry.ref?.name;
    const store = name && find(resources, 'external-secrets.io', kind, name, kind === 'ClusterSecretStore' ? undefined : source.namespace);
    const provider = spec(store).provider;
    const vault = provider?.vault;
    const groupKey = `${kind}/${name ?? ''}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { resource: source, provider: vault ? 'Vault' : provider ? Object.keys(provider).join(', ') : 'External provider', server: typeof vault?.server === 'string' ? vault.server : undefined, store: name ? `${kind}/${name}` : undefined, locations: [] };
      if (!store) group.note = 'SecretStore is unavailable; the provider, full path and Vault address could not be verified.';
      groups.set(groupKey, group);
    }
    if (typeof entry.path === 'string') {
      const extra = { key: entry.key, property: entry.property, folder: entry.folder };
      group.locations.push(vault ? vaultLocation(vault, entry.path, extra) : { path: entry.path, ...extra });
    }
  }
  return [...groups.values()];
}

/** Namespaced VSO references use namespace/name; omitted refs have operator-specific defaults. */
export function qualifiedRef(ref: unknown, namespace?: string): { name: string; namespace?: string } | undefined {
  if (typeof ref !== 'string' || !ref) return;
  const parts = ref.split('/');
  return parts.length === 1 ? { name: ref, namespace } : parts.length === 2 && parts.every(Boolean) ? { name: parts[1], namespace: parts[0] } : undefined;
}

function vaultOperator(source: ResourceItem, resources: ResourceItem[]): SecretSource {
  const config = spec(source);
  const authRef = qualifiedRef(config.vaultAuthRef, source.namespace);
  const auth = authRef && find(resources, 'secrets.hashicorp.com', 'VaultAuth', authRef.name, authRef.namespace);
  const connectionRef = qualifiedRef(spec(auth).vaultConnectionRef, auth?.namespace);
  const connection = connectionRef && find(resources, 'secrets.hashicorp.com', 'VaultConnection', connectionRef.name, connectionRef.namespace);
  const mount = typeof config.mount === 'string' ? trimPath(config.mount) : '';
  const path = source.kind === 'VaultPKISecret' ? `issue/${config.role ?? ''}` : typeof config.path === 'string' ? trimPath(config.path) : '';
  const namespace = config.namespace ?? spec(auth).namespace;
  const url = source.kind === 'VaultStaticSecret'
    ? vaultSecretUrl(spec(connection).address, mount, path, config.type === 'kv-v1' ? 'v1' : 'v2', namespace)
    : undefined;
  return {
    resource: source, provider: 'Vault', server: typeof spec(connection).address === 'string' ? spec(connection).address : undefined, locations: mount && path ? [{ path: `${mount}/${path}`, url }] : [],
    note: !connection ? 'Vault address is unavailable. Explicit VaultAuth and VaultConnection references are needed to build a link.' : undefined,
  };
}

export function resolveSecretOrigin(secret: ResourceItem, resources: ResourceItem[], complete = true): SecretOrigin {
  const sources = resources.filter(source => matchesSecret(secret, source)).flatMap(source => apiGroup(source) === 'external-secrets.io' ? externalSecret(source, resources) : [vaultOperator(source, resources)]);
  if (sources.length) return { type: 'external', sources, incomplete: !complete || sources.some(source => !!source.note) };
  const owners = (metadata(secret).ownerReferences ?? []).filter((ref: any) => SECRET_SOURCE_KINDS[ref.apiVersion?.split('/')[0]]?.includes(ref.kind));
  if (owners.length) return {
    type: 'external', incomplete: true,
    sources: owners.map((ref: any) => ({ provider: ref.apiVersion.startsWith('secrets.hashicorp.com/') ? 'Vault' : 'External provider', store: `${ref.kind}/${ref.name}`, locations: [], note: 'The source resource is unavailable; its path and address could not be read.' })),
  };
  const managedBy = metadata(secret).labels?.['app.kubernetes.io/managed-by'];
  if (['external-secrets', 'external-secrets-operator', 'vault-secrets-operator'].includes(managedBy) || metadata(secret).labels?.['reconcile.external-secrets.io/managed'] === 'true') {
    return { type: 'external', incomplete: true, sources: [{ provider: managedBy === 'vault-secrets-operator' ? 'Vault' : 'External provider', locations: [], note: 'The operator is known, but the source resource is unavailable.' }] };
  }
  return { type: complete ? 'internal' : 'unknown', sources: [], incomplete: !complete };
}
