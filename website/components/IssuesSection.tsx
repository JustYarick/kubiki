import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  Columns,
  Copy,
  Eye,
  EyeOff,
  Key,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
} from 'lucide-react';

interface EnvEntry {
  name: string;
  value: string;
  sourceType: 'Direct' | 'Downward API' | 'ConfigMap' | 'Secret';
  sourceDetail: string;
  isSecret?: boolean;
  drift?: {
    reason: string;
    clusterValue: string;
  };
}

const CONTAINERS: Record<string, EnvEntry[]> = {
  worker: [
    { name: 'APP_ENV', value: 'production', sourceType: 'Direct', sourceDetail: 'Direct value' },
    { name: 'POD_IP', value: '10.42.0.21', sourceType: 'Downward API', sourceDetail: 'fieldRef: status.podIP' },
    {
      name: 'BATCH_MEMORY_MB',
      value: '512',
      sourceType: 'ConfigMap',
      sourceDetail: 'worker-config [BATCH_MEMORY_MB]',
      drift: {
        reason: 'ConfigMap/worker-config updated after container start',
        clusterValue: '1024',
      },
    },
    { name: 'STRIPE_API_KEY', value: 'sk_live_demo_94f1a82c', sourceType: 'Secret', sourceDetail: 'payments-secrets [STRIPE_API_KEY]', isSecret: true },
    { name: 'REDIS_PASSWORD', value: 'r3d1s_prod_77', sourceType: 'Secret', sourceDetail: 'payments-redis [REDIS_PASSWORD]', isSecret: true },
  ],
  'init-migrate': [
    { name: 'MIGRATE_MODE', value: 'up', sourceType: 'Direct', sourceDetail: 'Direct value' },
    { name: 'POD_NAMESPACE', value: 'backend', sourceType: 'Downward API', sourceDetail: 'fieldRef: metadata.namespace' },
    { name: 'DATABASE_URL', value: 'postgres://app@pg-primary:5432/payments', sourceType: 'Secret', sourceDetail: 'payments-db [DATABASE_URL]', isSecret: true },
  ],
};

export function IssuesSection() {
  // PodEnvironmentTab state
  const [container, setContainer] = useState<'worker' | 'init-migrate'>('worker');
  const [revealAllSecrets, setRevealAllSecrets] = useState(false);
  const [showSource, setShowSource] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // YamlEditor state
  const [showServerFields, setShowServerFields] = useState(false);
  const [resourceVersion, setResourceVersion] = useState(4829104);
  const buildYaml = (mem: string, includeServer: boolean, rv: number) =>
    [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: payment-worker',
      '  namespace: backend',
      ...(includeServer
        ? [
            '  uid: 94b21e0a-8c3e-41d0-b122-7c90a1d4f201',
            `  resourceVersion: "${rv}"`,
            '  managedFields:',
            '    - manager: kubectl-client-side-apply',
          ]
        : []),
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: worker',
      '          resources:',
      '            limits:',
      `              memory: ${mem}`,
      ...(includeServer
        ? [
            'status:',
            '  availableReplicas: 2',
            '  unavailableReplicas: 1',
          ]
        : []),
    ].join('\n');

  const [appliedYaml, setAppliedYaml] = useState(() => buildYaml('256Mi', false, 4829104));
  const [draftYaml, setDraftYaml] = useState(() => buildYaml('512Mi', false, 4829104));

  const entries = CONTAINERS[container];
  const hasDrift = entries.some(e => Boolean(e.drift));
  const q = searchQuery.trim().toLowerCase();
  const filteredEntries = entries.filter(
    e =>
      !q ||
      e.name.toLowerCase().includes(q) ||
      e.sourceType.toLowerCase().includes(q) ||
      e.sourceDetail.toLowerCase().includes(q),
  );

  const dirty = draftYaml !== appliedYaml;

  const markCopied = (key: string) => {
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey(prev => (prev === key ? null : prev));
    }, 1400);
  };

  const toggleServerFields = () => {
    const next = !showServerFields;
    setShowServerFields(next);
    const memMatch = draftYaml.match(/memory:\s*(\S+)/);
    const currentMem = memMatch?.[1] ?? '512Mi';
    const appliedMemMatch = appliedYaml.match(/memory:\s*(\S+)/);
    const appliedMem = appliedMemMatch?.[1] ?? '256Mi';
    setDraftYaml(buildYaml(currentMem, next, resourceVersion));
    setAppliedYaml(buildYaml(appliedMem, next, resourceVersion));
  };

  const lineCount = draftYaml.split('\n').length;

  return (
    <section className="kb-section kb-section-glow-tl" id="capabilities">
      <div className="kb-container">
        <div className="kb-split-head">
          <h2>Track failing workloads and config drift</h2>
          <p>
            Kubiki resolves effective Pod environment variables with live ConfigMap/Secret drift detection and edits manifests in a clean YAML view backed by UID and resourceVersion checks.
          </p>
        </div>

        <div className="kb-app-split">
          {/* Left Pane: Real PodEnvironmentTab UI */}
          <div className="kb-app-pane">
            <div className="kb-app-pane-head">
              <span className="kb-app-pane-title">
                Pod / <code>payment-worker-67f98b984-pv4n8</code> · Environment
              </span>
            </div>

            <div className="kb-podenv-toolbar">
              <div className="kb-podenv-actions">
                <select
                  aria-label="Container"
                  className="kb-podenv-select"
                  value={container}
                  onChange={e => setContainer(e.target.value as 'worker' | 'init-migrate')}
                >
                  <option value="worker">worker (running)</option>
                  <option value="init-migrate">init-migrate (init)</option>
                </select>

                <button
                  type="button"
                  className="kb-podenv-btn"
                  onClick={() => setRevealAllSecrets(v => !v)}
                >
                  {revealAllSecrets ? <EyeOff size={12} /> : <Eye size={12} />}
                  <span>{revealAllSecrets ? 'Hide Secrets' : 'Reveal All Secrets'}</span>
                </button>

                <button
                  type="button"
                  className="kb-podenv-btn"
                  onClick={() => setShowSource(v => !v)}
                >
                  <Columns size={12} />
                  <span>{showSource ? 'Hide Source' : 'Show Source'}</span>
                </button>

                <button
                  type="button"
                  className="kb-podenv-btn"
                  onClick={() => markCopied('export-all')}
                >
                  {copiedKey === 'export-all' ? <Check size={12} className="kb-ok-icon" /> : <Copy size={12} />}
                  <span>{copiedKey === 'export-all' ? 'Copied .env' : 'Export .env'}</span>
                </button>
              </div>

              <div className="kb-podenv-search">
                <Search size={12} />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search variables or sources..."
                  aria-label="Search variables or sources"
                />
              </div>
            </div>

            {hasDrift && (
              <div className="kb-podenv-drift-banner">
                <AlertTriangle size={13} />
                <div>
                  <strong>Configuration drift detected:</strong> One or more ConfigMaps or Secrets referenced by this pod were modified after container start. The values displayed below represent the active Pod environment.
                </div>
              </div>
            )}

            <div className="kb-podenv-table-wrap">
              <table className="kb-podenv-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Value</th>
                    {showSource && <th>Source</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.map(entry => {
                    const masked = Boolean(entry.isSecret && !revealAllSecrets);
                    return (
                      <tr key={entry.name}>
                        <td className="kb-podenv-name">
                          <button
                            type="button"
                            className="kb-copy-cell"
                            onClick={() => markCopied(`name-${entry.name}`)}
                            title="Click to copy name"
                          >
                            {entry.drift && <AlertTriangle size={11} className="kb-warn-icon" />}
                            <span>{entry.name}</span>
                            {copiedKey === `name-${entry.name}` && <span className="kb-copied-pill">Copied</span>}
                          </button>
                        </td>
                        <td className="kb-podenv-val">
                          <button
                            type="button"
                            className="kb-copy-cell"
                            onClick={() => markCopied(`val-${entry.name}`)}
                            title="Click to copy value"
                          >
                            <span className={masked ? 'masked' : ''}>
                              {masked ? '••••••••••••' : entry.value}
                            </span>
                            {copiedKey === `val-${entry.name}` && <span className="kb-copied-pill">Copied</span>}
                          </button>
                          {entry.drift && (
                            <div className="kb-podenv-drift-sub">
                              ↳ {entry.drift.reason} · Cluster has: <code>&quot;{entry.drift.clusterValue}&quot;</code>
                            </div>
                          )}
                        </td>
                        {showSource && (
                          <td className="kb-podenv-src">
                            <span className="kb-src-type">{entry.sourceType}</span>
                            <span className="kb-src-detail">{entry.sourceDetail}</span>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right Pane: Real YamlEditor UI */}
          <div className="kb-app-pane">
            <div className="kb-yaml-toolbar">
              <div className="kb-yaml-identity">
                <span className="kb-yaml-res-name">Deployment/payment-worker</span>
                <span className="kb-yaml-state" data-dirty={dirty}>
                  {dirty ? 'Unsaved edits' : 'Clean manifest'}
                </span>
              </div>

              <div className="kb-yaml-actions">
                <button
                  type="button"
                  className={showServerFields ? 'kb-yaml-icon-btn active' : 'kb-yaml-icon-btn'}
                  onClick={toggleServerFields}
                  title="Show server fields (status/managedFields)"
                  aria-label="Show server fields"
                  aria-pressed={showServerFields}
                >
                  {showServerFields ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  type="button"
                  className="kb-yaml-icon-btn"
                  onClick={() => markCopied('yaml')}
                  title="Copy YAML"
                  aria-label="Copy YAML"
                >
                  {copiedKey === 'yaml' ? <Check size={13} className="kb-ok-icon" /> : <Copy size={13} />}
                </button>
                <button
                  type="button"
                  className="kb-yaml-icon-btn"
                  disabled={!dirty}
                  onClick={() => setDraftYaml(appliedYaml)}
                  title="Revert to cluster manifest"
                  aria-label="Revert"
                >
                  <RotateCcw size={13} />
                </button>
                <button
                  type="button"
                  className="kb-yaml-apply-btn"
                  disabled={!dirty}
                  onClick={() => {
                    const nextRv = resourceVersion + 1;
                    setResourceVersion(nextRv);
                    const updated = showServerFields
                      ? draftYaml.replace(/resourceVersion:\s*"\d+"/, `resourceVersion: "${nextRv}"`)
                      : draftYaml;
                    setDraftYaml(updated);
                    setAppliedYaml(updated);
                  }}
                >
                  <Save size={12} />
                  <span>Apply</span>
                </button>
              </div>
            </div>

            <div className="kb-yaml-editor-body">
              <div className="kb-yaml-gutter" aria-hidden="true">
                {Array.from({ length: lineCount }, (_, idx) => (
                  <span key={idx}>{idx + 1}</span>
                ))}
              </div>
              <textarea
                className="kb-yaml-textarea"
                aria-label="YAML source for Deployment/payment-worker"
                spellCheck={false}
                value={draftYaml}
                rows={lineCount}
                onChange={e => setDraftYaml(e.target.value)}
              />
            </div>
          </div>
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
