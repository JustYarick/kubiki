import { mapK8sResource } from '../../core/utils/k8s_mapper';
import { apiVersionFor, resourceType } from '../../core/resources/resource_types';
import type { ResourceItem, ResourceKind } from '../../types/k8s';
import { PRODUCTION_NAMESPACES, PRODUCTION_NODES, PRODUCTION_WORKLOADS } from './mock_cluster_profile';

/** Append a production-sized graph as API objects; YAML stays lazy at this volume. */
export function appendProductionResources(out: Record<ResourceKind, ResourceItem[]>, namespaces: string[]) {
  const now = Date.now();
  const at = (minutes: number) => new Date(now - minutes * 60000).toISOString();
  const add = (kind: ResourceKind, name: string, namespace?: string, fields: Record<string, any> = {}, metadata: Record<string, any> = {}) => {
    const item = mapK8sResource({
      apiVersion: apiVersionFor(resourceType(kind)), kind,
      ...fields,
      metadata: { name, namespace, uid: `production-${kind}-${namespace ?? 'cluster'}-${name}`,
        resourceVersion: '1', generation: 1, creationTimestamp: at(60 * 24 * 21), ...metadata },
    }, kind);
    (out[kind] ??= []).push(item);
    return item;
  };
  const ownerOf = (item: ResourceItem) => ({ apiVersion: item.apiVersion, kind: item.kind, name: item.name, uid: item.uid, controller: true, blockOwnerDeletion: true });
  const nodes = PRODUCTION_NODES.map((node, index) => add('Node', node.name, undefined, {
    spec: index >= 178 ? { taints: [{ key: 'node.kubernetes.io/unreachable', effect: 'NoSchedule' }] } : {},
    status: {
      capacity: { cpu: '32', memory: '128Gi', pods: '110', 'ephemeral-storage': '900Gi' },
      allocatable: { cpu: '31500m', memory: '120Gi', pods: '110', 'ephemeral-storage': '850Gi' },
      addresses: [{ type: 'InternalIP', address: `10.0.${Math.floor(index / 60)}.${index % 60 + 10}` }],
      nodeInfo: { kubeletVersion: index % 13 ? 'v1.31.2' : 'v1.31.1', osImage: 'Ubuntu 24.04 LTS', containerRuntimeVersion: 'containerd://1.7.24', architecture: 'amd64', operatingSystem: 'linux' },
      conditions: [{ type: 'Ready', status: index >= 178 ? 'False' : 'True', reason: index >= 178 ? 'KubeletNotReady' : 'KubeletReady', lastTransitionTime: at(index >= 178 ? 8 : 14400) },
        ...['MemoryPressure', 'DiskPressure', 'PIDPressure'].map(type => ({ type, status: 'False' }))],
    },
  }, { labels: { 'kubernetes.io/hostname': node.name, 'kubernetes.io/os': 'linux', 'topology.kubernetes.io/region': 'eu-central-1', 'topology.kubernetes.io/zone': node.zone, 'node.kubernetes.io/instance-type': 'm6i.8xlarge', 'kubiki.dev/node-pool': node.pool } }));
  for (const node of nodes) add('Lease', node.name, 'kube-system', { spec: { holderIdentity: node.name, leaseDurationSeconds: 40, renewTime: at(node.status === 'Ready' ? 0 : 8) } });

  const namespaceProfiles = new Map(PRODUCTION_NAMESPACES.map(profile => [profile.name, profile]));
  for (const name of namespaces) {
    if (out.Namespace.some(item => item.name === name)) continue;
    const profile = namespaceProfiles.get(name);
    add('Namespace', name, undefined, { status: { phase: 'Active' } }, { labels: {
      'kubernetes.io/metadata.name': name,
      'pod-security.kubernetes.io/enforce': 'restricted',
      ...(profile ? { team: profile.domain, environment: profile.environment } : {}),
    } });
  }
  add('StorageClass', 'ebs-gp3', undefined, { provisioner: 'ebs.csi.aws.com', parameters: { type: 'gp3', encrypted: 'true' }, reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: true });
  add('IngressClass', 'nginx', undefined, { spec: { controller: 'k8s.io/ingress-nginx' } });
  add('PriorityClass', 'production-critical', undefined, { value: 100000, globalDefault: false, description: 'Critical customer-facing services' });
  add('ClusterRole', 'production-observer', undefined, { rules: [{ apiGroups: ['', 'apps', 'batch'], resources: ['pods', 'pods/log', 'services', 'deployments', 'statefulsets', 'jobs'], verbs: ['get', 'list', 'watch'] }] });
  add('ClusterRoleBinding', 'production-observers', undefined, {
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'production-observer' },
    subjects: PRODUCTION_NAMESPACES.map(({ name }) => ({ kind: 'ServiceAccount', name: 'observer', namespace: name })),
  });

  for (const { name: namespace, environment } of PRODUCTION_NAMESPACES) {
    add('ServiceAccount', 'observer', namespace, { automountServiceAccountToken: false });
    add('Role', 'application-reader', namespace, { rules: [{ apiGroups: [''], resources: ['configmaps', 'secrets'], verbs: ['get'] }] });
    add('ResourceQuota', 'namespace-budget', namespace, {
      spec: { hard: { pods: '300', 'requests.cpu': '100', 'requests.memory': '200Gi', 'limits.cpu': '300', 'limits.memory': '500Gi', persistentvolumeclaims: '30' } },
      status: { hard: { pods: '300', 'requests.cpu': '100', 'requests.memory': '200Gi' }, used: { pods: '129', 'requests.cpu': '32', 'requests.memory': '64Gi' } },
    });
    add('LimitRange', 'container-defaults', namespace, { spec: { limits: [{ type: 'Container', default: { cpu: '2', memory: '1Gi' }, defaultRequest: { cpu: '250m', memory: '128Mi' } }] } });
    add('NetworkPolicy', 'namespace-isolation', namespace, { spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [{ from: [{ podSelector: {} }, { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }] }] } });
    add('NetworkPolicy', 'allow-monitoring', namespace, { spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [{ from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'monitoring' } } }], ports: [{ protocol: 'TCP', port: 9090 }] }] } });
    add('ConfigMap', 'environment', namespace, { data: { ENVIRONMENT: environment, LOG_LEVEL: environment === 'prod' ? 'info' : 'debug', REGION: 'eu-central-1' } });
  }

  let podIndex = 0;
  const event = (item: ResourceItem, reason: string, message: string, warning = false) => add('Event', `${item.name}.${reason.toLowerCase()}`, item.namespace, {
    involvedObject: { ...ownerOf(item), namespace: item.namespace }, type: warning ? 'Warning' : 'Normal', reason, message,
    count: warning ? 7 : 1, firstTimestamp: at(24), lastTimestamp: at(2), source: { component: 'kubelet', host: item.node },
  }, { creationTimestamp: at(24) });
  const pod = (owner: ResourceItem, name: string, template: Record<string, any>, labels: Record<string, string>, options: { node?: ResourceItem; phase?: string; claim?: string; ageMinutes?: number } = {}) => {
    const index = podIndex++;
    const ageMinutes = options.ageMinutes ?? 360 + index % 7200;
    const state = options.phase ?? (index % 211 === 0 ? 'Pending' : index % 307 === 0 ? 'CrashLoopBackOff' : index % 401 === 0 ? 'ImagePullBackOff' : index % 503 === 0 ? 'Terminating' : 'Running');
    const assigned = state !== 'Pending';
    const node = options.node ?? nodes[index % 178];
    const running = state === 'Running';
    const finished = state === 'Succeeded' || state === 'Failed';
    const phase = finished ? state : state === 'Pending' || state === 'ImagePullBackOff' ? 'Pending' : 'Running';
    const ip = `10.64.${Math.floor(index / 250)}.${index % 250 + 1}`;
    const containers = template.containers.map((container: any, i: number) => ({
      name: container.name, image: container.image, ready: running, restartCount: state === 'CrashLoopBackOff' ? 8 + index % 17 : index % 47 === 0 ? 1 + i : 0,
      state: finished ? { terminated: { reason: state === 'Succeeded' ? 'Completed' : 'Error', exitCode: state === 'Succeeded' ? 0 : 1, startedAt: at(20), finishedAt: at(15) } }
        : running || state === 'Terminating' ? { running: { startedAt: at(ageMinutes) } }
          : { waiting: { reason: state === 'Pending' ? 'ContainerCreating' : state, message: state === 'CrashLoopBackOff' ? 'Back-off restarting failed container' : 'Waiting for container startup' } },
    }));
    const item = add('Pod', name, owner.namespace, {
      spec: { ...template, ...(assigned ? { nodeName: node.name } : {}),
        ...(options.claim ? { volumes: [...(template.volumes ?? []), { name: 'data', persistentVolumeClaim: { claimName: options.claim } }] } : {}) },
      status: { phase, ...(assigned ? { podIP: ip, hostIP: node.nodeIp, startTime: at(ageMinutes) } : {}), qosClass: 'Burstable', containerStatuses: state === 'Pending' ? [] : containers,
        conditions: [{ type: 'PodScheduled', status: assigned ? 'True' : 'False', ...(assigned ? {} : { reason: 'Unschedulable', message: 'Insufficient cpu on available nodes.' }) }, { type: 'Ready', status: running ? 'True' : 'False' }] },
    }, { labels, ownerReferences: [ownerOf(owner)], creationTimestamp: at(ageMinutes), ...(state === 'Terminating' ? { deletionTimestamp: at(1), deletionGracePeriodSeconds: 30 } : {}) });
    if (index % 8 === 0 || !running && !finished) event(item, running ? 'Started' : state === 'Pending' ? 'FailedScheduling' : state === 'Terminating' ? 'Killing' : 'BackOff', running ? 'Started application container' : `Pod ${name}: ${state}`, !running && state !== 'Terminating');
    return item;
  };

  for (const app of PRODUCTION_WORKLOADS) {
    const { name, namespace, index, replicas, kind, port } = app;
    const labels = { app: name, 'app.kubernetes.io/name': name, 'app.kubernetes.io/instance': app.release, 'app.kubernetes.io/part-of': app.domain, 'app.kubernetes.io/component': app.component, environment: app.environment };
    const metadata = { labels: { ...labels, 'app.kubernetes.io/managed-by': 'Helm' }, annotations: { 'meta.helm.sh/release-name': app.release, 'meta.helm.sh/release-namespace': namespace } };
    const configName = `${name}-config`;
    const secretName = `${name}-credentials`;
    add('ServiceAccount', name, namespace, { automountServiceAccountToken: false }, { labels });
    add('RoleBinding', `${name}-reader`, namespace, { roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'application-reader' }, subjects: [{ kind: 'ServiceAccount', name, namespace }] });
    add('ConfigMap', configName, namespace, { data: { 'app.yaml': `environment: ${app.environment}\nport: ${port}\nlogLevel: info\n`, 'feature-flags.json': '{"tracing":true,"cache":true}' } }, metadata);
    add('Secret', secretName, namespace, { type: 'Opaque', data: { username: 'ZGVtbw==', password: 'ZGVtby1vbmx5' } }, metadata);
    const container = { name: 'app', image: app.image, ports: [{ name: 'http', containerPort: port }],
      resources: { requests: { cpu: kind === 'StatefulSet' ? '500m' : '250m', memory: '128Mi' }, limits: { cpu: '2', memory: '1Gi' } },
      envFrom: [{ configMapRef: { name: configName } }, { secretRef: { name: secretName } }],
      readinessProbe: { tcpSocket: { port }, initialDelaySeconds: 5, periodSeconds: 10 },
      livenessProbe: { tcpSocket: { port }, initialDelaySeconds: 15, periodSeconds: 20 },
      ...(kind === 'StatefulSet' ? { volumeMounts: [{ name: 'data', mountPath: app.component === 'postgres' ? '/var/lib/postgresql/data' : '/data' }] } : {}),
    };
    const template = { serviceAccountName: name, automountServiceAccountToken: false, priorityClassName: 'production-critical', terminationGracePeriodSeconds: 30,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 },
      containers: [container, ...(kind === 'Deployment' && index % 4 === 0 ? [{ name: 'envoy', image: 'envoyproxy/envoy:v1.31', ports: [{ containerPort: 15020 }], resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi' } } }] : [])],
      topologySpreadConstraints: [{ maxSkew: 1, topologyKey: 'topology.kubernetes.io/zone', whenUnsatisfiable: 'ScheduleAnyway', labelSelector: { matchLabels: { app: name } } }],
    };
    const workload = add(kind, name, namespace, { spec: { replicas, selector: { matchLabels: { app: name } }, template: { metadata: { labels }, spec: template },
      ...(kind === 'Deployment' ? { strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } } } : { serviceName: name, podManagementPolicy: 'Parallel', volumeClaimTemplates: [{ metadata: { name: 'data' }, spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'ebs-gp3', resources: { requests: { storage: '100Gi' } } } }] }) },
      status: {} }, metadata);
    const hash = (0x7f9c800 + index).toString(16);
    const owner = kind === 'Deployment' ? add('ReplicaSet', `${name}-${hash}`, namespace, {
      spec: { replicas, selector: { matchLabels: { app: name, 'pod-template-hash': hash } }, template: { metadata: { labels: { ...labels, 'pod-template-hash': hash } }, spec: template } }, status: {},
    }, { ...metadata, ownerReferences: [ownerOf(workload)] }) : workload;
    if (kind === 'Deployment' && index % 5 === 0) add('ReplicaSet', `${name}-old${hash}`, namespace, {
      spec: { replicas: 0, selector: { matchLabels: { app: name, 'pod-template-hash': `old${hash}` } }, template: { metadata: { labels: { ...labels, 'pod-template-hash': `old${hash}` } }, spec: template } }, status: { replicas: 0 },
    }, { ...metadata, ownerReferences: [ownerOf(workload)], creationTimestamp: at(20160) });
    const pods: ResourceItem[] = [];
    for (let replica = 0; replica < replicas; replica++) {
      let claim: string | undefined;
      if (kind === 'StatefulSet') {
        claim = `data-${name}-${replica}`;
        const volume = `pvc-${namespace}-${name}-${replica}`;
        add('PersistentVolumeClaim', claim, namespace, { spec: { volumeName: volume, storageClassName: 'ebs-gp3', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '100Gi' } } }, status: { phase: 'Bound', capacity: { storage: '100Gi' }, accessModes: ['ReadWriteOnce'] } }, metadata);
        add('PersistentVolume', volume, undefined, { spec: { capacity: { storage: '100Gi' }, accessModes: ['ReadWriteOnce'], storageClassName: 'ebs-gp3', persistentVolumeReclaimPolicy: 'Delete', claimRef: { namespace, name: claim }, csi: { driver: 'ebs.csi.aws.com', volumeHandle: `vol-demo-${index}-${replica}`, fsType: 'ext4' } }, status: { phase: 'Bound' } });
      }
      pods.push(pod(owner, kind === 'StatefulSet' ? `${name}-${replica}` : `${owner.name}-${(index * 31 + replica).toString(36).padStart(5, '0')}`, template, kind === 'Deployment' ? { ...labels, 'pod-template-hash': hash } : labels, { claim }));
    }
    const ready = pods.filter(item => item.status === 'Running').length;
    const status = { replicas, readyReplicas: ready, availableReplicas: ready, updatedReplicas: replicas, observedGeneration: 1,
      conditions: kind === 'Deployment' ? [{ type: 'Available', status: ready > 0 ? 'True' : 'False' }, { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' }] : [] };
    for (const item of new Set([owner, workload])) {
      Object.assign(item.raw!.status, status);
      item.ready = `${ready}/${replicas}`;
      item.status = ready === replicas ? item.kind === 'Deployment' ? 'Available' : 'Ready' : 'Progressing';
    }
    const service = add('Service', name, namespace, { spec: { type: 'ClusterIP', clusterIP: kind === 'StatefulSet' ? 'None' : `10.96.${Math.floor(index / 250)}.${index % 250 + 1}`, selector: { app: name }, ports: [{ name: 'http', port, targetPort: port, protocol: 'TCP' }] } }, metadata);
    const readyPods = pods.filter(item => item.status === 'Running');
    add('EndpointSlice', `${name}-001`, namespace, { addressType: 'IPv4', ports: [{ name: 'http', port, protocol: 'TCP' }], endpoints: readyPods.map(item => ({ addresses: [item.ip], conditions: { ready: true }, nodeName: item.node, targetRef: { kind: 'Pod', name: item.name, namespace, uid: item.uid } })) }, { labels: { 'kubernetes.io/service-name': name, 'endpointslice.kubernetes.io/managed-by': 'endpointslice-controller.k8s.io' }, ownerReferences: [ownerOf(service)] });
    const desiredHealthy = kind === 'StatefulSet' ? 2 : Math.ceil(replicas * .75);
    add('PodDisruptionBudget', name, namespace, { spec: { minAvailable: kind === 'StatefulSet' ? 2 : '75%', selector: { matchLabels: { app: name } } }, status: { currentHealthy: ready, desiredHealthy, disruptionsAllowed: Math.max(0, ready - desiredHealthy), expectedPods: replicas } });
    if (kind === 'Deployment') add('HorizontalPodAutoscaler', name, namespace, { spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind, name }, minReplicas: replicas, maxReplicas: replicas * 3, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }] }, status: { currentReplicas: replicas, desiredReplicas: replicas, currentMetrics: [{ type: 'Resource', resource: { name: 'cpu', current: { averageUtilization: 35 + index % 30 } } }], conditions: [{ type: 'AbleToScale', status: 'True' }, { type: 'ScalingActive', status: 'True' }] } });
    if (app.component === 'api' || app.component === 'web') {
      const host = `${name}.${namespace}.example.com`;
      add('Ingress', name, namespace, { spec: { ingressClassName: 'nginx', rules: [{ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name, port: { number: port } } } }] } }] }, status: { loadBalancer: { ingress: [{ hostname: 'production-ingress.example.com' }] } } }, metadata);
    }
    event(workload, ready === replicas ? 'ScalingReplicaSet' : 'Progressing', `${ready}/${replicas} replicas available`, false);
  }

  for (const [index, name] of ['node-exporter', 'fluent-bit', 'cilium', 'kube-proxy'].entries()) {
    const namespace = index === 0 ? 'monitoring' : index === 1 ? 'logging' : 'kube-system';
    const labels = { app: `production-${name}` };
    const template = { containers: [{ name, image: ['prom/node-exporter:v1.8.2', 'fluent/fluent-bit:3.2.0', 'quay.io/cilium/cilium:v1.16.4', 'registry.k8s.io/kube-proxy:v1.31.2'][index], resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi' } } }], nodeSelector: { 'kubernetes.io/os': 'linux' }, tolerations: [{ operator: 'Exists' }] };
    const ds = add('DaemonSet', `production-${name}`, namespace, { spec: { selector: { matchLabels: labels }, template: { metadata: { labels }, spec: template } }, status: { desiredNumberScheduled: nodes.length, currentNumberScheduled: nodes.length, numberReady: 178, numberUnavailable: 2, updatedNumberScheduled: nodes.length } });
    for (const [nodeIndex, node] of nodes.entries()) pod(ds, `${ds.name}-${String(nodeIndex).padStart(5, '0')}`, template, labels, { node, phase: nodeIndex >= 178 ? 'Unknown' : 'Running' });
  }

  for (const [nsIndex, { name: namespace } ] of PRODUCTION_NAMESPACES.entries()) {
    for (const [index, task] of ['database-backup', 'cleanup', 'report-export'].entries()) {
      const failed = index === 0 && nsIndex % 11 === 0;
      const active = index === 2 && nsIndex % 5 === 0;
      const template = { restartPolicy: 'Never', containers: [{ name: task, image: 'ghcr.io/acme/operations:v1.8.0', args: [task], resources: { requests: { cpu: '250m', memory: '128Mi' }, limits: { cpu: '1', memory: '512Mi' } } }] };
      const cron = add('CronJob', task, namespace, { spec: { schedule: ['0 2 * * *', '*/30 * * * *', '0 */6 * * *'][index], concurrencyPolicy: 'Forbid', successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 1, jobTemplate: { spec: { backoffLimit: 3, template: { spec: template } } } }, status: { lastScheduleTime: at(20) } });
      const job = add('Job', `${task}-28981200`, namespace, { spec: { completions: 1, parallelism: 1, backoffLimit: 3, template: { spec: template } }, status: { startTime: at(20), ...(active ? { active: 1 } : failed ? { failed: 4, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] } : { succeeded: 1, completionTime: at(15), conditions: [{ type: 'Complete', status: 'True' }] }) } }, { ownerReferences: [ownerOf(cron)], creationTimestamp: at(20) });
      if (active) {
        cron.raw!.status.active = [{ apiVersion: 'batch/v1', kind: 'Job', name: job.name, namespace, uid: job.uid }];
        cron.activeJobs = 1;
      }
      pod(job, `${job.name}-x7k2p`, template, { 'job-name': job.name }, { phase: active ? 'Running' : failed ? 'Failed' : 'Succeeded', ageMinutes: 20 });
      event(job, failed ? 'BackoffLimitExceeded' : active ? 'SuccessfulCreate' : 'Completed', failed ? 'Job has reached the specified backoff limit' : active ? 'Created job pod' : 'Job completed successfully', failed);
    }
  }
}
