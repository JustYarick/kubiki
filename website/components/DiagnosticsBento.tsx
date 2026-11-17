import { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  Box,
  Boxes,
  Braces,
  ChevronRight,
  CircleDot,
  Copy,
  Cpu,
  ExternalLink,
  FileCode,
  FileText,
  Folder,
  GitBranch,
  HelpCircle,
  Layers,
  LayoutDashboard,
  Lock,
  MemoryStick,
  Network,
  Pause,
  Pin,
  Play,
  Radio,
  Rocket,
  RotateCw,
  Search,
  Server,
  ShieldAlert,
  ShieldBan,
  Terminal,
  Trash2,
  TriangleAlert,
} from 'lucide-react';

type ProblemSeverity = 'all' | 'error' | 'warning';
type LogFilter = 'all' | 'error' | 'warn' | 'info';
type InspectorTab = 'overview' | 'env' | 'related' | 'events' | 'yaml';
type DemoResourceId = 'pod-worker' | 'rs-worker' | 'deploy-worker' | 'node-2b' | 'cm-worker' | 'svc-metrics' | 'pod-analytics';

const KIND_STYLES: Record<string, { color: string; bg: string; border: string }> = {
  Pod: { color: '#b39aff', bg: 'rgba(179, 154, 255, 0.16)', border: 'rgba(179, 154, 255, 0.34)' },
  Deployment: { color: '#b39aff', bg: 'rgba(179, 154, 255, 0.16)', border: 'rgba(179, 154, 255, 0.34)' },
  ReplicaSet: { color: '#b39aff', bg: 'rgba(179, 154, 255, 0.16)', border: 'rgba(179, 154, 255, 0.34)' },
  ConfigMap: { color: '#56c8d8', bg: 'rgba(86, 200, 216, 0.16)', border: 'rgba(86, 200, 216, 0.34)' },
  Secret: { color: '#56c8d8', bg: 'rgba(86, 200, 216, 0.16)', border: 'rgba(86, 200, 216, 0.34)' },
  Service: { color: '#73daca', bg: 'rgba(115, 218, 202, 0.16)', border: 'rgba(115, 218, 202, 0.34)' },
  Node: { color: '#7e9fff', bg: 'rgba(126, 159, 255, 0.16)', border: 'rgba(126, 159, 255, 0.34)' },
  HelmRelease: { color: '#4ec9b0', bg: 'rgba(78, 201, 176, 0.16)', border: 'rgba(78, 201, 176, 0.34)' },
};

function MiniKindBadge({ kind }: { kind: string }) {
  const tone = KIND_STYLES[kind] ?? { color: '#9da0a8', bg: 'rgba(157, 160, 168, 0.16)', border: 'rgba(157, 160, 168, 0.34)' };
  return (
    <span
      className="kb-real-kind"
      style={{ color: tone.color, backgroundColor: tone.bg, borderColor: tone.border }}
    >
      {kind}
    </span>
  );
}

function ResourceKindGlyph({ kind }: { kind: string }) {
  const color = KIND_STYLES[kind]?.color ?? '#9da0a8';
  const props = { size: 15, style: { color, flexShrink: 0 }, 'aria-hidden': true as const };
  switch (kind) {
    case 'ReplicaSet':
      return <Copy {...props} />;
    case 'Deployment':
      return <Rocket {...props} />;
    case 'Node':
      return <Server {...props} />;
    case 'ConfigMap':
      return <FileCode {...props} />;
    case 'Service':
      return <Network {...props} />;
    default:
      return <CircleDot {...props} />;
  }
}

type DemoSummaryRow = {
  label: string;
  value: string;
  linkTo?: DemoResourceId;
  pill?: boolean;
};

type DemoRelatedItem = {
  dir: 'in' | 'out';
  kind: string;
  name: string;
  ns: string;
  rel: string;
  target?: DemoResourceId;
};

type DemoEventItem = {
  type: 'Warning' | 'Normal';
  reason: string;
  count: number;
  age: string;
  msg: string;
  reporter: string;
};

type DemoResource = {
  id: DemoResourceId;
  kind: string;
  name: string;
  ns?: string;
  owners?: { name: string; kind: string; target?: DemoResourceId }[];
  problem?: { title: string; desc: string; hint: string };
  summaryTitle: string;
  summary: DemoSummaryRow[];
  containers?: { name: string; image: string; state: string; restarts: number; cpu: string; ram: string }[];
  env?: { name: string; value: string; source: string; target?: DemoResourceId; secret?: boolean; drifted?: boolean }[];
  related: DemoRelatedItem[];
  events: DemoEventItem[];
  yaml: string;
};

const DEMO_RESOURCES: Record<DemoResourceId, DemoResource> = {
  'pod-worker': {
    id: 'pod-worker',
    kind: 'Pod',
    name: 'payment-worker-67f98b984-pv4n8',
    ns: 'backend',
    owners: [
      { kind: 'ReplicaSet', name: 'payment-worker-67f98b984', target: 'rs-worker' },
      { kind: 'Deployment', name: 'payment-worker', target: 'deploy-worker' },
    ],
    problem: {
      title: 'OOMKilled (Exit Code 137) · Container “worker”',
      desc: 'The process was killed by Linux OOM killer because memory consumption exceeded the defined container limit.',
      hint: 'Increase “resources.limits.memory” in your Deployment spec.',
    },
    summaryTitle: 'Pod summary',
    summary: [
      { label: 'Node', value: 'node-2b', linkTo: 'node-2b' },
      { label: 'QoS Class', value: 'Burstable', pill: true },
      { label: 'Controlled by', value: 'ReplicaSet/payment-worker-67f98b984', linkTo: 'rs-worker' },
      { label: 'Pod IP', value: '10.42.0.21' },
      { label: 'Service account', value: 'payment-worker' },
    ],
    containers: [
      {
        name: 'worker',
        image: 'ghcr.io/acme/payment-worker:v2.4.1',
        state: 'CrashLoopBackOff',
        restarts: 6,
        cpu: '84m',
        ram: '241 MiB',
      },
    ],
    env: [
      { name: 'APP_ENV', value: 'production', source: 'Direct value' },
      { name: 'BATCH_MEMORY_MB', value: '512', source: 'ConfigMap/worker-config', target: 'cm-worker', drifted: true },
      { name: 'STRIPE_API_KEY', value: '••••••••••••', source: 'Secret/payments-secrets', secret: true },
    ],
    related: [
      { dir: 'in', kind: 'Deployment', name: 'payment-worker', ns: 'backend', rel: 'root controller', target: 'deploy-worker' },
      { dir: 'in', kind: 'ReplicaSet', name: 'payment-worker-67f98b984', ns: 'backend', rel: 'owns', target: 'rs-worker' },
      { dir: 'in', kind: 'Service', name: 'payment-worker-metrics', ns: 'backend', rel: 'selects', target: 'svc-metrics' },
      { dir: 'out', kind: 'ConfigMap', name: 'worker-config', ns: 'backend', rel: 'envFrom', target: 'cm-worker' },
      { dir: 'out', kind: 'Secret', name: 'payments-secrets', ns: 'backend', rel: 'valueFrom' },
      { dir: 'out', kind: 'Node', name: 'node-2b', ns: 'cluster', rel: 'scheduled on', target: 'node-2b' },
    ],
    events: [
      { type: 'Warning', reason: 'OOMKilling', count: 6, age: '2m', reporter: 'kubelet, node-2b', msg: 'Memory cgroup out of memory: Killed process worker (exit 137)' },
      { type: 'Warning', reason: 'BackOff', count: 14, age: '1m', reporter: 'kubelet, node-2b', msg: 'Back-off restarting failed container worker in pod payment-worker' },
      { type: 'Normal', reason: 'Scheduled', count: 1, age: '4m', reporter: 'default-scheduler', msg: 'Successfully assigned backend/payment-worker-67f98b984-pv4n8 to node-2b' },
    ],
    yaml: `kind: Pod\nmetadata:\n  name: payment-worker-67f98b984-pv4n8\n  namespace: backend\nspec:\n  nodeName: node-2b\n  containers:\n    - name: worker\n      resources:\n        limits:\n          memory: 256Mi`,
  },
  'rs-worker': {
    id: 'rs-worker',
    kind: 'ReplicaSet',
    name: 'payment-worker-67f98b984',
    ns: 'backend',
    owners: [{ kind: 'Deployment', name: 'payment-worker', target: 'deploy-worker' }],
    summaryTitle: 'Workload summary',
    summary: [
      { label: 'Replicas', value: '2 / 3 ready' },
      { label: 'Controlled by', value: 'Deployment/payment-worker', linkTo: 'deploy-worker' },
      { label: 'Pod template', value: 'ghcr.io/acme/payment-worker:v2.4.1' },
      { label: 'Selector', value: 'app=payment-worker' },
    ],
    related: [
      { dir: 'in', kind: 'Deployment', name: 'payment-worker', ns: 'backend', rel: 'owns', target: 'deploy-worker' },
      { dir: 'out', kind: 'Pod', name: 'payment-worker-67f98b984-pv4n8', ns: 'backend', rel: 'manages', target: 'pod-worker' },
      { dir: 'out', kind: 'ConfigMap', name: 'worker-config', ns: 'backend', rel: 'references', target: 'cm-worker' },
    ],
    events: [
      { type: 'Normal', reason: 'SuccessfulCreate', count: 3, age: '18m', reporter: 'replicaset-controller', msg: 'Created pod: payment-worker-67f98b984-pv4n8' },
    ],
    yaml: `kind: ReplicaSet\nmetadata:\n  name: payment-worker-67f98b984\n  namespace: backend\nspec:\n  replicas: 3\nstatus:\n  readyReplicas: 2`,
  },
  'deploy-worker': {
    id: 'deploy-worker',
    kind: 'Deployment',
    name: 'payment-worker',
    ns: 'backend',
    summaryTitle: 'Deployment summary',
    summary: [
      { label: 'Ready replicas', value: '2 / 3 ready' },
      { label: 'Strategy', value: 'RollingUpdate (25% maxSurge)', pill: true },
      { label: 'Active ReplicaSet', value: 'payment-worker-67f98b984', linkTo: 'rs-worker' },
      { label: 'Config', value: 'ConfigMap/worker-config', linkTo: 'cm-worker' },
    ],
    related: [
      { dir: 'out', kind: 'ReplicaSet', name: 'payment-worker-67f98b984', ns: 'backend', rel: 'owns', target: 'rs-worker' },
      { dir: 'out', kind: 'Pod', name: 'payment-worker-67f98b984-pv4n8', ns: 'backend', rel: 'manages', target: 'pod-worker' },
      { dir: 'in', kind: 'Service', name: 'payment-worker-metrics', ns: 'backend', rel: 'exposes', target: 'svc-metrics' },
    ],
    events: [
      { type: 'Normal', reason: 'ScalingReplicaSet', count: 1, age: '18m', reporter: 'deployment-controller', msg: 'Scaled up replica set payment-worker-67f98b984 to 3' },
    ],
    yaml: `kind: Deployment\nmetadata:\n  name: payment-worker\n  namespace: backend\nspec:\n  replicas: 3`,
  },
  'node-2b': {
    id: 'node-2b',
    kind: 'Node',
    name: 'node-2b',
    summaryTitle: 'Node summary',
    summary: [
      { label: 'Status', value: 'Ready', pill: true },
      { label: 'CPU usage', value: '14.2 / 32 cores (44%)' },
      { label: 'RAM usage', value: '48.6 / 128 GiB (38%)' },
      { label: 'Running Pods', value: 'payment-worker-67f98b984-pv4n8', linkTo: 'pod-worker' },
      { label: 'Kubelet', value: 'v1.31.2 · containerd 1.7' },
    ],
    related: [
      { dir: 'in', kind: 'Pod', name: 'payment-worker-67f98b984-pv4n8', ns: 'backend', rel: 'scheduled here', target: 'pod-worker' },
      { dir: 'in', kind: 'Pod', name: 'analytics-dispatcher-7f9c97d-88943', ns: 'analytics-staging', rel: 'scheduled here', target: 'pod-analytics' },
    ],
    events: [
      { type: 'Warning', reason: 'OOMKilling', count: 6, age: '2m', reporter: 'kernel-monitor, node-2b', msg: 'Memory cgroup out of memory on container worker' },
      { type: 'Normal', reason: 'NodeReady', count: 1, age: '14d', reporter: 'kubelet, node-2b', msg: 'Node node-2b status is now: NodeReady' },
    ],
    yaml: `kind: Node\nmetadata:\n  name: node-2b\nstatus:\n  capacity:\n    cpu: "32"\n    memory: 128Gi`,
  },
  'cm-worker': {
    id: 'cm-worker',
    kind: 'ConfigMap',
    name: 'worker-config',
    ns: 'backend',
    problem: {
      title: 'Configuration drift detected',
      desc: 'ConfigMap keys were updated after Pod payment-worker-67f98b984-pv4n8 started.',
      hint: 'Restart Deployment/payment-worker to roll in updated env values.',
    },
    summaryTitle: 'ConfigMap summary',
    summary: [
      { label: 'Keys', value: '3 entries (BATCH_MEMORY_MB, QUEUE_NAME, LOG_LEVEL)' },
      { label: 'Mounted by', value: 'Pod/payment-worker-67f98b984-pv4n8', linkTo: 'pod-worker' },
      { label: 'Controller', value: 'Deployment/payment-worker', linkTo: 'deploy-worker' },
    ],
    related: [
      { dir: 'in', kind: 'Pod', name: 'payment-worker-67f98b984-pv4n8', ns: 'backend', rel: 'mounted by', target: 'pod-worker' },
      { dir: 'in', kind: 'Deployment', name: 'payment-worker', ns: 'backend', rel: 'referenced by', target: 'deploy-worker' },
    ],
    events: [],
    yaml: `kind: ConfigMap\nmetadata:\n  name: worker-config\n  namespace: backend\ndata:\n  BATCH_MEMORY_MB: "512"\n  QUEUE_NAME: pay`,
  },
  'svc-metrics': {
    id: 'svc-metrics',
    kind: 'Service',
    name: 'payment-worker-metrics',
    ns: 'backend',
    summaryTitle: 'Service summary',
    summary: [
      { label: 'Type', value: 'ClusterIP', pill: true },
      { label: 'Cluster IP', value: '10.96.18.42' },
      { label: 'Ports', value: '9090/TCP → metrics' },
      { label: 'Backend Pod', value: 'payment-worker-67f98b984-pv4n8', linkTo: 'pod-worker' },
    ],
    related: [
      { dir: 'out', kind: 'Pod', name: 'payment-worker-67f98b984-pv4n8', ns: 'backend', rel: 'endpoints (1/3)', target: 'pod-worker' },
      { dir: 'out', kind: 'Deployment', name: 'payment-worker', ns: 'backend', rel: 'targets', target: 'deploy-worker' },
    ],
    events: [],
    yaml: `kind: Service\nmetadata:\n  name: payment-worker-metrics\n  namespace: backend\nspec:\n  type: ClusterIP\n  ports:\n    - port: 9090`,
  },
  'pod-analytics': {
    id: 'pod-analytics',
    kind: 'Pod',
    name: 'analytics-dispatcher-7f9c97d-88943',
    ns: 'analytics-staging',
    problem: {
      title: 'ImagePullBackOff · Container “app”',
      desc: 'Container image pull failed due to missing registry pull secret in analytics-staging.',
      hint: 'Verify imagePullSecrets on ServiceAccount or Pod spec.',
    },
    summaryTitle: 'Pod summary',
    summary: [
      { label: 'Node', value: 'node-2b', linkTo: 'node-2b' },
      { label: 'QoS Class', value: 'Burstable', pill: true },
      { label: 'Pod IP', value: 'Pending' },
    ],
    containers: [
      {
        name: 'app',
        image: 'ghcr.io/acme/analytics-dispatcher:staging',
        state: 'ImagePullBackOff',
        restarts: 0,
        cpu: '—',
        ram: '—',
      },
    ],
    env: [
      { name: 'STAGE', value: 'staging', source: 'Direct value' },
    ],
    related: [
      { dir: 'out', kind: 'Node', name: 'node-2b', ns: 'cluster', rel: 'scheduled on', target: 'node-2b' },
    ],
    events: [
      { type: 'Warning', reason: 'Failed', count: 4, age: '3m', reporter: 'kubelet, node-2b', msg: 'Failed to pull image: unauthorized' },
    ],
    yaml: `kind: Pod\nmetadata:\n  name: analytics-dispatcher-7f9c97d-88943\n  namespace: analytics-staging`,
  },
};

const PROBLEMS_DATA = [
  {
    id: 'p1',
    severity: 'error' as const,
    kind: 'Pod',
    name: 'payment-worker-67f98b984-pv4n8',
    ns: 'backend',
    summary: 'Container worker: CrashLoopBackOff',
    message: 'Last termination OOMKilled (exitCode 137) · 6 restarts',
    target: 'pod-worker' as DemoResourceId,
  },
  {
    id: 'p2',
    severity: 'error' as const,
    kind: 'Pod',
    name: 'analytics-dispatcher-7f9c97d-88943',
    ns: 'analytics-staging',
    summary: 'Container app: ImagePullBackOff',
    message: 'Waiting for container startup',
    target: 'pod-analytics' as DemoResourceId,
  },
  {
    id: 'p3',
    severity: 'warning' as const,
    kind: 'Deployment',
    name: 'payment-worker',
    ns: 'backend',
    summary: '2/3 replicas are ready',
    message: 'Some desired replicas are not ready. Check related Pods.',
    target: 'deploy-worker' as DemoResourceId,
  },
  {
    id: 'p4',
    severity: 'warning' as const,
    kind: 'ConfigMap',
    name: 'worker-config',
    ns: 'backend',
    summary: 'Configuration drift detected',
    message: 'Updated after Pod payment-worker-67f98b984-pv4n8 started.',
    target: 'cm-worker' as DemoResourceId,
  },
];

type LogEntry = {
  seq: number;
  t: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
  fields: [string, string][];
};

const SEED_LOGS: LogEntry[] = [
  { seq: 1, t: '09:41:01', level: 'info', msg: 'Worker started', fields: [['pool', '8'], ['queue', 'pay']] },
  { seq: 2, t: '09:41:02', level: 'info', msg: 'Redis connected', fields: [['host', 'redis:6379']] },
  { seq: 3, t: '09:41:03', level: 'info', msg: 'Batch consumed', fields: [['id', '48192'], ['items', '128']] },
  { seq: 4, t: '09:41:04', level: 'warn', msg: 'Heap near ceiling', fields: [['used', '241Mi'], ['max', '256Mi']] },
  { seq: 5, t: '09:41:04', level: 'error', msg: 'Cgroup OOMKilled', fields: [['code', '137'], ['pid', '1']] },
  { seq: 6, t: '09:41:06', level: 'warn', msg: 'Container backoff', fields: [['restarts', '6'], ['wait', '20s']] },
  { seq: 7, t: '09:41:07', level: 'info', msg: 'GET /healthz', fields: [['status', '200'], ['ms', '1.4']] },
  { seq: 8, t: '09:41:08', level: 'info', msg: 'GET /readyz', fields: [['status', '200'], ['ms', '0.8']] },
  { seq: 9, t: '09:41:09', level: 'warn', msg: 'Probe slow', fields: [['p99', '184ms']] },
];

const EXTRA_LOGS: Omit<LogEntry, 'seq'>[] = [
  { t: '09:41:09', level: 'info', msg: 'GET /healthz completed', fields: [['status', '200'], ['ms', '1.4']] },
  { t: '09:41:11', level: 'warn', msg: 'Readiness probe failed', fields: [['container', 'worker'], ['attempt', '3']] },
  { t: '09:41:13', level: 'error', msg: 'Container terminated with SIGKILL', fields: [['reason', 'OOMKilled'], ['code', '137']] },
];

const POD_PHASES = [
  { label: 'Running', value: 8236, pct: 97, color: '#59a869' },
  { label: 'Pending', value: 57, pct: 1, color: '#60a5fa' },
  { label: 'Succeeded', value: 162, pct: 2, color: '#9da0a8' },
  { label: 'Failed', value: 6, pct: 0, color: '#e05555' },
  { label: 'Terminating', value: 15, pct: 0, color: '#e5b742' },
];

const CPU_POINTS = [
  { t: '-8m', v: '2,240 cores' },
  { t: '-6m', v: '2,410 cores' },
  { t: '-4m', v: '2,315 cores' },
  { t: '-2m', v: '2,590 cores' },
  { t: 'now', v: '2,665.18 cores' },
];

export function DiagnosticsBento() {
  const [cpuHover, setCpuHover] = useState<number | null>(null);
  const [problemFilter, setProblemFilter] = useState<ProblemSeverity>('all');
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [structuredLogs, setStructuredLogs] = useState(true);
  const [streaming, setStreaming] = useState(true);
  const [logs, setLogs] = useState<LogEntry[]>(SEED_LOGS);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('overview');
  const [activeResId, setActiveResId] = useState<DemoResourceId>('pod-worker');
  const [history, setHistory] = useState<DemoResourceId[]>([]);
  const [pinned, setPinned] = useState(false);
  const [relatedQuery, setRelatedQuery] = useState('');

  useEffect(() => {
    if (!streaming) return;
    let i = 0;
    const id = window.setInterval(() => {
      const next = EXTRA_LOGS[i % EXTRA_LOGS.length];
      i += 1;
      setLogs(prev => [...prev.slice(-8), { ...next, seq: Date.now() + i }]);
    }, 2600);
    return () => window.clearInterval(id);
  }, [streaming]);

  const activeRes = DEMO_RESOURCES[activeResId];

  const openResource = (nextId: DemoResourceId) => {
    if (nextId === activeResId) return;
    setHistory(prev => [...prev, activeResId]);
    setActiveResId(nextId);
    setInspectorTab('overview');
    setRelatedQuery('');
  };

  const goBack = () => {
    if (!history.length) return;
    const prevId = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    setActiveResId(prevId);
    setInspectorTab('overview');
    setRelatedQuery('');
  };

  const availableTabs: { id: InspectorTab; label: string }[] =
    activeRes.kind === 'Pod'
      ? [
          { id: 'overview', label: 'Overview' },
          { id: 'env', label: 'Environment' },
          { id: 'related', label: 'Related' },
          { id: 'events', label: 'Events' },
          { id: 'yaml', label: 'YAML' },
        ]
      : [
          { id: 'overview', label: 'Overview' },
          { id: 'related', label: 'Related' },
          { id: 'events', label: 'Events' },
          { id: 'yaml', label: 'YAML' },
        ];

  const filteredRelated = activeRes.related.filter(entry =>
    `${entry.name} ${entry.kind} ${entry.ns} ${entry.rel}`.toLowerCase().includes(relatedQuery.trim().toLowerCase()),
  );

  const filteredProblems = PROBLEMS_DATA.filter(p => problemFilter === 'all' || p.severity === problemFilter);
  const filteredLogs = logFilter === 'all' ? logs : logs.filter(l => l.level === logFilter);

  return (
    <section className="kb-section kb-section-glow-tl" id="diagnostics">
      <div className="kb-container">
        <div className="kb-split-head">
          <h2>Start inspecting in under a minute</h2>
          <p>
            Point Kubiki at your local kubeconfig and open a high-density IDE workspace over Pods, nodes, events, container logs and object relationships—no cluster agent or local kubectl binary required.
          </p>
        </div>

        <div className="kb-bento">
          {/* Card 1 (2 cols): Authentic Kubiki OverviewView (Summary + Compute & memory + Pod distribution) */}
          <article className="kb-bento-card kb-col-2">
            <div className="kb-bento-app-body kb-real-overview">
              {/* Real .overview-summary 5-column metric strip */}
              <div className="kb-ov-summary">
                <div className="kb-ov-metric">
                  <div className="kb-ov-mlabel"><Boxes size={12} /><span>Pods</span></div>
                  <div className="kb-ov-mval">8,476</div>
                  <div className="kb-ov-mdetail">8236 running · 57 pending</div>
                </div>
                <div className="kb-ov-metric">
                  <div className="kb-ov-mlabel"><Layers size={12} /><span>Workload controllers</span></div>
                  <div className="kb-ov-mval">1,101</div>
                  <div className="kb-ov-mdetail">Deployments, jobs &amp; controllers</div>
                </div>
                <div className="kb-ov-metric">
                  <div className="kb-ov-mlabel"><Network size={12} /><span>Services</span></div>
                  <div className="kb-ov-mval">727</div>
                  <div className="kb-ov-mdetail">In the selected scope</div>
                </div>
                <div className="kb-ov-metric">
                  <div className="kb-ov-mlabel"><Server size={12} /><span>Nodes</span></div>
                  <div className="kb-ov-mval">184</div>
                  <div className="kb-ov-mdetail">181 ready</div>
                </div>
                <div className="kb-ov-metric">
                  <div className="kb-ov-mlabel"><Folder size={12} /><span>Namespaces</span></div>
                  <div className="kb-ov-mval">70</div>
                  <div className="kb-ov-mdetail">Loaded namespaces</div>
                </div>
              </div>

              {/* Real Compute & memory + Pod distribution row */}
              <div className="kb-ov-lower">
                <div className="kb-ov-card">
                  <div className="kb-ov-card-head">
                    <div>
                      <strong>Compute &amp; memory</strong>
                      <span>Node usage · 184/184 nodes measured</span>
                    </div>
                    <span className="kb-ov-select">Last 15 min</span>
                  </div>

                  <div className="kb-ov-metrics-split">
                    <div
                      className="kb-tel-metric"
                      onMouseLeave={() => setCpuHover(null)}
                    >
                      <div className="kb-tel-head">
                        <span className="kb-tel-label cpu"><Cpu size={12} />CPU</span>
                        <span className="kb-tel-util">46.7% of allocatable</span>
                      </div>
                      <div className="kb-tel-val">
                        {cpuHover !== null ? CPU_POINTS[cpuHover].v : '2665.18 cores'}
                      </div>
                      <div className="kb-tel-track"><span style={{ width: '46.7%', background: '#7e9fff' }} /></div>
                      <div className="kb-tel-chart-wrap">
                        <svg viewBox="0 0 260 66" fill="none" className="kb-tel-svg">
                          <defs>
                            <linearGradient id="kbCpuArea" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#7e9fff" stopOpacity="0.18" />
                              <stop offset="100%" stopColor="#7e9fff" stopOpacity="0" />
                            </linearGradient>
                          </defs>
                          <line x1="0" y1="58" x2="260" y2="58" stroke="#282b33" strokeWidth="0.8" />
                          <path d="M4,42 L58,32 L118,38 L178,24 L256,18 L256,58 L4,58 Z" fill="url(#kbCpuArea)" />
                          <path d="M4,42 L58,32 L118,38 L178,24 L256,18" stroke="#7e9fff" strokeWidth="1.8" strokeLinecap="round" />
                          {[[4, 42], [58, 32], [118, 38], [178, 24], [256, 18]].map(([cx, cy], idx) => (
                            <g key={idx} onMouseEnter={() => setCpuHover(idx)} style={{ cursor: 'pointer' }}>
                              <circle cx={cx} cy={cy} r="10" fill="transparent" />
                              {cpuHover === idx && (
                                <circle cx={cx} cy={cy} r="3.5" fill="#7e9fff" stroke="#1e1f22" strokeWidth="1.5" />
                              )}
                            </g>
                          ))}
                        </svg>
                        <div className="kb-tel-times">
                          <span>-8.8m</span>
                          <span>{cpuHover !== null ? CPU_POINTS[cpuHover].t : '01:44 AM'}</span>
                        </div>
                      </div>
                    </div>

                    <div className="kb-tel-metric">
                      <div className="kb-tel-head">
                        <span className="kb-tel-label ram"><MemoryStick size={12} />RAM</span>
                        <span className="kb-tel-util">7.7% of allocatable</span>
                      </div>
                      <div className="kb-tel-val">1.63 TiB</div>
                      <div className="kb-tel-track"><span style={{ width: '7.7%', background: '#b39aff' }} /></div>
                      <div className="kb-tel-chart-wrap">
                        <svg viewBox="0 0 260 66" fill="none" className="kb-tel-svg">
                          <defs>
                            <linearGradient id="kbRamArea" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#b39aff" stopOpacity="0.18" />
                              <stop offset="100%" stopColor="#b39aff" stopOpacity="0" />
                            </linearGradient>
                          </defs>
                          <line x1="0" y1="58" x2="260" y2="58" stroke="#282b33" strokeWidth="0.8" />
                          <path d="M4,46 L66,43 L132,40 L196,39 L256,37 L256,58 L4,58 Z" fill="url(#kbRamArea)" />
                          <path d="M4,46 L66,43 L132,40 L196,39 L256,37" stroke="#b39aff" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>
                        <div className="kb-tel-times">
                          <span>-8.8m</span>
                          <span>01:44 AM</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Real PodDistribution Donut Card */}
                <div className="kb-ov-card kb-ov-donut-card">
                  <div className="kb-ov-card-head">
                    <div>
                      <strong>Pod distribution</strong>
                      <span>Current lifecycle phases</span>
                    </div>
                  </div>
                  <div className="kb-ov-donut-body">
                    <svg viewBox="0 0 140 140" className="kb-ov-donut-svg" aria-label="8,476 total Pods">
                      <circle cx="70" cy="70" r="52" fill="none" stroke="#262830" strokeWidth="12" />
                      <circle
                        cx="70" cy="70" r="52" pathLength="100" fill="none"
                        stroke="#59a869" strokeWidth="12" strokeDasharray="96.8 3.2"
                        transform="rotate(-90 70 70)"
                      />
                      <circle
                        cx="70" cy="70" r="52" pathLength="100" fill="none"
                        stroke="#60a5fa" strokeWidth="12" strokeDasharray="1.2 98.8" strokeDashoffset="-96.8"
                        transform="rotate(-90 70 70)"
                      />
                      <circle
                        cx="70" cy="70" r="52" pathLength="100" fill="none"
                        stroke="#9da0a8" strokeWidth="12" strokeDasharray="2 98" strokeDashoffset="-98"
                        transform="rotate(-90 70 70)"
                      />
                      <text x="70" y="69" textAnchor="middle" className="kb-donut-count">8,476</text>
                      <text x="70" y="86" textAnchor="middle" className="kb-donut-label">total Pods</text>
                    </svg>
                    <dl className="kb-ov-phases">
                      {POD_PHASES.map(p => (
                        <div key={p.label}>
                          <span className="kb-phase-dot" style={{ background: p.color }} />
                          <dt>{p.label}</dt>
                          <dd>{p.value.toLocaleString()}</dd>
                          <em>{p.pct}%</em>
                        </div>
                      ))}
                    </dl>
                  </div>
                </div>
              </div>
            </div>

            <div className="kb-bento-foot">
              <div className="kb-bento-title">
                <LayoutDashboard size={16} className="kb-icon-blue" />
                <h3>Cluster overview at a glance</h3>
              </div>
              <p>
                Summary counts, live CPU &amp; RAM telemetry history and Pod phase distribution in one coherent overview pane.
              </p>
            </div>
          </article>

          {/* Card 2 (1 col): Authentic Kubiki OverviewProblems widget */}
          <article className="kb-bento-card kb-col-1">
            <div className="kb-bento-app-body kb-real-problems">
              <div className="kb-ov-card kb-problems-card">
                <div className="kb-ov-card-head">
                  <div className="kb-prob-title">
                    <TriangleAlert size={14} className="kb-prob-tri" />
                    <strong>Problems</strong>
                    <span>278</span>
                  </div>
                  <div className="kb-prob-filters" role="group" aria-label="Filter cluster problems">
                    <button
                      type="button"
                      aria-pressed={problemFilter === 'all'}
                      onClick={() => setProblemFilter('all')}
                    >
                      All <em>278</em>
                    </button>
                    <button
                      type="button"
                      className="crit"
                      aria-pressed={problemFilter === 'error'}
                      onClick={() => setProblemFilter('error')}
                    >
                      Critical <em>69</em>
                    </button>
                    <button
                      type="button"
                      className="warn"
                      aria-pressed={problemFilter === 'warning'}
                      onClick={() => setProblemFilter('warning')}
                    >
                      Warning <em>209</em>
                    </button>
                  </div>
                </div>

                <div className="kb-prob-events-note">Warning Events: 119</div>

                <div className="kb-prob-list">
                  {filteredProblems.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      className={activeResId === item.target ? 'kb-prob-row active' : 'kb-prob-row'}
                      onClick={() => openResource(item.target)}
                    >
                      <div className="kb-prob-row-top">
                        <span className={item.severity === 'error' ? 'kb-sev-crit' : 'kb-sev-warn'}>
                          {item.severity === 'error' ? 'Critical' : 'Warning'}
                        </span>
                        <MiniKindBadge kind={item.kind} />
                        <span className="kb-prob-name">{item.name}</span>
                      </div>
                      <p className="kb-prob-sub">{item.ns} · {item.summary}</p>
                      <p className="kb-prob-msg">{item.message}</p>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="kb-bento-foot">
              <div className="kb-bento-title">
                <TriangleAlert size={16} className="kb-icon-warn" />
                <h3>Problems surfaced with severity</h3>
              </div>
              <p>
                Filter critical container failures from warning events and click any resource to open its inspector.
              </p>
            </div>
          </article>

          {/* Card 3 (1 col): Authentic Kubiki LogsSessionPane (3px left strip + structured JSON fields) */}
          <article className="kb-bento-card kb-col-1">
            <div className="kb-bento-app-body kb-real-logs">
              <div className="kb-logs-meta">Simulated logs · poll every 5s · container: worker</div>
              <div className="kb-logs-bar">
                <div className="kb-logs-filter-pills">
                  {(['all', 'error', 'warn', 'info'] as LogFilter[]).map(f => (
                    <button
                      key={f}
                      type="button"
                      className={logFilter === f ? 'active' : ''}
                      onClick={() => setLogFilter(f)}
                    >
                      {f.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div className="kb-logs-actions">
                  <button
                    type="button"
                    className={structuredLogs ? 'active' : ''}
                    onClick={() => setStructuredLogs(s => !s)}
                    title="Parse structured JSON fields"
                  >
                    <Braces size={11} />
                    <span>JSON</span>
                  </button>
                  <button
                    type="button"
                    aria-label={streaming ? 'Pause logs' : 'Resume logs'}
                    onClick={() => setStreaming(s => !s)}
                  >
                    {streaming ? <Pause size={11} /> : <Play size={11} />}
                  </button>
                </div>
              </div>

              <div className="kb-real-log-output">
                {filteredLogs.map(line => (
                  <div key={line.seq} className={`kb-real-log-line lvl-${line.level}`}>
                    <time>{line.t}</time>
                    <span className="kb-real-log-msg">{line.msg}</span>
                    {structuredLogs && (
                      <span className="kb-log-fields">
                        {line.fields.map(([k, v]) => (
                          <span key={k} className="kb-log-kv">
                            <em>{k}=</em>
                            <b>{v}</b>
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="kb-bento-foot">
              <div className="kb-bento-title">
                <FileText size={16} className="kb-icon-blue" />
                <h3>Detailed logs in the bottom dock</h3>
              </div>
              <p>
                Stream container logs with Grafana-style severity strips, regex search and structured JSON field parsing.
              </p>
            </div>
          </article>

          {/* Card 4 (2 cols): Authentic Kubiki DetailsPanel + ResourceHeader + Navigable Linked Resources */}
          <article className="kb-bento-card kb-col-2">
            <div className="kb-bento-app-body kb-real-inspector">
              {/* ResourceHeader matching src/components/k8s/details/ResourceHeader.tsx */}
              <div className="kb-insp-header">
                <div className="kb-insp-identity">
                  <button
                    type="button"
                    className={history.length ? 'kb-insp-back' : 'kb-insp-back empty'}
                    onClick={goBack}
                    disabled={!history.length}
                    aria-label="Back to previous resource"
                    title={history.length ? `Back to ${DEMO_RESOURCES[history[history.length - 1]].name}` : 'Back (history)'}
                  >
                    <ArrowLeft size={12} />
                  </button>

                  <ResourceKindGlyph kind={activeRes.kind} />

                  <div className="kb-insp-main">
                    <div className="kb-insp-title">{activeRes.name}</div>
                    <div className="kb-insp-subtitle">
                      <span>{activeRes.kind} · {activeRes.ns || 'Cluster scoped'}</span>
                      {activeRes.owners?.map(crumb => (
                        <span key={crumb.name} className="kb-insp-crumb-wrap">
                          <ChevronRight size={10} />
                          {crumb.target ? (
                            <button
                              type="button"
                              className="kb-insp-crumb-link"
                              onClick={() => openResource(crumb.target!)}
                            >
                              {crumb.name}
                            </button>
                          ) : (
                            <span>{crumb.name}</span>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="kb-insp-tools" aria-hidden="true">
                    <span><Copy size={12} /></span>
                    <button
                      type="button"
                      className={pinned ? 'active' : ''}
                      onClick={() => setPinned(p => !p)}
                      aria-label="Pin details"
                      aria-pressed={pinned}
                    >
                      <Pin size={12} />
                    </button>
                    <span><ExternalLink size={12} /></span>
                    <span className="danger"><Trash2 size={12} /></span>
                  </div>
                </div>

                <div className="kb-insp-actions">
                  {['Pod', 'Deployment', 'ReplicaSet'].includes(activeRes.kind) && (
                    <span><FileText size={11} />Logs</span>
                  )}
                  {['Pod', 'Node'].includes(activeRes.kind) && (
                    <span><Terminal size={11} />{activeRes.kind === 'Node' ? 'Node shell' : 'Shell'}</span>
                  )}
                  {activeRes.kind === 'Pod' && (
                    <span><Radio size={11} />Attach</span>
                  )}
                  {activeRes.kind === 'Deployment' && (
                    <span><RotateCw size={11} />Restart</span>
                  )}
                  {activeRes.kind === 'Node' && (
                    <>
                      <span><ShieldBan size={11} />Cordon</span>
                      <span><ShieldAlert size={11} />Drain</span>
                    </>
                  )}
                  {['Pod', 'Service'].includes(activeRes.kind) && (
                    <span><ArrowRightLeft size={11} />Ports</span>
                  )}
                  <span><GitBranch size={11} />Topology</span>
                </div>

                <div className="kb-insp-tabs" role="tablist" aria-label="Resource inspector tabs">
                  {availableTabs.map(t => (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={inspectorTab === t.id}
                      onClick={() => setInspectorTab(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="kb-insp-scroll">
                {inspectorTab === 'overview' && (
                  <div className="kb-details-stack">
                    {activeRes.problem && (
                      <div className="kb-problems-banner">
                        <div className="kb-pb-head">
                          <AlertCircle size={13} />
                          <span>WHAT’S WRONG · 1 ISSUE DETECTED</span>
                        </div>
                        <div className="kb-pb-title">{activeRes.problem.title}</div>
                        <p className="kb-pb-desc">{activeRes.problem.desc}</p>
                        <div className="kb-pb-hint">
                          <HelpCircle size={12} />
                          <span>{activeRes.problem.hint}</span>
                        </div>
                        <div className="kb-pb-foot">
                          <span className="kb-pb-btn">Investigate with AI</span>
                        </div>
                      </div>
                    )}

                    <div className="kb-details-sec">
                      <div className="kb-details-sec-head">{activeRes.summaryTitle}</div>
                      <dl className="kb-details-props">
                        {activeRes.summary.map(row => (
                          <div key={row.label} className="kb-details-prop-row">
                            <dt>{row.label}</dt>
                            <dd>
                              {row.linkTo ? (
                                <button
                                  type="button"
                                  className="kb-details-link"
                                  onClick={() => openResource(row.linkTo!)}
                                >
                                  {row.value}
                                </button>
                              ) : row.pill ? (
                                <span className="kb-qos-pill">{row.value}</span>
                              ) : (
                                row.value
                              )}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>

                    {activeRes.containers && (
                      <div className="kb-details-sec">
                        <div className="kb-details-sec-head with-icon">
                          <Box size={12} />
                          <span>Containers ({activeRes.containers.length})</span>
                        </div>
                        <div className="kb-container-list">
                          {activeRes.containers.map(c => (
                            <div key={c.name} className="kb-container-row">
                              <div className="kb-container-main">
                                <span className="kb-c-dot" />
                                <strong className="kb-c-name">{c.name}</strong>
                                <span className="kb-c-state">{c.state}</span>
                                <span className="kb-c-restarts">{c.restarts} restarts</span>
                              </div>
                              <div className="kb-c-metrics">
                                <span>CPU <b>{c.cpu}</b></span>
                                <span>RAM <b>{c.ram}</b></span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {inspectorTab === 'env' && activeRes.env && (
                  <div className="kb-details-sec">
                    <div className="kb-details-sec-head">Resolved environment · {activeRes.env.length} variables</div>
                    <div className="kb-insp-env-list">
                      {activeRes.env.map(v => (
                        <div key={v.name} className={v.drifted ? 'kb-insp-env-row drifted' : 'kb-insp-env-row'}>
                          <div className="kb-insp-env-k">
                            <code>{v.name}</code>
                            {v.target ? (
                              <button
                                type="button"
                                className="kb-details-link"
                                onClick={() => openResource(v.target!)}
                              >
                                {v.source}
                              </button>
                            ) : (
                              <span>{v.source}</span>
                            )}
                          </div>
                          <code className={v.secret ? 'kb-insp-env-v masked' : 'kb-insp-env-v'}>
                            {v.secret && <Lock size={10} />}
                            {v.value}
                          </code>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {inspectorTab === 'related' && (
                  <div className="kb-details-sec">
                    <div className="kb-details-sec-head split">
                      <span>Resource relationships</span>
                      <span className="kb-rel-count">
                        {filteredRelated.length} matching · {activeRes.related.length} relationships
                      </span>
                    </div>
                    <div className="kb-related-search-wrap">
                      <Search size={11} />
                      <input
                        type="search"
                        value={relatedQuery}
                        onChange={e => setRelatedQuery(e.target.value)}
                        placeholder="Filter related resources…"
                        aria-label="Filter related resources"
                      />
                    </div>
                    <div className="kb-related-list">
                      {filteredRelated.map(row => (
                        <button
                          key={`${row.kind}/${row.name}`}
                          type="button"
                          disabled={!row.target}
                          className="kb-related-row"
                          onClick={() => row.target && openResource(row.target)}
                        >
                          {row.dir === 'out' ? <ArrowRight size={11} /> : <ArrowLeft size={11} />}
                          <MiniKindBadge kind={row.kind} />
                          <span className="kb-rel-name">{row.name}</span>
                          <span className="kb-rel-ns">{row.ns}</span>
                          <span className="kb-rel-label">{row.rel}</span>
                        </button>
                      ))}
                      {!filteredRelated.length && (
                        <div className="kb-details-empty">No related resources match this filter.</div>
                      )}
                    </div>
                  </div>
                )}

                {inspectorTab === 'events' && (
                  <div className="kb-details-sec">
                    <div className="kb-details-sec-head split">
                      <span>Resource events</span>
                      <span className="kb-rel-count">{activeRes.events.length} events</span>
                    </div>
                    <div className="kb-events-list">
                      {activeRes.events.length ? (
                        activeRes.events.map((ev, i) => (
                          <article key={i} className="kb-ev-article">
                            <div className="kb-ev-head">
                              <span className={ev.type === 'Warning' ? 'kb-ev-warn' : 'kb-ev-ok'}>{ev.type}</span>
                              <strong>{ev.reason}</strong>
                              <span className="kb-ev-cnt">×{ev.count}</span>
                              <span className="kb-ev-age">{ev.age}</span>
                            </div>
                            <p className="kb-ev-msg-full">{ev.msg}</p>
                            <div className="kb-ev-rep">{ev.reporter}</div>
                          </article>
                        ))
                      ) : (
                        <div className="kb-details-empty">No events for this object in the loaded snapshot.</div>
                      )}
                    </div>
                  </div>
                )}

                {inspectorTab === 'yaml' && (
                  <div className="kb-details-sec">
                    <div className="kb-details-sec-head">Clean YAML · {activeRes.kind}/{activeRes.name}</div>
                    <pre className="kb-insp-yaml">{activeRes.yaml}</pre>
                  </div>
                )}
              </div>
            </div>

            <div className="kb-bento-foot">
              <div className="kb-bento-title">
                <CircleDot size={16} className="kb-icon-purple" />
                <h3>Details that lead somewhere</h3>
              </div>
              <p>
                Jump directly between failing Pods, ReplicaSets, Nodes, ConfigMaps and related Services with full back navigation.
              </p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
