import { resourceStatus } from '../resources/gitops';
import type { ResourceItem, ResourceKind } from '../../types/k8s';
import { mapPodContainers } from '../resources/containers';
import { stringify } from 'yaml';
import { apiVersionFor, resourceType } from '../resources/resource_types';

/**
 * Maps raw Kubernetes API JSON objects (from kube-rs / kubectl) into normalized ResourceItem objects.
 */
function mapResource(raw: any, kind: ResourceKind): ResourceItem {
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
      const owner = meta.ownerReferences?.[0];
      const controlledBy = owner?.name ? `${owner.kind}/${owner.name}` : undefined;
      const qosClass = status.qosClass || spec.qosClass || undefined;

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
        controlledBy,
        qosClass,
      };
    }

    case 'Deployment': {
      const desired = spec.replicas ?? 1;
      const ready = status.readyReplicas || 0;
      const conditions: any[] = status.conditions || [];
      const availableCond = conditions.find((c: any) => c.type === 'Available');
      const progressingCond = conditions.find((c: any) => c.type === 'Progressing');
      const replicaFailure = conditions.find((c: any) => c.type === 'ReplicaFailure');

      let condStatus = 'Available';
      if (replicaFailure && replicaFailure.status === 'True') {
        condStatus = replicaFailure.reason || 'ReplicaFailure';
      } else if (progressingCond && progressingCond.reason === 'ProgressDeadlineExceeded') {
        condStatus = 'ProgressDeadlineExceeded';
      } else if (ready < desired) {
        condStatus = 'Progressing';
      } else if (availableCond && availableCond.status === 'False') {
        condStatus = availableCond.reason || 'Unavailable';
      } else if (availableCond?.status === 'True') {
        condStatus = 'Available';
      } else if (desired === 0) {
        condStatus = 'ScaledDown';
      }

      const selectorText = spec.selector?.matchLabels
        ? Object.entries(spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(', ')
        : undefined;

      return {
        ...base,
        status: condStatus,
        ready: `${ready}/${desired}`,
        replicas: desired,
        image: spec.template?.spec?.containers?.[0]?.image || '',
        selectorText,
      };
    }

    case 'ReplicaSet': {
      const desired = spec.replicas ?? 1;
      const ready = status.readyReplicas || 0;
      const condStatus = (ready === desired && desired > 0) ? 'Ready' : ready < desired ? 'Progressing' : desired === 0 ? 'ScaledDown' : 'Ready';
      const owner = meta.ownerReferences?.[0];
      const controlledBy = owner?.name ? `${owner.kind}/${owner.name}` : undefined;

      return {
        ...base,
        status: condStatus,
        ready: `${ready}/${desired}`,
        replicas: desired,
        image: spec.template?.spec?.containers?.[0]?.image || '',
        controlledBy,
      };
    }

    case 'ReplicationController': {
      const desired = spec.replicas ?? 1;
      const ready = status.readyReplicas || 0;
      const condStatus = (ready === desired && desired > 0) ? 'Ready' : ready < desired ? 'Progressing' : desired === 0 ? 'ScaledDown' : 'Ready';
      return {
        ...base,
        status: condStatus,
        ready: `${ready}/${desired}`,
        replicas: desired,
        image: spec.template?.spec?.containers?.[0]?.image || '',
      };
    }

    case 'StatefulSet': {
      const desired = spec.replicas ?? 1;
      const ready = status.readyReplicas || 0;
      const condStatus = (ready === desired && desired > 0) ? 'Ready' : ready < desired ? 'Progressing' : desired === 0 ? 'ScaledDown' : 'Ready';
      return {
        ...base,
        status: condStatus,
        ready: `${ready}/${desired}`,
        replicas: desired,
        image: spec.template?.spec?.containers?.[0]?.image || '',
      };
    }

    case 'DaemonSet': {
      const desired = status.desiredNumberScheduled || 0;
      const ready = status.numberReady || 0;
      const condStatus = (ready === desired && desired > 0) ? 'Ready' : ready < desired ? 'Progressing' : desired === 0 ? 'ScaledDown' : 'Ready';
      const nodeSelector = spec.template?.spec?.nodeSelector;
      const selectorText = nodeSelector
        ? Object.entries(nodeSelector).map(([k, v]) => `${k}=${v}`).join(', ')
        : undefined;

      return {
        ...base,
        status: condStatus,
        ready: `${ready}/${desired}`,
        replicas: desired,
        image: spec.template?.spec?.containers?.[0]?.image || '',
        selectorText,
      };
    }

    case 'Service': {
      const ports = (spec.ports || [])
        .map((p: any) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol || 'TCP'}`)
        .join(', ');
      const lbIngress = status.loadBalancer?.ingress?.map((i: any) => i.ip || i.hostname).filter(Boolean).join(', ');
      const extIps = spec.externalIPs?.filter(Boolean).join(', ');
      const externalIP = lbIngress || extIps || undefined;
      const selectorText = spec.selector
        ? Object.entries(spec.selector).map(([k, v]) => `${k}=${v}`).join(', ')
        : undefined;

      return {
        ...base,
        serviceType: spec.type || 'ClusterIP',
        clusterIP: spec.clusterIP || 'None',
        externalIP,
        selectorText,
        status: spec.type || 'ClusterIP',
        ports: ports || '-',
      };
    }

    case 'Node': {
      const readyCond = (status.conditions || []).find((c: any) => c.type === 'Ready');
      const isReady = readyCond?.status === 'True';
      const roles = Object.keys(labels)
        .filter((k) => k.startsWith('node-role.kubernetes.io/'))
        .map((k) => k.replace('node-role.kubernetes.io/', ''))
        .join(', ') || 'worker';
      const internalIp = (status.addresses || []).find((a: any) => a.type === 'InternalIP')?.address || status.addresses?.[0]?.address || '-';
      const taintsCount = (spec.taints || []).length;
      const allocatablePods = status.allocatable?.pods || status.capacity?.pods;

      return {
        ...base,
        status: isReady ? 'Ready' : 'NotReady',
        nodeRoles: roles,
        nodeVersion: status.nodeInfo?.kubeletVersion || '-',
        nodeCpu: status.capacity?.cpu || '-',
        nodeMem: status.capacity?.memory || '-',
        nodePods: allocatablePods ? String(allocatablePods) : undefined,
        nodeIp: internalIp,
        taintsCount,
        ip: internalIp,
      };
    }

    case 'Namespace': {
      return {
        ...base,
        status: resourceStatus(raw),
      };
    }

    case 'Job': {
      const succeeded = status.succeeded || 0;
      const completions = spec.completions || 1;
      let duration: string | undefined;
      if (status.startTime && status.completionTime) {
        const start = Date.parse(status.startTime);
        const end = Date.parse(status.completionTime);
        const sec = Math.max(0, Math.floor((end - start) / 1000));
        duration = formatDuration(sec);
      } else if (status.startTime) {
        const start = Date.parse(status.startTime);
        const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
        duration = `${formatDuration(sec)} (running)`;
      }

      return {
        ...base,
        status: succeeded >= completions ? 'Completed' : status.active ? 'Running' : status.failed ? 'Failed' : 'Pending',
        ready: `${succeeded}/${completions}`,
        duration,
      };
    }

    case 'CronJob': {
      const suspend = spec.suspend ? 'Suspended' : 'Active';
      const activeJobs = (status.active || []).length;
      const lastScheduleTime = status.lastScheduleTime ? formatAge(status.lastScheduleTime) : undefined;

      return {
        ...base,
        status: suspend,
        schedule: spec.schedule || '-',
        activeJobs,
        lastScheduleTime,
      };
    }

    case 'ConfigMap': {
      const dataKeys = Object.keys(raw.data || {}).length;
      let sizeBytes = 0;
      for (const val of Object.values(raw.data || {})) {
        if (typeof val === 'string') sizeBytes += val.length;
      }
      for (const val of Object.values(raw.binaryData || {})) {
        if (typeof val === 'string') sizeBytes += Math.floor((val.length * 3) / 4);
      }

      return {
        ...base,
        status: 'Active',
        dataKeys,
        sizeBytes,
      };
    }

    case 'Secret': {
      const dataKeys = Object.keys(raw.data || {}).length;
      let sizeBytes = 0;
      for (const val of Object.values(raw.data || {})) {
        if (typeof val === 'string') sizeBytes += Math.floor((val.length * 3) / 4);
      }
      for (const val of Object.values(raw.stringData || {})) {
        if (typeof val === 'string') sizeBytes += val.length;
      }

      return {
        ...base,
        status: 'Active',
        secretType: raw.type || 'Opaque',
        dataKeys,
        sizeBytes,
      };
    }

    case 'PersistentVolumeClaim': {
      return {
        ...base,
        status: status.phase || 'Bound',
        storageClass: spec.storageClassName || '-',
        volume: spec.volumeName || '-',
        capacity: spec.resources?.requests?.storage || '-',
      };
    }

    case 'PersistentVolume': {
      return {
        ...base,
        status: status.phase || 'Available',
        storageClass: spec.storageClassName || '-',
        reclaimPolicy: spec.persistentVolumeReclaimPolicy || 'Retain',
        capacity: spec.capacity?.storage || '-',
      };
    }

    case 'StorageClass': {
      return {
        ...base,
        status: 'Active',
        provisioner: raw.provisioner || '-',
        reclaimPolicy: raw.reclaimPolicy || 'Delete',
      };
    }

    case 'Ingress': {
      const hosts = (spec.rules || []).map((r: any) => r.host).filter(Boolean).join(', ');
      return {
        ...base,
        status: hosts || '*',
        ingressHosts: hosts || '*',
        ingressClass: spec.ingressClassName,
      };
    }

    default:
      return {
        ...base,
        status: resourceStatus(raw),
      };
  }
}

/** Serialize YAML only when an editor or copy action requests it. */
export function mapK8sResource(raw: any, kind: ResourceKind): ResourceItem {
  const item = mapResource(raw, kind);
  if ((kind === 'ConfigMap' || kind === 'Secret') && Array.isArray(raw?.metadata?.managedFields)) {
    // The bridge keeps only payload writers' timestamps; they are not part of the editable manifest.
    const times = raw.metadata.managedFields.map((entry: any) => Date.parse(entry?.time)).filter(Number.isFinite);
    if (times.length) item.dataUpdatedAt = new Date(Math.max(...times)).toISOString();
    delete raw.metadata.managedFields;
  }
  let yaml: string | undefined;
  Object.defineProperty(item, 'rawYaml', { enumerable: true, configurable: true, get: () => yaml ??= stringify(raw) });
  return item;
}

export function mapK8sResourceList(rawList: any, kind: ResourceKind): ResourceItem[] {
  const items = rawList?.items || (Array.isArray(rawList) ? rawList : []);
  return items.map((item: any) => mapK8sResource(item, kind));
}

export function formatAge(timestamp: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (mins < 60) return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}
