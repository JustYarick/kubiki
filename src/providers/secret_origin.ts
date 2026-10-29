import type { ResourceItem } from '../types/k8s';
import { apiGroup, isSecretSource, matchesSecret, qualifiedRef, resolveSecretOrigin, type SecretOrigin } from '../core/resources/secret_origin';
import { k8s } from './k8s_provider';

type OriginReader = Pick<typeof k8s, 'getResources' | 'getCustomResources'>;

/** Read Kubernetes integration metadata only; never contact Vault or read authentication Secrets. */
export async function loadSecretOrigin(context: string, secret: ResourceItem, signal: AbortSignal, reader: OriginReader = k8s): Promise<SecretOrigin> {
  let definitions: ResourceItem[];
  try { definitions = await reader.getResources(context, 'CustomResourceDefinition', undefined, signal); }
  catch { return resolveSecretOrigin(secret, [], false); }
  let complete = true;
  const inventory: ResourceItem[] = [];
  const pending = new Map<string, Promise<ResourceItem[]>>();
  const read = (group: string, kind: string, namespace?: string) => {
    const key = `${group}/${kind}/${namespace ?? ''}`;
    let request = pending.get(key);
    if (!request) {
      const definition = definitions.find(item => item.raw?.spec?.group === group && item.raw?.spec?.names?.kind === kind);
      request = definition ? reader.getCustomResources(context, definition.name, definition.uid, namespace ?? null, signal).catch(() => { complete = false; return []; }) : Promise.resolve([]);
      pending.set(key, request);
    }
    return request;
  };
  const sourceDefinitions = definitions.filter(item => isSecretSource({ ...item, kind: item.raw?.spec?.names?.kind, apiVersion: `${item.raw?.spec?.group}/v1` }));
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
  return resolveSecretOrigin(secret, inventory, complete);
}
