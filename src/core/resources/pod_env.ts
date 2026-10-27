import type { ResourceItem } from '../../types/k8s';
import { decodeBase64 } from './secret_data';

export interface PodEnvEntry {
  name: string;
  value?: string;
  sourceType: 'direct' | 'configMap' | 'secret' | 'field' | 'resourceField' | 'unknown';
  sourceName?: string;
  sourceKey?: string;
  isSecret?: boolean;
  rawSource?: any;
  /** If the referenced ConfigMap/Secret has changed since the pod started */
  drift?: {
    clusterValue?: string;
    reason: string;
  };
}

export interface ContainerEnvResult {
  containerName: string;
  entries: PodEnvEntry[];
  hasDrift: boolean;
  driftCount: number;
}

function resolveSecretValue(data: Record<string, string> | undefined, key: string): string | undefined {
  if (!data || !(key in data)) return undefined;
  const raw = data[key];
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decodeBase64(raw));
  } catch {
    return raw;
  }
}

/**
 * Resolves all environment variables for a container in a Pod,
 * matching direct values, configMaps, secrets, fieldRefs, and envFrom.
 * Also detects drift between currently running pod values and cluster ConfigMaps/Secrets.
 */
export function resolveContainerEnv(
  pod: ResourceItem,
  containerName: string,
  allResources: {
    ConfigMap?: Map<string, ResourceItem>;
    Secret?: Map<string, ResourceItem>;
  } = {}
): ContainerEnvResult {
  const raw = pod.raw ?? {};
  const spec = raw.spec ?? pod.spec ?? {};
  const status = raw.status ?? pod.statusRaw ?? {};
  const namespace = pod.namespace;

  // Find container definition
  const allDefs = [
    ...(spec.containers ?? []),
    ...(spec.initContainers ?? []),
    ...(spec.ephemeralContainers ?? []),
  ];
  const container = allDefs.find((c: any) => c.name === containerName) ?? allDefs[0];

  if (!container) {
    return { containerName, entries: [], hasDrift: false, driftCount: 0 };
  }

  // Find container startedAt to detect drift
  const allStatuses = [
    ...(status.containerStatuses ?? []),
    ...(status.initContainerStatuses ?? []),
    ...(status.ephemeralContainerStatuses ?? []),
  ];
  const cs = allStatuses.find((s: any) => s.name === container.name);
  const startedAtStr = cs?.state?.running?.startedAt;
  const startedAt = startedAtStr ? new Date(startedAtStr).getTime() : undefined;

  const configMaps = allResources.ConfigMap;
  const secrets = allResources.Secret;

  const entries: PodEnvEntry[] = [];
  let driftCount = 0;

  // 1. Process envFrom (ConfigMap / Secret bulk injection)
  const envFromList: any[] = container.envFrom ?? [];
  for (const ef of envFromList) {
    const prefix = ef.prefix ?? '';

    if (ef.configMapRef) {
      const cmName = ef.configMapRef.name;
      const cm = configMaps ? [...configMaps.values()].find((c) => c.name === cmName && (!namespace || c.namespace === namespace)) : undefined;
      const cmRaw = cm?.raw ?? {};
      const cmData: Record<string, string> = cmRaw.data ?? {};
      const cmBinaryData: Record<string, string> = cmRaw.binaryData ?? {};
      const mergedData = { ...cmData, ...cmBinaryData };

      const cmUpdatedStr = cmRaw.metadata?.creationTimestamp; // In k8s ConfigMap updates don't change creationTimestamp, but metadata.resourceVersion changes
      const cmUpdated = cmUpdatedStr ? new Date(cmUpdatedStr).getTime() : undefined;

      const isDrift = startedAt && cmUpdated && cmUpdated > startedAt;

      for (const [key, val] of Object.entries(mergedData)) {
        const entryName = `${prefix}${key}`;
        entries.push({
          name: entryName,
          value: String(val),
          sourceType: 'configMap',
          sourceName: cmName,
          sourceKey: key,
          isSecret: false,
          drift: isDrift ? { reason: `ConfigMap ${cmName} updated after container start` } : undefined,
        });
        if (isDrift) driftCount++;
      }
    } else if (ef.secretRef) {
      const secName = ef.secretRef.name;
      const sec = secrets ? [...secrets.values()].find((s) => s.name === secName && (!namespace || s.namespace === namespace)) : undefined;
      const secRaw = sec?.raw ?? {};
      const secData: Record<string, string> = secRaw.data ?? {};

      for (const key of Object.keys(secData)) {
        const resolved = resolveSecretValue(secData, key);
        const entryName = `${prefix}${key}`;
        entries.push({
          name: entryName,
          value: resolved,
          sourceType: 'secret',
          sourceName: secName,
          sourceKey: key,
          isSecret: true,
        });
      }
    }
  }

  // 2. Process explicit env definitions
  const envList: any[] = container.env ?? [];
  for (const env of envList) {
    const name = env.name;
    if (!name) continue;

    if (env.value !== undefined) {
      // Direct literal value
      entries.push({
        name,
        value: String(env.value),
        sourceType: 'direct',
        isSecret: false,
      });
    } else if (env.valueFrom?.configMapKeyRef) {
      const ref = env.valueFrom.configMapKeyRef;
      const cmName = ref.name;
      const cmKey = ref.key;
      const cm = configMaps ? [...configMaps.values()].find((c) => c.name === cmName && (!namespace || c.namespace === namespace)) : undefined;
      const cmRaw = cm?.raw ?? {};
      const cmData: Record<string, string> = cmRaw.data ?? {};
      const clusterVal = cmData[cmKey];

      // Check if ConfigMap modified after pod started
      const cmUpdatedStr = cmRaw.metadata?.creationTimestamp;
      const cmUpdated = cmUpdatedStr ? new Date(cmUpdatedStr).getTime() : undefined;
      const isStale = startedAt && cmUpdated && cmUpdated > startedAt;

      entries.push({
        name,
        value: clusterVal !== undefined ? String(clusterVal) : undefined,
        sourceType: 'configMap',
        sourceName: cmName,
        sourceKey: cmKey,
        isSecret: false,
        drift: isStale ? {
          clusterValue: clusterVal !== undefined ? String(clusterVal) : undefined,
          reason: `ConfigMap/${cmName} updated after Pod started`,
        } : undefined,
      });
      if (isStale) driftCount++;
    } else if (env.valueFrom?.secretKeyRef) {
      const ref = env.valueFrom.secretKeyRef;
      const secName = ref.name;
      const secKey = ref.key;
      const sec = secrets ? [...secrets.values()].find((s) => s.name === secName && (!namespace || s.namespace === namespace)) : undefined;
      const secRaw = sec?.raw ?? {};
      const secData: Record<string, string> = secRaw.data ?? {};
      const clusterVal = resolveSecretValue(secData, secKey);

      entries.push({
        name,
        value: clusterVal,
        sourceType: 'secret',
        sourceName: secName,
        sourceKey: secKey,
        isSecret: true,
      });
    } else if (env.valueFrom?.fieldRef) {
      const fieldPath = env.valueFrom.fieldRef.fieldPath;
      let val: string | undefined;

      // Common field paths
      if (fieldPath === 'metadata.name') val = pod.name;
      else if (fieldPath === 'metadata.namespace') val = pod.namespace;
      else if (fieldPath === 'status.podIP') val = status.podIP;
      else if (fieldPath === 'status.hostIP') val = status.hostIP;
      else if (fieldPath === 'spec.nodeName') val = spec.nodeName;
      else if (fieldPath === 'spec.serviceAccountName') val = spec.serviceAccountName;

      entries.push({
        name,
        value: val,
        sourceType: 'field',
        sourceName: fieldPath,
        isSecret: false,
      });
    } else if (env.valueFrom?.resourceFieldRef) {
      const resource = env.valueFrom.resourceFieldRef.resource;
      entries.push({
        name,
        value: undefined,
        sourceType: 'resourceField',
        sourceName: resource,
        isSecret: false,
      });
    } else {
      entries.push({
        name,
        value: undefined,
        sourceType: 'unknown',
        rawSource: env.valueFrom,
        isSecret: false,
      });
    }
  }

  // Deduplicate by name (later entries override earlier ones, as per Kubernetes runtime behavior)
  const dedupedMap = new Map<string, PodEnvEntry>();
  for (const entry of entries) {
    dedupedMap.set(entry.name, entry);
  }

  const finalEntries = Array.from(dedupedMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  return {
    containerName: container.name,
    entries: finalEntries,
    hasDrift: driftCount > 0,
    driftCount,
  };
}
