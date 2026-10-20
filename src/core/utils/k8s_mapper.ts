import type { ResourceItem, ResourceKind } from '../../types/k8s';
import { mapPodContainers } from '../resources/containers';
import { stringify } from 'yaml';
import { apiVersionFor, resourceType } from '../resources/resource_types';

/**
 * Maps raw Kubernetes API JSON objects (from kube-rs / kubectl) into normalized ResourceItem objects.
 */
export function mapK8sResource(raw: any, kind: ResourceKind): ResourceItem {
  const meta = raw.metadata || {};
  const spec = raw.spec || {};
  const status = raw.status || {};

  const creationTimestamp = meta.creationTimestamp;
  const labels: Record<string, string> = meta.labels || {};

  const base: ResourceItem = {
    uid: meta.uid || JSON.stringify([kind, meta.namespace ?? '', meta.name]),
    name: meta.name || 'unnamed',
    namespace: meta.namespace,
    kind,
    apiVersion: raw.apiVersion || apiVersionFor(resourceType(kind)),
    creationTimestamp,
    labels,
    metadata: meta,
    spec,
    statusRaw: status,
    raw,
    rawYaml: stringify(raw),
    age: creationTimestamp ? formatAge(creationTimestamp) : undefined,
  };

  switch (kind) {
    case 'Pod': {
      const cStatuses: any[] = status.containerStatuses || [];
      let phase = status.phase || 'Unknown';

      if (meta.deletionTimestamp) {
        phase = 'Terminating';
      } else {
        for (const cs of cStatuses) {
          if (cs.state?.waiting?.reason) {
            phase = cs.state.waiting.reason;
            break;
          }
          if (cs.state?.terminated?.reason) {
            phase = cs.state.terminated.reason;
            break;
          }
        }
      }

      const readyCount = cStatuses.filter((c) => c.ready).length;
      const totalCount = (spec.containers || []).length;
      const restarts = cStatuses.reduce((acc: number, c: any) => acc + (c.restartCount || 0), 0);

      const containers = mapPodContainers(spec, status);

      return {
        ...base,
        status: phase,
        ready: `${readyCount}/${totalCount}`,
        restarts,
        ip: status.podIP || '-',
        node: spec.nodeName || '-',
        containers,
        image: containers[0]?.image || '',
      };
    }

    case 'Deployment': {
      const desired = spec.replicas ?? 1;
      const ready = status.readyReplicas || 0;
      return {
        ...base,
        status: `${ready}/${desired}`,
        ready: `${ready}/${desired}`,
        replicas: desired,
        image: spec.template?.spec?.containers?.[0]?.image || '',
      };
    }

    case 'StatefulSet': {
      const desired = spec.replicas ?? 1;
      const ready = status.readyReplicas || 0;
      return {
        ...base,
        status: `${ready}/${desired}`,
        ready: `${ready}/${desired}`,
        replicas: desired,
        image: spec.template?.spec?.containers?.[0]?.image || '',
      };
    }

    case 'DaemonSet': {
      const desired = status.desiredNumberScheduled || 0;
      const ready = status.numberReady || 0;
      return {
        ...base,
        status: `${ready}/${desired}`,
        ready: `${ready}/${desired}`,
        replicas: desired,
        image: spec.template?.spec?.containers?.[0]?.image || '',
      };
    }

    case 'Service': {
      const ports = (spec.ports || [])
        .map((p: any) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol || 'TCP'}`)
        .join(', ');
      return {
        ...base,
        serviceType: spec.type || 'ClusterIP',
        clusterIP: spec.clusterIP || 'None',
        status: spec.type || 'ClusterIP',
        ready: ports || '-',
      };
    }

    case 'Node': {
      const readyCond = (status.conditions || []).find((c: any) => c.type === 'Ready');
      const isReady = readyCond?.status === 'True';
      const roles = Object.keys(labels)
        .filter((k) => k.startsWith('node-role.kubernetes.io/'))
        .map((k) => k.replace('node-role.kubernetes.io/', ''))
        .join(', ') || 'worker';

      return {
        ...base,
        status: isReady ? 'Ready' : 'NotReady',
        nodeRoles: roles,
        nodeVersion: status.nodeInfo?.kubeletVersion || '-',
        nodeCpu: status.capacity?.cpu || '-',
        nodeMem: status.capacity?.memory || '-',
        ip: (status.addresses || []).find((a: any) => a.type === 'InternalIP')?.address || '-',
      };
    }

    case 'Namespace': {
      return {
        ...base,
        status: status.phase || 'Active',
      };
    }

    case 'Job': {
      const succeeded = status.succeeded || 0;
      const completions = spec.completions || 1;
      return {
        ...base,
        status: succeeded >= completions ? 'Completed' : status.active ? 'Running' : 'Pending',
        ready: `${succeeded}/${completions}`,
      };
    }

    case 'CronJob': {
      const suspend = spec.suspend ? 'Suspended' : 'Active';
      return {
        ...base,
        status: suspend,
        ready: spec.schedule || '-',
      };
    }

    case 'ConfigMap': {
      const dataKeys = Object.keys(raw.data || {}).length;
      return {
        ...base,
        status: 'Active',
        dataKeys,
        ready: `${dataKeys} keys`,
      };
    }

    case 'Secret': {
      const dataKeys = Object.keys(raw.data || {}).length;
      return {
        ...base,
        status: 'Active',
        secretType: raw.type || 'Opaque',
        dataKeys,
        ready: `${dataKeys} keys`,
      };
    }

    case 'PersistentVolumeClaim': {
      return {
        ...base,
        status: status.phase || 'Bound',
        storageClass: spec.storageClassName || '-',
        volume: spec.volumeName || '-',
        ready: spec.resources?.requests?.storage || '-',
      };
    }

    case 'PersistentVolume': {
      return {
        ...base,
        status: status.phase || 'Available',
        storageClass: spec.storageClassName || '-',
        reclaimPolicy: spec.persistentVolumeReclaimPolicy || 'Retain',
        ready: spec.capacity?.storage || '-',
      };
    }

    case 'StorageClass': {
      return {
        ...base,
        status: raw.provisioner || '-',
        reclaimPolicy: raw.reclaimPolicy || 'Delete',
      };
    }

    case 'Ingress': {
      const hosts = (spec.rules || []).map((r: any) => r.host).filter(Boolean).join(', ');
      return {
        ...base,
        status: hosts || '*',
        ready: hosts || '*',
        ingressHosts: hosts || '*',
        ingressClass: spec.ingressClassName,
      };
    }

    default:
      return {
        ...base,
        status: status.phase || 'Active',
      };
  }
}

export function mapK8sResourceList(rawList: any, kind: ResourceKind): ResourceItem[] {
  const items = rawList?.items || (Array.isArray(rawList) ? rawList : []);
  return items.map((item: any) => mapK8sResource(item, kind));
}

function formatAge(timestamp: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
