import { useState } from 'react';
import {
  Check,
  Cpu,
  Database,
  Lock,
  Plug,
  ShieldCheck,
  Terminal,
  Zap,
} from 'lucide-react';
import mark from '../../public/brand/kubiki-mark-color.svg';

type PolicyMode = 'plan' | 'ask' | 'auto';

type ClusterSource = {
  id: string;
  kind: string;
  name: string;
  meta: string;
  tone: string;
};

type AgentClient = {
  id: string;
  name: string;
  transport: string;
  planStatus: string;
  askStatus: string;
  autoStatus: string;
  color: string;
};

const SOURCES: ClusterSource[] = [
  { id: 'kube', kind: 'Kubeconfig', name: 'kubiki-demo', meta: '184 nodes · 8,476 pods', tone: '#7e9fff' },
  { id: 'helm', kind: 'Helm & GitOps', name: 'Flux · Argo CD · Helm', meta: '728 releases · snapshots', tone: '#4ec9b0' },
  { id: 'crd', kind: 'Discovery', name: 'Custom Resources', meta: '11 CRD groups · schema', tone: '#c586c0' },
  { id: 'logs', kind: 'Streams', name: 'Logs, Exec & Ports', meta: 'Direct Rust K8s client', tone: '#56c8d8' },
];

const CLIENTS: AgentClient[] = [
  {
    id: 'integrated',
    name: 'Integrated AI',
    transport: 'In-memory MCP session',
    planStatus: 'Read & propose plan',
    askStatus: 'Confirm writes',
    autoStatus: 'Bounded auto',
    color: '#9b7aea',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    transport: 'Streamable HTTP · :3847/mcp',
    planStatus: 'Read-only profile',
    askStatus: 'Ask on mutations',
    autoStatus: 'Action profile',
    color: '#3574f0',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    transport: 'Streamable HTTP · :3847/mcp',
    planStatus: 'Read-only profile',
    askStatus: 'Ask on mutations',
    autoStatus: 'Action profile',
    color: '#7e9fff',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    transport: 'Attached PTY / System terminal',
    planStatus: 'Read-only profile',
    askStatus: 'Ask on mutations',
    autoStatus: 'Action profile',
    color: '#59a869',
  },
];

const TOOLS: { name: string; kind: 'read' | 'write' }[] = [
  { name: 'get_pod_diagnostics', kind: 'read' },
  { name: 'get_events', kind: 'read' },
  { name: 'get_logs', kind: 'read' },
  { name: 'list_resources', kind: 'read' },
  { name: 'propose_plan', kind: 'read' },
  { name: 'apply_yaml', kind: 'write' },
  { name: 'scale_workload', kind: 'write' },
];

export function InfrastructureSection() {
  const [policy, setPolicy] = useState<PolicyMode>('plan');

  return (
    <section className="kb-section kb-section-glow-tl" id="agents">
      <div className="kb-container">
        <div className="kb-split-head">
          <h2>Built for cluster scale and scoped AI</h2>
          <p>
            Kubiki’s Rust core pairs bounded informers and metadata-first discovery with a loopback Streamable HTTP MCP server—delivering scoped cluster evidence to the integrated AI and external coding agents.
          </p>
        </div>

        <div className="kb-3col kb-3col-flush">
          <div>
            <Cpu size={17} className="kb-col-icon" />
            <h3>Rust Kubernetes Core</h3>
            <p>
              Scoped watches, cancellable reads and direct exec/log/port-forward transports inside a native desktop binary.
            </p>
          </div>
          <div>
            <Plug size={17} className="kb-col-icon" />
            <h3>Scoped MCP Profiles</h3>
            <p>
              Separate Read-only and Action profiles pin contexts, namespaces and Secret redaction before any AI tool executes.
            </p>
          </div>
          <div>
            <Zap size={17} className="kb-col-icon" />
            <h3>Metadata-first speed</h3>
            <p>
              Lightweight discovery and bounded snapshots keep 8,000+ Pod clusters responsive on every context switch.
            </p>
          </div>
        </div>

        {/* Kubiki Topology-Style Interactive MCP & Core Flow Canvas */}
        <div className="kb-topo-canvas">
          <div className="kb-topo-bar">
            <div className="kb-topo-title">
              <Plug size={13} />
              <span>kubiki-core › Policy &amp; MCP Topology</span>
            </div>
            <div className="kb-policy-tabs" role="group" aria-label="MCP policy mode">
              <button type="button" aria-pressed={policy === 'plan'} onClick={() => setPolicy('plan')}>
                Plan · Read-Only
              </button>
              <button type="button" aria-pressed={policy === 'ask'} onClick={() => setPolicy('ask')}>
                Action · Ask
              </button>
              <button type="button" aria-pressed={policy === 'auto'} onClick={() => setPolicy('auto')}>
                Action · Auto Accept
              </button>
            </div>
          </div>

          <div className="kb-topo-graph">
            {/* Left column: Cluster Data Sources */}
            <div className="kb-topo-col">
              {SOURCES.map(src => (
                <div key={src.id} className="kb-topo-node">
                  <div className="kb-topo-node-head">
                    <span className="kb-topo-dot" style={{ background: src.tone }} />
                    <span className="kb-topo-kind" style={{ color: src.tone }}>{src.kind}</span>
                  </div>
                  <strong>{src.name}</strong>
                  <small>{src.meta}</small>
                </div>
              ))}
            </div>

            {/* Animated SVG edges: Sources -> Kubiki Core Gate */}
            <svg className="kb-topo-svg" viewBox="0 0 210 340" preserveAspectRatio="none" aria-hidden="true">
              {[42, 128, 214, 300].map((y, idx) => {
                const d = `M 0 ${y} C 95 ${y}, 115 170, 210 170`;
                return (
                  <g key={y}>
                    <path d={d} className="kb-edge-base" />
                    <path d={d} className={`kb-edge-flow delay-${idx}`} style={{ stroke: SOURCES[idx].tone }} />
                  </g>
                );
              })}
            </svg>

            {/* Center Hub: Kubiki Core + Policy Gate */}
            <div className="kb-topo-hub">
              <div className="kb-hub-card">
                <div className="kb-hub-ring" aria-hidden="true" />
                <div className="kb-hub-head">
                  <img src={mark} width="24" height="24" alt="" />
                  <div>
                    <strong>kubiki-core · mcp</strong>
                    <span>127.0.0.1:3847/mcp</span>
                  </div>
                </div>
                <div className="kb-hub-rules">
                  <div>
                    <Database size={11} />
                    <span>Secrets</span>
                    <em>none (redacted)</em>
                  </div>
                  <div>
                    <Terminal size={11} />
                    <span>Scope</span>
                    <em>kubiki-demo / backend</em>
                  </div>
                  <div>
                    <ShieldCheck size={11} />
                    <span>Writes</span>
                    <em className={`mode-${policy}`}>
                      {policy === 'plan' ? 'blocked' : policy === 'ask' ? 'confirm UID+rv' : 'allowlisted'}
                    </em>
                  </div>
                </div>
              </div>
            </div>

            {/* Animated SVG edges: Kubiki Core Gate -> AI Clients */}
            <svg className="kb-topo-svg" viewBox="0 0 210 340" preserveAspectRatio="none" aria-hidden="true">
              {[42, 128, 214, 300].map((y, idx) => {
                const d = `M 0 170 C 95 170, 115 ${y}, 210 ${y}`;
                const stroke = policy === 'plan' ? CLIENTS[idx].color : policy === 'ask' ? '#e5b742' : '#59a869';
                return (
                  <g key={y}>
                    <path d={d} className="kb-edge-base" />
                    <path d={d} className={`kb-edge-flow delay-${(idx + 2) % 4}`} style={{ stroke }} />
                  </g>
                );
              })}
            </svg>

            {/* Right column: AI & External MCP Clients */}
            <div className="kb-topo-col">
              {CLIENTS.map(client => {
                const statusText =
                  policy === 'plan'
                    ? client.planStatus
                    : policy === 'ask'
                      ? client.askStatus
                      : client.autoStatus;
                return (
                  <div key={client.id} className="kb-topo-node client">
                    <div className="kb-topo-node-head">
                      <span className="kb-topo-dot" style={{ background: client.color }} />
                      <span className={`kb-topo-pill mode-${policy}`}>
                        {policy === 'plan' ? <Lock size={10} /> : policy === 'ask' ? <ShieldCheck size={10} /> : <Plug size={10} />}
                        {statusText}
                      </span>
                    </div>
                    <strong>{client.name}</strong>
                    <small>{client.transport}</small>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="kb-topo-footer">
            <span className="kb-topo-foot-label">Exposed MCP tools</span>
            <div className="kb-topo-tools">
              {TOOLS.map(tool => {
                const allowed = tool.kind === 'read' || policy !== 'plan';
                return (
                  <span key={tool.name} className={allowed ? 'kb-tool-chip ok' : 'kb-tool-chip locked'}>
                    {allowed ? <Check size={11} /> : <Lock size={11} />}
                    <code>{tool.name}</code>
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
