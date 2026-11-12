import type { ResourceItem } from '../types/k8s';
import { apiGroup, isSecretSource, matchesSecret, qualifiedRef, resolveSecretOrigin, type SecretOrigin } from '../core/resources/secret_origin';
import { k8s } from './k8s_provider';
import { useResourceStore } from '../state/resource_store';

type OriginReader = Pick<typeof k8s, 'getResources' | 'getCustomResources'>;

const originCache = new Map<string, { origin: SecretOrigin; timestamp: number }>();
const sourcesCache = new Map<string, { items: ResourceItem[]; timestamp: number }>();
const CACHE_TTL_MS = 60_000;

export function clearSecretOriginCache(): void {
  originCache.clear();
  sourcesCache.clear();
}

/** Read Kubernetes integration metadata only; never contact Vault or read authentication Secrets. */
export async function loadSecretOrigin(context: string, secret: ResourceItem, signal: AbortSignal, reader: OriginReader = k8s): Promise<SecretOrigin> {
  const rv = secret.raw?.metadata?.resourceVersion ?? '';
  const cacheKey = `${context}:${secret.namespace ?? ''}:${secret.name}:${rv}`;
  if (reader === k8s) {
    const cached = originCache.get(cacheKey);
    if (cached && performance.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.origin;
    }
  }

  let definitions: ResourceItem[];
  if (reader === k8s) {
    const inStore = useResourceStore.getState().resources.CustomResourceDefinition;
    if (inStore && inStore.size > 0) {
      definitions = [...inStore.values()];
    } else {
      try { definitions = await reader.getResources(context, 'CustomResourceDefinition', undefined, signal); }
      catch { return resolveSecretOrigin(secret, [], false); }
    }
  } else {
    try { definitions = await reader.getResources(context, 'CustomResourceDefinition', undefined, signal); }
    catch { return resolveSecretOrigin(secret, [], false); }
  }

  const sourceDefinitions = definitions.filter(item => isSecretSource({ ...item, kind: item.raw?.spec?.names?.kind, apiVersion: `${item.raw?.spec?.group}/v1` }));
  if (sourceDefinitions.length === 0) {
    const result = resolveSecretOrigin(secret, [], true);
    if (reader === k8s) originCache.set(cacheKey, { origin: result, timestamp: performance.now() });
    return result;
  }

  let complete = true;
  const inventory: ResourceItem[] = [];
  const pending = new Map<string, Promise<ResourceItem[]>>();
  const read = (group: string, kind: string, namespace?: string) => {
    const key = `${context}:${group}/${kind}/${namespace ?? ''}`;
    if (reader === k8s) {
      const cachedSources = sourcesCache.get(key);
      if (cachedSources && performance.now() - cachedSources.timestamp < CACHE_TTL_MS) {
        return Promise.resolve(cachedSources.items);
      }
    }
    let request = pending.get(key);
    if (!request) {
      const definition = definitions.find(item => item.raw?.spec?.group === group && item.raw?.spec?.names?.kind === kind);
      request = definition
        ? reader.getCustomResources(context, definition.name, definition.uid, namespace ?? null, signal)
            .then(items => {
              if (reader === k8s) sourcesCache.set(key, { items, timestamp: performance.now() });
              return items;
            })
            .catch(() => { complete = false; return []; })
        : Promise.resolve([]);
      pending.set(key, request);
    }
    return request;
  };
  const sources = (await Promise.all(sourceDefinitions.map(item => read(item.raw!.spec.group, item.raw!.spec.names.kind, secret.namespace)))).flat();
  inventory.push(...sources);
  const matching = sources.filter(source => matchesSecret(secret, source));
  await Promise.all(matching.map(async source => {
    const config = source.raw?.spec ?? source.spec ?? {};
    if (apiGroup(source) === 'external-secrets.io') {
      const refs = [config.secretStoreRef, ...(config.data ?? []).map((entry: any) => entry.sourceRef?.storeRef), ...(config.dataFrom ?? []).map((entry: any) => entry.sourceRef?.storeRef)].filter(Boolean);
      const stores = await Promise.all(refs.map(ref => read('external-secrets.io', ref.kind ?? 'SecretStore', ref.kind === 'ClusterSecretStore' ? undefined : source.namespace)));
      inventory.push(...stores.flat());
    } else {
      const authRef = qualifiedRef(config.vaultAuthRef, source.namespace);
      if (!authRef) return;
      const auths = await read('secrets.hashicorp.com', 'VaultAuth', authRef.namespace);
      inventory.push(...auths);
      const auth = auths.find(item => item.name === authRef.name);
      const connectionRef = qualifiedRef(auth?.raw?.spec?.vaultConnectionRef ?? auth?.spec?.vaultConnectionRef, auth?.namespace);
      if (connectionRef) inventory.push(...await read('secrets.hashicorp.com', 'VaultConnection', connectionRef.namespace));
    }
  }));
  const result = resolveSecretOrigin(secret, inventory, complete);
  if (reader === k8s) originCache.set(cacheKey, { origin: result, timestamp: performance.now() });
  return result;
}
