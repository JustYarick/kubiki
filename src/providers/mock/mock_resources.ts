import { parse, stringify } from 'yaml';
import type { ResourceItem, ResourceKind } from '../../types/k8s';

/* ------------------------------------------------------------ */
/* Deterministic mock cluster: realistic data volume. */
/* ------------------------------------------------------------ */

export const MOCK_NAMESPACES = ['default', 'backend', 'frontend', 'monitoring', 'kube-system', 'logging'];

const NODE_HOSTS = ['node-1a', 'node-1b', 'node-2a', 'gpu-node-1'];

interface PodSeed {
  name: string;
  namespace: string;
  status: string;
  ready: string;
  restarts: number;
  node: string;
  age: string;
  ip: string;
  labels: Record<string, string>;
  containers: Array<{ name: string; image: string; ready: boolean; restarts: number; port: string }>;
}

const POD_SEEDS: PodSeed[] = [
  {
    name: 'api-gateway-7f9c8b6d5-q7x9z', namespace: 'default', status: 'Running', ready: '1/1', restarts: 0,
    node: 'node-1a', age: '14m', ip: '10.42.0.15',
    labels: { app: 'api-gateway', version: 'v2.4.1', tier: 'edge' },
    containers: [{ name: 'api', image: 'ghcr.io/kubiki/api-gateway:v2.4.1', ready: true, restarts: 0, port: '8080' }],
  },
  {
    name: 'auth-service-58848db6cb-kl8m2', namespace: 'backend', status: 'Running', ready: '2/2', restarts: 1,
    node: 'node-1b', age: '1h', ip: '10.42.1.18',
    labels: { app: 'auth-service', tier: 'backend' },
    containers: [
      { name: 'auth', image: 'ghcr.io/kubiki/auth:v1.9.3', ready: true, restarts: 1, port: '8081' },
      { name: 'envoy', image: 'envoyproxy/envoy:v1.31', ready: true, restarts: 0, port: '15020' },
    ],
  },
  {
    name: 'payment-worker-67f98b984-pv4n8', namespace: 'backend', status: 'CrashLoopBackOff', ready: '0/1', restarts: 23,
    node: 'node-1a', age: '24m', ip: '10.42.0.21',
    labels: { app: 'payment-worker', tier: 'backend', critical: 'true' },
    containers: [{ name: 'worker', image: 'ghcr.io/kubiki/payment:v3.2.0', ready: false, restarts: 23, port: '8082' }],
  },
  {
    name: 'redis-cache-0', namespace: 'backend', status: 'Running', ready: '1/1', restarts: 0,
    node: 'node-2a', age: '4d', ip: '10.42.2.24',
    labels: { app: 'redis-cache', component: 'cache' },
    containers: [{ name: 'redis', image: 'redis:7.2-alpine', ready: true, restarts: 0, port: '6379' }],
  },
  {
    name: 'postgres-db-0', namespace: 'backend', status: 'Running', ready: '1/1', restarts: 2,
    node: 'node-2a', age: '4d', ip: '10.42.2.25',
    labels: { app: 'postgres', component: 'database' },
    containers: [{ name: 'postgres', image: 'postgres:16.3', ready: true, restarts: 2, port: '5432' }],
  },
  {
    name: 'web-frontend-5d8b7c6f84-k2p9q', namespace: 'frontend', status: 'Running', ready: '1/1', restarts: 0,
    node: 'node-1b', age: '52m', ip: '10.42.1.31',
    labels: { app: 'web-frontend', tier: 'edge' },
    containers: [{ name: 'web', image: 'ghcr.io/kubiki/web:v0.34.0', ready: true, restarts: 0, port: '3000' }],
  },
  {
    name: 'web-frontend-5d8b7c6f84-v8n7m', namespace: 'frontend', status: 'Pending', ready: '0/1', restarts: 0,
    node: '-', age: '3m', ip: '-',
    labels: { app: 'web-frontend', tier: 'edge' },
    containers: [{ name: 'web', image: 'ghcr.io/kubiki/web:v0.34.0', ready: false, restarts: 0, port: '3000' }],
  },
  {
    name: 'prometheus-server-0', namespace: 'monitoring', status: 'Running', ready: '2/2', restarts: 0,
    node: 'gpu-node-1', age: '12d', ip: '10.42.3.4',
    labels: { app: 'prometheus', component: 'metrics' },
    containers: [
      { name: 'prometheus', image: 'prom/prometheus:v2.51.2', ready: true, restarts: 0, port: '9090' },
      { name: 'reloader', image: 'ghcr.io/jimmidyson/configmap-reload:v0.12.0', ready: true, restarts: 0, port: '9091' },
    ],
  },
  {
    name: 'grafana-7798b6885-8h9f4', namespace: 'monitoring', status: 'Running', ready: '1/1', restarts: 0,
    node: 'gpu-node-1', age: '12d', ip: '10.42.3.5',
    labels: { app: 'grafana' },
    containers: [{ name: 'grafana', image: 'grafana/grafana:10.4.2', ready: true, restarts: 0, port: '3000' }],
  },
  {
    name: 'loki-0', namespace: 'logging', status: 'Running', ready: '1/1', restarts: 0,
    node: 'node-2a', age: '9d', ip: '10.42.2.40',
    labels: { app: 'loki' },
    containers: [{ name: 'loki', image: 'grafana/loki:3.0.0', ready: true, restarts: 0, port: '3100' }],
  },
  {
    name: 'promtail-abc12', namespace: 'logging', status: 'Running', ready: '1/1', restarts: 0,
    node: 'node-1a', age: '9d', ip: '10.42.0.41',
    labels: { app: 'promtail' },
    containers: [{ name: 'promtail', image: 'grafana/promtail:3.0.0', ready: true, restarts: 0, port: '3101' }],
  },
  {
    name: 'promtail-def34', namespace: 'logging', status: 'Running', ready: '1/1', restarts: 0,
    node: 'node-1b', age: '9d', ip: '10.42.1.42',
    labels: { app: 'promtail' },
    containers: [{ name: 'promtail', image: 'grafana/promtail:3.0.0', ready: true, restarts: 0, port: '3102' }],
  },
  {
    name: 'coredns-668d6bf9bc-j92k7', namespace: 'kube-system', status: 'Running', ready: '1/1', restarts: 0,
    node: 'node-1a', age: '16d', ip: '10.42.0.2',
    labels: { app: 'kube-dns' },
    containers: [{ name: 'coredns', image: 'registry.k8s.io/coredns/coredns:v1.11.1', ready: true, restarts: 0, port: '53' }],
  },
  {
    name: 'metrics-server-5cf889f8b-pr58w', namespace: 'kube-system', status: 'Running', ready: '1/1', restarts: 0,
    node: 'node-2a', age: '16d', ip: '10.42.2.2',
    labels: { app: 'metrics-server' },
    containers: [{ name: 'metrics-server', image: 'registry.k8s.io/metrics-server:v0.7.1', ready: true, restarts: 0, port: '4443' }],
  },
  {
    name: 'traefik-ingress-6f7ccf7dcb-h5r2v', namespace: 'kube-system', status: 'Running', ready: '1/1', restarts: 0,
    node: 'node-1a', age: '16d', ip: '10.42.0.3',
    labels: { app: 'traefik' },
    containers: [{ name: 'traefik', image: 'rancher/mirrored-traefik:2.11.0', ready: true, restarts: 0, port: '8443' }],
  },
  {
    name: 'kubiki-agent-28d9f-dw4kx', namespace: 'kube-system', status: 'Error', ready: '0/1', restarts: 5,
    node: 'gpu-node-1', age: '1h', ip: '10.42.3.44',
    labels: { app: 'kubiki-agent', 'managed-by': 'kubiki' },
    containers: [{ name: 'agent', image: 'ghcr.io/kubiki/agent:v0.1.0', ready: false, restarts: 5, port: '9001' }],
  },
];

const WORKLOAD_SEEDS: Record<string, Array<{ name: string; namespace: string; status?: string; ready?: string; age: string }>> = {
  Deployment: [
    { name: 'api-gateway', namespace: 'default', status: 'Progressing', ready: '1/1', age: '14m' },
    { name: 'auth-service', namespace: 'backend', status: 'Available', ready: '3/3', age: '6h' },
    { name: 'payment-worker', namespace: 'backend', status: 'Progressing', ready: '0/1', age: '24m' },
    { name: 'web-frontend', namespace: 'frontend', status: 'Available', ready: '2/2', age: '52m' },
    { name: 'grafana', namespace: 'monitoring', status: 'Available', ready: '1/1', age: '12d' },
    { name: 'promtail', namespace: 'logging', status: 'Available', ready: '2/2', age: '9d' },
  ],
  StatefulSet: [
    { name: 'postgres-db', namespace: 'backend', status: 'Running', ready: '1/1', age: '4d' },
    { name: 'redis-cache', namespace: 'backend', status: 'Running', ready: '1/1', age: '4d' },
    { name: 'loki', namespace: 'logging', status: 'Running', ready: '1/1', age: '9d' },
  ],
  DaemonSet: [
    { name: 'promtail', namespace: 'logging', status: 'Running', ready: '4/4', age: '9d' },
    { name: 'kubiki-agent', namespace: 'kube-system', status: 'NotReady', ready: '3/4', age: '1h' },
  ],
  Job: [
    { name: 'db-migrate-1729348', namespace: 'backend', status: 'Complete', ready: '1/1', age: '38m' },
    { name: 's3-backup-nightly', namespace: 'backend', status: 'Failed', ready: '0/1', age: '2h' },
    { name: 'img-scan-cve', namespace: 'monitoring', status: 'Running', ready: '1/1', age: '10m' },
  ],
  CronJob: [
    { name: 's3-backup-nightly', namespace: 'backend', ready: '0 2 * * *', age: '28d' },
    { name: 'cert-rotation', namespace: 'kube-system', ready: '0 */6 * * *', age: '42d' },
  ],
};

const SERVICE_SEEDS: Array<{ name: string; namespace: string; type: string; clusterIP: string; ports: string; age: string }> = [
  { name: 'kubernetes', namespace: 'default', type: 'ClusterIP', clusterIP: '10.43.0.1', ports: '443/TCP', age: '16d' },
  { name: 'api-gateway', namespace: 'default', type: 'NodePort', clusterIP: '10.43.0.22', ports: '80:30080/TCP', age: '14m' },
  { name: 'web-frontend', namespace: 'frontend', type: 'NodePort', clusterIP: '10.43.0.31', ports: '3000:31300/TCP', age: '52m' },
  { name: 'postgres-db', namespace: 'backend', type: 'ClusterIP', clusterIP: '10.43.0.25', ports: '5432/TCP', age: '4d' },
  { name: 'redis-cache', namespace: 'backend', type: 'ClusterIP', clusterIP: '10.43.0.24', ports: '6379/TCP', age: '4d' },
  { name: 'prometheus-server', namespace: 'monitoring', type: 'ClusterIP', clusterIP: '10.43.0.4', ports: '9090/TCP', age: '12d' },
  { name: 'grafana', namespace: 'monitoring', type: 'LoadBalancer', clusterIP: '10.43.0.5', ports: '3000:30300/TCP', age: '12d' },
];

const CONFIG_SEEDS: Record<
  'ConfigMap' | 'Secret',
  Array<{ name: string; namespace: string; keys: number; age: string }>
> = {
  ConfigMap: [
    { name: 'api-gateway-config', namespace: 'default', keys: 2, age: '14m' },
    { name: 'kubelet-config', namespace: 'kube-system', keys: 8, age: '16d' },
    { name: 'coredns', namespace: 'kube-system', keys: 1, age: '16d' },
    { name: 'prometheus-rules', namespace: 'monitoring', keys: 4, age: '12d' },
    { name: 'grafana-datasources', namespace: 'monitoring', keys: 1, age: '12d' },
    { name: 'loki-config', namespace: 'logging', keys: 3, age: '9d' },
  ],
  Secret: [
    { name: 'postgres-credentials', namespace: 'backend', keys: 2, age: '4d' },
    { name: 'jwt-signing-key', namespace: 'backend', keys: 1, age: '1h' },
    { name: 's3-backup-credentials', namespace: 'backend', keys: 2, age: '28d' },
    { name: 'grafana-admin', namespace: 'monitoring', keys: 2, age: '12d' },
  ],
};

const PVC_SEEDS: Array<{ name: string; namespace: string; status: string; volume: string; capacity: string; storageClass: string; age: string }> = [
  { name: 'postgres-data', namespace: 'backend', status: 'Bound', volume: 'pvc-8f3c9e22', capacity: '50Gi', storageClass: 'local-path', age: '4d' },
  { name: 'redis-data', namespace: 'backend', status: 'Bound', volume: 'pvc-2b7d1a55', capacity: '10Gi', storageClass: 'local-path', age: '4d' },
  { name: 'loki-data', namespace: 'logging', status: 'Bound', volume: 'pvc-90e4b118', capacity: '100Gi', storageClass: 'ssd-fast', age: '9d' },
  { name: 'prometheus-data', namespace: 'monitoring', status: 'Bound', volume: 'pvc-4c9f7d31', capacity: '200Gi', storageClass: 'ssd-fast', age: '12d' },
  { name: 'backup-cache', namespace: 'backend', status: 'Pending', volume: '-', capacity: '20Gi', storageClass: 'ssd-fast', age: '3m' },
];

const PV_SEEDS: Array<{ name: string; status: string; claim: string; capacity: string; storageClass: string; reclaim: string; age: string }> = [
  { name: 'pvc-8f3c9e22', status: 'Bound', claim: 'backend/postgres-data', capacity: '50Gi', storageClass: 'local-path', reclaim: 'Delete', age: '4d' },
  { name: 'pvc-2b7d1a55', status: 'Bound', claim: 'backend/redis-data', capacity: '10Gi', storageClass: 'local-path', reclaim: 'Delete', age: '4d' },
  { name: 'pvc-90e4b118', status: 'Bound', claim: 'logging/loki-data', capacity: '100Gi', storageClass: 'ssd-fast', reclaim: 'Retain', age: '9d' },
  { name: 'pvc-4c9f7d31', status: 'Bound', claim: 'monitoring/prometheus-data', capacity: '200Gi', storageClass: 'ssd-fast', reclaim: 'Retain', age: '12d' },
];

const SC_SEEDS: Array<{ name: string; provisioner: string; reclaim: string; binding: string; age: string }> = [
  { name: 'local-path', provisioner: 'rancher.io/local-path', reclaim: 'Delete', binding: 'WaitForFirstConsumer', age: '16d' },
  { name: 'ssd-fast', provisioner: 'csi.kubiki.dev/ssd', reclaim: 'Retain', binding: 'Immediate', age: '30d' },
];

const NODE_SEEDS: Array<{ name: string; status: string; roles: string; version: string; cpu: string; mem: string; pods: string; ip: string; os: string; taints: number }> = [
  { name: 'node-1a', status: 'Ready', roles: 'control-plane,worker', version: 'v1.31.2', cpu: '4.0 / 8', mem: '9.6 / 16Gi', pods: '14 / 110', ip: '192.168.58.2', os: 'ubuntu 22.04', taints: 1 },
  { name: 'node-1b', status: 'Ready', roles: 'worker', version: 'v1.31.2', cpu: '1.2 / 8', mem: '6.4 / 16Gi', pods: '9 / 110', ip: '192.168.58.3', os: 'ubuntu 22.04', taints: 0 },
  { name: 'node-2a', status: 'Ready', roles: 'worker', version: 'v1.31.1', cpu: '3.1 / 8', mem: '11.9 / 16Gi', pods: '12 / 110', ip: '192.168.58.4', os: 'ubuntu 22.04', taints: 0 },
  { name: 'gpu-node-1', status: 'NotReady', roles: 'worker,gpu', version: 'v1.31.2', cpu: '0.4 / 16', mem: '2.0 / 32Gi', pods: '6 / 110', ip: '192.168.58.5', os: 'ubuntu 22.04', taints: 1 },
];

const NS_SEEDS: Array<{ name: string; status: string; labels: number; age: string }> = [
  { name: 'default', status: 'Active', labels: 0, age: '16d' },
  { name: 'backend', status: 'Active', labels: 1, age: '30d' },
  { name: 'frontend', status: 'Active', labels: 1, age: '30d' },
  { name: 'monitoring', status: 'Active', labels: 0, age: '12d' },
  { name: 'logging', status: 'Terminating', labels: 0, age: '9d' },
  { name: 'kube-system', status: 'Active', labels: 0, age: '16d' },
];

/* ------------------------------------------------------------ */
/* YAML helpers                                                  */
/* ------------------------------------------------------------ */

let uidSeq = 1;
const uid = () => `00000000-0000-0000-0000-${String(uidSeq++).padStart(12, '0')}`;

const j = (lines: string[]) => lines.join('\n') + '\n';

const podYaml = (p: PodSeed) =>
  j([
    'apiVersion: v1',
    'kind: Pod',
    'metadata:',
    `  name: ${p.name}`,
    `  namespace: ${p.namespace}`,
    ...(Object.entries(p.labels).length ? ['  labels:'] : []),
    ...Object.entries(p.labels).map(([k, v]) => `    ${k}: ${v}`),
    'spec:',
    `  nodeSelector:`,
    `    kubernetes.io/hostname: ${JSON.stringify(p.node)}`,
    '  containers:',
    ...p.containers.flatMap((c) => [
      `  - name: ${c.name}`,
      `    image: ${c.image}`,
      '    ports:',
      `    - containerPort: ${c.port}`,
    ]),
    'status:',
    `  phase: ${p.status === 'Running' ? 'Running' : 'Pending'}`,
    `  podIP: ${JSON.stringify(p.ip)}`,
  ]);

/* ------------------------------------------------------------ */
/* Builder                                                       */
/* ------------------------------------------------------------ */

export function buildMockResources(): Record<ResourceKind, ResourceItem[]> {
  uidSeq = 1;
  const out = {} as Record<ResourceKind, ResourceItem[]>;

  out.Pod = POD_SEEDS.map(
    (p): ResourceItem => ({
      uid: uid(), name: p.name, namespace: p.namespace, kind: 'Pod', apiVersion: 'v1',
      status: p.status, ready: p.ready, restarts: p.restarts, node: p.node, ip: p.ip, age: p.age,
      labels: p.labels, containers: p.containers,
      rawYaml: podYaml(p),
    })
  );

  const kindMap: Record<string, ResourceKind> = {
    Deployment: 'Deployment', StatefulSet: 'StatefulSet', DaemonSet: 'DaemonSet', Job: 'Job', CronJob: 'CronJob',
  };
  for (const [seedKind, rows] of Object.entries(WORKLOAD_SEEDS)) {
    const kind = kindMap[seedKind];
    out[kind] = rows.map((r) => {
      const replicas = r.ready ? Number(r.ready.split('/')[1]) || 1 : 1;
      return {
        uid: uid(), name: r.name, namespace: r.namespace, kind, apiVersion: ['Job', 'CronJob'].includes(kind) ? 'batch/v1' : 'apps/v1',
        status: r.status, ready: seedKind === 'CronJob' ? undefined : r.ready, age: r.age, image: `ghcr.io/kubiki/${r.name}:latest`,
        replicas,
        rawYaml: j([
          `apiVersion: ${['Job', 'CronJob'].includes(kind) ? 'batch/v1' : 'apps/v1'}`,
          `kind: ${seedKind}`,
          'metadata:',
          `  name: ${r.name}`,
          `  namespace: ${r.namespace}`,
          'spec:',
          `  replicas: ${replicas}`,
          '  selector:',
          '    matchLabels:',
          `      app: ${r.name}`,
          '  template:',
          '    metadata:',
          '      labels:',
          `        app: ${r.name}`,
          '    spec:',
          '      containers:',
          '      - name: app',
          `        image: ghcr.io/kubiki/${r.name}:latest`,
        ]),
      } satisfies ResourceItem;
    });
  }

  out.Service = SERVICE_SEEDS.map(
    (s): ResourceItem => ({
      uid: uid(), name: s.name, namespace: s.namespace, kind: 'Service', apiVersion: 'v1',
      status: 'Active', ready: s.ports, age: s.age,
      serviceType: s.type, clusterIP: s.clusterIP,
      rawYaml: j([
        'apiVersion: v1',
        'kind: Service',
        'metadata:',
        `  name: ${s.name}`,
        `  namespace: ${s.namespace}`,
        'spec:',
        `  type: ${s.type}`,
        `  clusterIP: ${s.clusterIP}`,
        '  ports:',
        `  - port: ${s.ports.split(':')[0]}`,
        '    targetPort: 8080',
      ]),
    })
  );

  out.ConfigMap = CONFIG_SEEDS.ConfigMap.map(
    (c): ResourceItem => ({
      uid: uid(), name: c.name, namespace: c.namespace, kind: 'ConfigMap', apiVersion: 'v1',
      status: 'Active', ready: `${c.keys} keys`, age: c.age, dataKeys: c.keys,
      rawYaml: j([
        'apiVersion: v1',
        'kind: ConfigMap',
        'metadata:',
        `  name: ${c.name}`,
        `  namespace: ${c.namespace}`,
        'data:',
        '  app.yaml: |',
        '    log_level: info',
        '    replicas: 2',
      ]),
    })
  );

  out.Secret = CONFIG_SEEDS.Secret.map(
    (c): ResourceItem => ({
      uid: uid(), name: c.name, namespace: c.namespace, kind: 'Secret', apiVersion: 'v1',
      status: 'Active', ready: `${c.keys} keys`, age: c.age,
      secretType: 'Opaque', dataKeys: c.keys,
      rawYaml: j([
        'apiVersion: v1',
        'kind: Secret',
        'metadata:',
        `  name: ${c.name}`,
        `  namespace: ${c.namespace}`,
        'type: Opaque',
        'data:',
        '  password: c2VjcmV0LWRvLW5vdC1zaGFyZQ==',
      ]),
    })
  );

  out.PersistentVolumeClaim = PVC_SEEDS.map(
    (r): ResourceItem => ({
      uid: uid(), name: r.name, namespace: r.namespace, kind: 'PersistentVolumeClaim', apiVersion: 'v1',
      status: r.status, ready: r.capacity, age: r.age,
      volume: r.volume, storageClass: r.storageClass, accessModes: 'RWO',
      rawYaml: j([
        'apiVersion: v1',
        'kind: PersistentVolumeClaim',
        'metadata:',
        `  name: ${r.name}`,
        `  namespace: ${r.namespace}`,
        'spec:',
        `  storageClassName: ${r.storageClass}`,
        '  accessModes:',
        '  - ReadWriteOnce',
        '  resources:',
        '    requests:',
        `      storage: ${r.capacity}`,
      ]),
    })
  );

  out.PersistentVolume = PV_SEEDS.map(
    (r): ResourceItem => ({
      uid: uid(), name: r.name, namespace: undefined, kind: 'PersistentVolume', apiVersion: 'v1',
      status: r.status, ready: r.claim, age: r.age, volume: r.claim, storageClass: r.storageClass, reclaimPolicy: r.reclaim,
      rawYaml: j([
        'apiVersion: v1',
        'kind: PersistentVolume',
        'metadata:',
        `  name: ${r.name}`,
        'spec:',
        '  capacity:',
        `    storage: ${r.capacity}`,
        `  storageClassName: ${r.storageClass}`,
        `  persistentVolumeReclaimPolicy: ${r.reclaim}`,
      ]),
    })
  );

  out.StorageClass = SC_SEEDS.map(
    (r): ResourceItem => ({
      uid: uid(), name: r.name, namespace: undefined, kind: 'StorageClass', apiVersion: 'storage.k8s.io/v1',
      status: 'Active', ready: r.provisioner, age: r.age, reclaimPolicy: r.reclaim,
      rawYaml: j([
        'apiVersion: storage.k8s.io/v1',
        'kind: StorageClass',
        'metadata:',
        `  name: ${r.name}`,
        `provisioner: ${r.provisioner}`,
        `reclaimPolicy: ${r.reclaim}`,
        `volumeBindingMode: ${r.binding}`,
      ]),
    })
  );

  out.Node = NODE_SEEDS.map(
    (n): ResourceItem => ({
      uid: uid(), name: n.name, namespace: undefined, kind: 'Node', apiVersion: 'v1',
      status: n.status, ready: n.status, age: '16d',
      nodeRoles: n.roles, nodeVersion: n.version, nodeCpu: n.cpu, nodeMem: n.mem, nodePods: n.pods, nodeIp: n.ip, nodeOs: n.os,
      taintsCount: n.taints,
      rawYaml: j([
        'apiVersion: v1',
        'kind: Node',
        'metadata:',
        `  name: ${n.name}`,
        ...(n.taints > 0 ? [
          'spec:',
          '  taints:',
          '  - key: node-role.kubernetes.io/control-plane',
          '    effect: NoSchedule',
        ] : []),
        'status:',
        '  capacity:',
        `    cpu: "${n.cpu.split('/')[1].trim()}"`,
        `    memory: ${n.mem.split('/')[1].trim()}`,
        '  allocatable:',
        `    cpu: "${n.cpu.split('/')[1].trim()}"`,
        `    memory: ${n.mem.split('/')[1].trim()}`,
        '  addresses:',
        `  - address: ${n.ip}`,
        '    type: InternalIP',
        '  nodeInfo:',
        `    kubeletVersion: ${n.version}`,
        `    osImage: ${n.os}`,
      ]),
    })
  );

  out.Namespace = NS_SEEDS.map(
    (n): ResourceItem => ({
      uid: uid(), name: n.name, namespace: undefined, kind: 'Namespace', apiVersion: 'v1',
      status: n.status, ready: `${n.labels}`, age: n.age,
      rawYaml: j([
        'apiVersion: v1',
        'kind: Namespace',
        'metadata:',
        `  name: ${n.name}`,
      ]),
    })
  );

  out.Ingress = [
    {
      uid: uid(), name: 'main-web', namespace: 'frontend', kind: 'Ingress', apiVersion: 'networking.k8s.io/v1',
      status: 'Active', ready: 'app.kubiki.local', age: '8d',
      ingressHosts: 'app.kubiki.local, web.kubiki.local', ingressClass: 'traefik',
      rawYaml: j([
        'apiVersion: networking.k8s.io/v1',
        'kind: Ingress',
        'metadata:',
        '  name: main-web',
        '  namespace: frontend',
        'spec:',
        '  ingressClassName: traefik',
        '  rules:',
        '  - host: app.kubiki.local',
        '    http:',
        '      paths:',
        '      - path: /',
        '        backend:',
        '          service:',
        '            name: web-frontend',
        '            port:',
        '              number: 3000',
      ]),
    } satisfies ResourceItem,
  ];

  out.CustomResourceDefinition = [
    {
      uid: 'crd-bucket-1',
      name: 'buckets.source.toolkit.fluxcd.io',
      kind: 'CustomResourceDefinition',
      apiVersion: 'apiextensions.k8s.io/v1',
      status: 'Established',
      age: '14d',
      rawYaml: stringify({
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'buckets.source.toolkit.fluxcd.io', creationTimestamp: new Date(Date.now() - 86400000 * 14).toISOString() },
        spec: {
          group: 'source.toolkit.fluxcd.io',
          scope: 'Namespaced',
          names: { kind: 'Bucket', plural: 'buckets', singular: 'bucket', shortNames: ['bkt'] },
          versions: [
            {
              name: 'v1beta2',
              served: true,
              storage: true,
              additionalPrinterColumns: [
                { name: 'Endpoint', type: 'string', jsonPath: '.spec.endpoint' },
                { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
                { name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].status' },
                { name: 'Status', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].message' },
              ],
            },
          ],
        },
        status: { conditions: [{ type: 'Established', status: 'True' }] },
      }),
    } satisfies ResourceItem,
    {
      uid: 'crd-kustomization-1',
      name: 'kustomizations.kustomize.toolkit.fluxcd.io',
      kind: 'CustomResourceDefinition',
      apiVersion: 'apiextensions.k8s.io/v1',
      status: 'Established',
      age: '14d',
      rawYaml: stringify({
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'kustomizations.kustomize.toolkit.fluxcd.io', creationTimestamp: new Date(Date.now() - 86400000 * 14).toISOString() },
        spec: {
          group: 'kustomize.toolkit.fluxcd.io',
          scope: 'Namespaced',
          names: { kind: 'Kustomization', plural: 'kustomizations', singular: 'kustomization', shortNames: ['ks'] },
          versions: [
            {
              name: 'v1',
              served: true,
              storage: true,
              additionalPrinterColumns: [
                { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
                { name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].status' },
                { name: 'Status', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].message' },
              ],
            },
          ],
        },
        status: { conditions: [{ type: 'Established', status: 'True' }] },
      }),
    } satisfies ResourceItem,
  ];

  const all: ResourceKind[] = [
    'Pod','Deployment','ReplicaSet','StatefulSet','DaemonSet','Job','CronJob','Service','Ingress','ConfigMap','Secret',
    'PersistentVolumeClaim','PersistentVolume','StorageClass','Node','Namespace','Event','CustomResourceDefinition',
  ];
  for (const k of all) if (!out[k]) out[k] = [];
  for (const list of Object.values(out)) for (const item of list) {
    item.raw = parse(item.rawYaml ?? '') ?? {};
    item.raw!.metadata = { ...item.raw!.metadata, uid: item.uid };
    item.spec = item.raw!.spec;
    item.metadata = item.raw!.metadata;
  }
  for (const pod of out.Pod) {
    const workload = [...out.Deployment, ...out.StatefulSet, ...out.DaemonSet, ...out.Job].find((w) =>
      w.namespace === pod.namespace && pod.name.startsWith(w.name + '-'));
    if (!workload) continue;
    let owner = workload;
    if (workload.kind === 'Deployment') {
      const rsName = pod.name.slice(0, pod.name.lastIndexOf('-'));
      owner = out.ReplicaSet.find((r) => r.name === rsName && r.namespace === pod.namespace)!;
      if (!owner) {
        owner = { uid: uid(), kind: 'ReplicaSet', apiVersion: 'apps/v1', name: rsName, namespace: pod.namespace,
          raw: { apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: { name: rsName, namespace: pod.namespace,
            ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: workload.name, uid: workload.uid }] } } };
        out.ReplicaSet.push(owner);
      }
    }
    pod.raw!.metadata.ownerReferences = [{ apiVersion: owner.apiVersion, kind: owner.kind, name: owner.name, uid: owner.uid }];
    pod.raw!.spec.nodeName = pod.node === '-' ? undefined : pod.node;
  }
  for (const list of Object.values(out)) for (const item of list) item.rawYaml = stringify(item.raw);
  return out;
}

export { NODE_HOSTS };
