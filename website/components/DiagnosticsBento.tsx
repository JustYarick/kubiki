import { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  Boxes,
  Braces,
  ChevronRight,
  CircleDot,
  Cpu,
  FileText,
  Folder,
  GitBranch,
  HelpCircle,
  Layers,
  LayoutDashboard,
  MemoryStick,
  Network,
  Pause,
  Play,
  Radio,
  Server,
  Terminal,
  TriangleAlert,
} from 'lucide-react';

type ProblemSeverity = 'all' | 'error' | 'warning';
type LogFilter = 'all' | 'error' | 'warn' | 'info';
type InspectorTab = 'overview' | 'related' | 'events';

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

const PROBLEMS_DATA = [
  {
    id: 'p1',
    severity: 'error' as const,
    kind: 'Pod',
    name: 'payment-worker-67f98b984-pv4n8',
    ns: 'backend',
    summary: 'Container worker: CrashLoopBackOff',
    message: 'Last termination OOMKilled (exitCode 137) · 6 restarts',
  },
  {
    id: 'p2',
    severity: 'error' as const,
    kind: 'Pod',
    name: 'analytics-dispatcher-7f9c97d-88943',
    ns: 'analytics-staging',
    summary: 'Container app: ImagePullBackOff',
    message: 'Waiting for container startup',
  },
  {
    id: 'p3',
    severity: 'warning' as const,
    kind: 'Deployment',
    name: 'analytics-dispatcher',
    ns: 'analytics-staging',
    summary: '14/16 replicas are ready',
    message: 'Some desired replicas are not ready. Check related Pods.',
  },
  {
    id: 'p4',
    severity: 'warning' as const,
    kind: 'ConfigMap',
    name: 'worker-config',
    ns: 'backend',
    summary: 'Configuration drift detected',
    message: 'Updated after Pod payment-worker-67f98b984-pv4n8 started.',
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

const RELATED_ROWS = [
  { dir: 'in' as const, kind: 'ReplicaSet', name: 'payment-worker-67f98b984', ns: 'backend', rel: 'owns' },
  { dir: 'in' as const, kind: 'Deployment', name: 'payment-worker', ns: 'backend', rel: 'root controller' },
  { dir: 'in' as const, kind: 'Service', name: 'payment-worker-metrics', ns: 'backend', rel: 'selects' },
  { dir: 'out' as const, kind: 'ConfigMap', name: 'worker-config', ns: 'backend', rel: 'envFrom' },
  { dir: 'out' as const, kind: 'Secret', name: 'payments-secrets', ns: 'backend', rel: 'valueFrom' },
  { dir: 'out' as const, kind: 'Node', name: 'node-2b', ns: 'cluster', rel: 'scheduled on' },
];

const POD_EVENTS = [
  { type: 'Warning', reason: 'OOMKilling', age: '2m', msg: 'Memory cgroup out of memory: Killed process payment-worker (137)' },
  { type: 'Warning', reason: 'BackOff', age: '1m', msg: 'Back-off restarting failed container worker in pod payment-worker' },
  { type: 'Normal', reason: 'Pulled', age: '4m', msg: 'Container image "ghcr.io/acme/payment-worker:v2.4.1" already present on machine' },
  { type: 'Normal', reason: 'Scheduled', age: '4m', msg: 'Successfully assigned backend/payment-worker-67f98b984-pv4n8 to node-2b' },
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

  const filteredProblems = PROBLEMS_DATA.filter(p => problemFilter === 'all' || p.severity === problemFilter);
  const filteredLogs = logFilter === 'all' ? logs : logs.filter(l => l.level === logFilter);

  return (
    <section className="kb-section kb-section-glow-tl" id="diagnostics">
      <div className="kb-container">
        <span className="kb-badge">Cluster Diagnostics</span>
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
                    <div key={item.id} className="kb-prob-row">
                      <div className="kb-prob-row-top">
                        <span className={item.severity === 'error' ? 'kb-sev-crit' : 'kb-sev-warn'}>
                          {item.severity === 'error' ? 'Critical' : 'Warning'}
                        </span>
                        <MiniKindBadge kind={item.kind} />
                        <span className="kb-prob-name">{item.name}</span>
                      </div>
                      <p className="kb-prob-sub">{item.ns} · {item.summary}</p>
                      <p className="kb-prob-msg">{item.message}</p>
                    </div>
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

          {/* Card 4 (2 cols): Authentic Kubiki Pod ResourceDetails Inspector (ProblemsBanner + Pod summary + Related + Events) */}
          <article className="kb-bento-card kb-col-2">
            <div className="kb-bento-app-body kb-real-inspector">
              {/* ResourceHeader matching src/components/k8s/details/ResourceHeader.tsx */}
              <div className="kb-insp-header">
                <div className="kb-insp-identity">
                  <div className="kb-insp-breadcrumbs">
                    <span>Deployment/payment-worker</span>
                    <ChevronRight size={11} />
                    <span>ReplicaSet/payment-worker-67f98b984</span>
                    <ChevronRight size={11} />
                  </div>
                  <div className="kb-insp-title-row">
                    <MiniKindBadge kind="Pod" />
                    <strong>payment-worker-67f98b984-pv4n8</strong>
                    <span className="kb-insp-ns">backend</span>
                  </div>
                </div>

                <div className="kb-insp-actions">
                  <span><FileText size={11} />Logs</span>
                  <span><Terminal size={11} />Shell</span>
                  <span><Radio size={11} />Attach</span>
                  <span><ArrowRightLeft size={11} />Ports</span>
                  <span><GitBranch size={11} />Topology</span>
                </div>

                <div className="kb-insp-tabs" role="tablist" aria-label="Pod inspector tabs">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={inspectorTab === 'overview'}
                    onClick={() => setInspectorTab('overview')}
                  >
                    Overview
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={inspectorTab === 'related'}
                    onClick={() => setInspectorTab('related')}
                  >
                    Related
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={inspectorTab === 'events'}
                    onClick={() => setInspectorTab('events')}
                  >
                    Events
                  </button>
                </div>
              </div>

              {inspectorTab === 'overview' && (
                <div className="kb-insp-overview-grid">
                  {/* Real ProblemsBanner.tsx */}
                  <div className="kb-problems-banner">
                    <div className="kb-pb-head">
                      <AlertCircle size={13} />
                      <span>WHAT’S WRONG · 1 ISSUE DETECTED</span>
                    </div>
                    <div className="kb-pb-title">OOMKilled (Exit Code 137) · Container “worker”</div>
                    <p className="kb-pb-desc">
                      The process was killed by Linux OOM killer because memory consumption exceeded the defined container limit.
                    </p>
                    <div className="kb-pb-hint">
                      <HelpCircle size={12} />
                      <span>Increase “resources.limits.memory” in your Deployment spec.</span>
                    </div>
                    <div className="kb-pb-foot">
                      <span className="kb-pb-btn">
                        Investigate with AI
                      </span>
                    </div>
                  </div>

                  {/* Real Pod summary DetailsSection */}
                  <div className="kb-details-sec">
                    <div className="kb-details-sec-head">Pod summary</div>
                    <dl className="kb-details-props">
                      <dt>Node</dt>
                      <dd className="link">node-2b</dd>
                      <dt>QoS Class</dt>
                      <dd><span className="kb-qos-pill">Burstable</span></dd>
                      <dt>Controlled by</dt>
                      <dd className="link">ReplicaSet/payment-worker-67f98b984</dd>
                      <dt>Pod IP</dt>
                      <dd>10.42.0.21</dd>
                      <dt>Restarts</dt>
                      <dd className="danger">6 (CrashLoopBackOff)</dd>
                    </dl>
                  </div>
                </div>
              )}

              {inspectorTab === 'related' && (
                <div className="kb-details-sec">
                  <div className="kb-details-sec-head">Resource relationships · 6 linked objects</div>
                  <div className="kb-related-list">
                    {RELATED_ROWS.map(row => (
                      <div key={row.name} className="kb-related-row">
                        {row.dir === 'out' ? <ArrowRight size={11} /> : <ArrowLeft size={11} />}
                        <MiniKindBadge kind={row.kind} />
                        <span className="kb-rel-name">{row.name}</span>
                        <span className="kb-rel-ns">{row.ns}</span>
                        <span className="kb-rel-label">{row.rel}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {inspectorTab === 'events' && (
                <div className="kb-details-sec">
                  <div className="kb-details-sec-head">Events · payment-worker-67f98b984-pv4n8</div>
                  <div className="kb-events-list">
                    {POD_EVENTS.map((ev, i) => (
                      <div key={i} className="kb-event-row">
                        <span className={ev.type === 'Warning' ? 'kb-ev-warn' : 'kb-ev-ok'}>{ev.reason}</span>
                        <span className="kb-ev-msg">{ev.msg}</span>
                        <span className="kb-ev-age">{ev.age}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="kb-bento-foot">
              <div className="kb-bento-title">
                <CircleDot size={16} className="kb-icon-purple" />
                <h3>Details that lead somewhere</h3>
              </div>
              <p>
                Move from root-cause diagnostics and Pod summary properties directly to warning events, linked workloads and topology.
              </p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
