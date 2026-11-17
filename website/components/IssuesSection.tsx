import { useEffect, useState } from 'react';
import { AlertTriangle, Bell, Bot, Braces, Eye, EyeOff, FileDiff, FileText, GitBranch, Key, MoreHorizontal, ShieldCheck } from 'lucide-react';

type WorkbenchTab = 'issues' | 'env' | 'yaml';

const KIND_TONES: Record<string, { color: string; bg: string; border: string }> = {
  Pod: { color: '#b39aff', bg: 'rgba(179, 154, 255, 0.16)', border: 'rgba(179, 154, 255, 0.34)' },
  ConfigMap: { color: '#56c8d8', bg: 'rgba(86, 200, 216, 0.16)', border: 'rgba(86, 200, 216, 0.34)' },
  Deployment: { color: '#b39aff', bg: 'rgba(179, 154, 255, 0.16)', border: 'rgba(179, 154, 255, 0.34)' },
  Service: { color: '#73daca', bg: 'rgba(115, 218, 202, 0.16)', border: 'rgba(115, 218, 202, 0.34)' },
  HelmRelease: { color: '#4ec9b0', bg: 'rgba(78, 201, 176, 0.16)', border: 'rgba(78, 201, 176, 0.34)' },
};

const ISSUES = [
  { id: 'POD-137', kind: 'Pod', status: 'CrashLoopBackOff', tone: 'rose', title: 'payment-worker-67f98b984-pv4n8 · OOMKilled (137)', ns: 'backend', time: '2m ago', assignee: 'Investigate AI' },
  { id: 'CFG-042', kind: 'ConfigMap', status: 'Drift', tone: 'amber', title: 'worker-config updated after Pod startup', ns: 'backend', time: '6m ago', assignee: 'Env Resolver' },
  { id: 'IMG-019', kind: 'Pod', status: 'ImagePullBackOff', tone: 'rose', title: 'analytics-dispatcher-7f9c97d · ErrImagePull', ns: 'analytics-staging', time: '11m ago', assignee: 'Events' },
  { id: 'DEP-084', kind: 'Deployment', status: 'Progressing', tone: 'amber', title: 'analytics-exporter · 14 / 16 replicas ready', ns: 'analytics-staging', time: '18m ago', assignee: 'Rollout' },
  { id: 'NET-031', kind: 'Service', status: 'Active', tone: 'blue', title: 'payments-redis ClusterIP selector (3 endpoints)', ns: 'payments-prod', time: '32m ago', assignee: 'Topology' },
  { id: 'HLM-008', kind: 'HelmRelease', status: 'Deployed', tone: 'emerald', title: 'payments-prod-api revision 4 deployed cleanly', ns: 'payments-prod', time: '1h ago', assignee: 'Helm History' },
];

const ACTIONS_MENU = [
  { label: 'Investigate with AI', icon: Bot },
  { label: 'Open Container Logs', icon: FileText },
  { label: 'Inspect Events & Conditions', icon: Bell },
  { label: 'Open Topology Graph', icon: GitBranch },
  { label: 'Review Clean YAML', icon: Braces },
];

const ENV_ITEMS = [
  { name: 'APP_ENV', src: 'Direct value', masked: 'production', revealed: 'production' },
  { name: 'POD_IP', src: 'Downward API · status.podIP', masked: '10.42.0.21', revealed: '10.42.0.21' },
  { name: 'BATCH_MEMORY_MB', src: 'ConfigMap · worker-config (updated)', masked: '512', revealed: '512', drifted: true },
  { name: 'STRIPE_API_KEY', src: 'Secret · payments-secrets', masked: '••••••••••••••••••••', revealed: 'sk_live_demo_94f1a82c', secret: true },
  { name: 'REDIS_PASSWORD', src: 'Secret · payments-redis', masked: '••••••••••••', revealed: 'r3d1s_prod_77', secret: true },
];

export function IssuesSection() {
  const [tab, setTab] = useState<WorkbenchTab>('issues');
  const [menuRow, setMenuRow] = useState<string | null>('IMG-019');
  const [rowAction, setRowAction] = useState<Record<string, string>>({});
  const [revealSecrets, setRevealSecrets] = useState(false);
  const [maskSec, setMaskSec] = useState(60);
  const [yamlView, setYamlView] = useState<'clean' | 'full' | 'diff'>('diff');

  useEffect(() => {
    if (!revealSecrets) {
      setMaskSec(60);
      return;
    }
    const id = window.setInterval(() => {
      setMaskSec(s => {
        if (s <= 1) {
          setRevealSecrets(false);
          return 60;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [revealSecrets]);

  return (
    <section className="kb-section kb-section-glow-tl" id="capabilities">
      <div className="kb-container">
        <div className="kb-split-head">
          <h2>Track failing workloads and config drift</h2>
          <p>
            Detect CrashLoopBackOff, OOMKilled terminations, Secret/ConfigMap drift and concurrent manifest edits automatically. Jump from any row straight into logs, YAML diffs or scoped AI analysis.
          </p>
        </div>

        <div className="kb-issues-frame">
          <div className="kb-issues-bar">
            <div className="kb-issues-tabs" role="tablist" aria-label="Inspector modes">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'issues'}
                className={tab === 'issues' ? 'active' : ''}
                onClick={() => setTab('issues')}
              >
                <AlertTriangle size={13} />
                <span>Cluster issues</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'env'}
                className={tab === 'env' ? 'active' : ''}
                onClick={() => setTab('env')}
              >
                <Key size={13} />
                <span>Env &amp; Secret drift</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'yaml'}
                className={tab === 'yaml' ? 'active' : ''}
                onClick={() => setTab('yaml')}
              >
                <Braces size={13} />
                <span>YAML &amp; Concurrency diff</span>
              </button>
            </div>

            {tab === 'env' && (
              <button
                type="button"
                className={revealSecrets ? 'kb-inline-toggle active' : 'kb-inline-toggle'}
                onClick={() => setRevealSecrets(r => !r)}
              >
                {revealSecrets ? <EyeOff size={12} /> : <Eye size={12} />}
                <span>{revealSecrets ? `Auto-mask in ${maskSec}s` : 'Reveal Secret values'}</span>
              </button>
            )}

            {tab === 'yaml' && (
              <div className="kb-inline-pills">
                <button type="button" className={yamlView === 'clean' ? 'active' : ''} onClick={() => setYamlView('clean')}>Clean</button>
                <button type="button" className={yamlView === 'full' ? 'active' : ''} onClick={() => setYamlView('full')}>Server fields</button>
                <button type="button" className={yamlView === 'diff' ? 'active' : ''} onClick={() => setYamlView('diff')}>
                  <FileDiff size={12} />
                  Diff
                </button>
              </div>
            )}
          </div>

          {tab === 'issues' && (
            <div className="kb-issues-table">
              <div className="kb-grid-header">
                <span>ID</span>
                <span>KIND</span>
                <span>STATUS</span>
                <span>RESOURCE / SIGNAL</span>
                <span>NAMESPACE</span>
                <span>AGE</span>
                <span>ACTION</span>
                <span />
              </div>
              {ISSUES.map(issue => {
                const menuOpen = menuRow === issue.id;
                const actionLabel = rowAction[issue.id] ?? issue.assignee;
                return (
                  <div
                    key={issue.id}
                    className={menuOpen ? 'kb-issue-row selected' : 'kb-issue-row'}
                    onClick={() => setMenuRow(prev => (prev === issue.id ? null : issue.id))}
                  >
                    <code className="kb-issue-id">{issue.id}</code>
                    <span
                      className="kb-issue-kind"
                      style={KIND_TONES[issue.kind]}
                    >
                      {issue.kind}
                    </span>
                    <span className={`kb-status-chip tone-${issue.tone}`}>
                      <i />
                      {issue.status}
                    </span>
                    <span className="kb-issue-title">{issue.title}</span>
                    <span className="kb-issue-ns">{issue.ns}</span>
                    <span className="kb-issue-time">{issue.time}</span>
                    <span className="kb-issue-action">{actionLabel}</span>
                    <MoreHorizontal size={15} className="kb-issue-more" />

                    {menuOpen && (
                      <div className="kb-issue-popover" onClick={e => e.stopPropagation()}>
                        {ACTIONS_MENU.map(act => {
                          const ActionIcon = act.icon;
                          return (
                            <button
                              key={act.label}
                              type="button"
                              onClick={() => {
                                setRowAction(prev => ({ ...prev, [issue.id]: act.label }));
                                setMenuRow(null);
                              }}
                            >
                              <ActionIcon size={12} />
                              <span>{act.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'env' && (
            <div className="kb-env-table">
              {ENV_ITEMS.map(item => (
                <div key={item.name} className={item.drifted ? 'kb-env-row drifted' : 'kb-env-row'}>
                  <div>
                    <code>{item.name}</code>
                    <span>{item.src}</span>
                  </div>
                  <div className="kb-env-right">
                    {item.drifted && <span className="kb-drift-tag">Drift detected</span>}
                    <code className={item.secret && !revealSecrets ? 'masked' : ''}>
                      {revealSecrets ? item.revealed : item.masked}
                    </code>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'yaml' && (
            <pre className="kb-yaml-panel">
              {yamlView === 'clean' && (
                <code>
                  <span className="yk">apiVersion:</span> apps/v1{'\n'}
                  <span className="yk">kind:</span> Deployment{'\n'}
                  <span className="yk">metadata:</span>{'\n'}
                  {'  '}<span className="yk">name:</span> payment-worker{'\n'}
                  {'  '}<span className="yk">namespace:</span> backend{'\n'}
                  <span className="yk">spec:</span>{'\n'}
                  {'  '}<span className="yk">containers:</span>{'\n'}
                  {'  '}- <span className="yk">name:</span> worker{'\n'}
                  {'    '}<span className="yk">resources:</span>{'\n'}
                  {'      '}<span className="yk">limits:</span>{'\n'}
                  {'        '}<span className="yk">memory:</span> <span className="yv">256Mi</span>
                </code>
              )}
              {yamlView === 'full' && (
                <code>
                  <span className="yk">metadata:</span>{'\n'}
                  {'  '}<span className="yk">name:</span> payment-worker{'\n'}
                  {'  '}<span className="yk">uid:</span> <span className="ym">94b21e0a-8c3e-41d0-b122</span>{'\n'}
                  {'  '}<span className="yk">resourceVersion:</span> <span className="ym">"4829104"</span>{'\n'}
                  {'  '}<span className="yk">managedFields:</span>{'\n'}
                  {'  '}- <span className="yk">manager:</span> <span className="ym">kubectl-client-side-apply</span>{'\n'}
                  <span className="yk">status:</span>{'\n'}
                  {'  '}<span className="yk">availableReplicas:</span> <span className="yv">2</span>{'\n'}
                  {'  '}<span className="yk">unavailableReplicas:</span> <span className="ye">1</span>
                </code>
              )}
              {yamlView === 'diff' && (
                <code>
                  <span className="ym">@@ Deployment/payment-worker · UID 94b21e0a · rv 4829104 @@</span>{'\n'}
                  {'  '}<span className="yk">resources:</span>{'\n'}
                  {'    '}<span className="yk">limits:</span>{'\n'}
                  <span className="yd-del">-     memory: 256Mi</span>{'\n'}
                  <span className="yd-add">+     memory: 512Mi</span>{'\n'}
                  {'\n'}
                  <span className="ym">Backend verifies UID + resourceVersion before committing to Kubernetes API.</span>
                </code>
              )}
            </pre>
          )}
        </div>

        <div className="kb-3col">
          <div>
            <Key size={17} className="kb-col-icon" />
            <h3>Effective env without exec</h3>
            <p>
              Resolve direct, Downward API, ConfigMap and Secret variables even when container exec is disabled by cluster RBAC.
            </p>
          </div>
          <div>
            <ShieldCheck size={17} className="kb-col-icon" />
            <h3>Concurrency &amp; identity guards</h3>
            <p>
              Every update checks the object UID and resourceVersion before committing, so stale drafts never overwrite live changes.
            </p>
          </div>
          <div>
            <AlertTriangle size={17} className="kb-col-icon" />
            <h3>Instant drift &amp; event signals</h3>
            <p>
              Spot ConfigMaps or Secrets edited after Pod startup alongside warning events and failing container terminations.
            </p>
          </div>
        </div>

        <div className="kb-playbook-wrap">
          <div className="kb-strip-head">
            <span className="kb-strip-label">Recommended workflow</span>
            <p>Practical cluster triage sequence built around read-first diagnostics and safe mutations.</p>
          </div>
          <div className="kb-playbook-grid">
            <div className="kb-playbook-step">
              <span className="kb-step-num">01</span>
              <h3>Pin context &amp; scope</h3>
              <p>Select your cluster and namespace before starting terminals or MCP sessions so watches stay bounded.</p>
            </div>
            <div className="kb-playbook-step">
              <span className="kb-step-num">02</span>
              <h3>Start from Problems</h3>
              <p>Click any CrashLoopBackOff or drift signal to jump straight into container metrics, Events and Related owners.</p>
            </div>
            <div className="kb-playbook-step">
              <span className="kb-step-num">03</span>
              <h3>Keep MCP in Plan mode</h3>
              <p>Use the default Read-only profile while Claude Code or Codex inspect logs, events and YAML without writes.</p>
            </div>
            <div className="kb-playbook-step">
              <span className="kb-step-num">04</span>
              <h3>Check diff &amp; UID</h3>
              <p>Review clean YAML diffs and resourceVersion conflict checks before applying changes to live workloads.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
