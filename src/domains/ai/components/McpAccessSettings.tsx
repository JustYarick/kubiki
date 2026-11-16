import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { CheckboxRow } from '../../../components/ui/Checkbox';
import { Input } from '../../../components/ui/Input';
import { useAiStore } from '../store';
import { agentError, agentTransport, desktopAiAvailable } from '../transport';
import { normalizeMcpPolicy, syncSharedPolicyFields, type AgentPolicy, type McpHttpStatus, type OptionalToolMode } from '../types';
import { DataSelect, OptionalToolRow } from './AgentSettings';
import { McpToolsPanel } from './McpToolsPanel';
import { Select } from '../../../components/ui/Select';
import { useResourceStore } from '../../../state/resource_store';

const DEFAULT_MCP_PORT = 3847;

export function McpAccessSettings() {
  const settings = useAiStore(s => s.settings);
  const saving = useAiStore(s => s.saving);
  const activeId = useAiStore(s => s.activeId);
  const activeConversation = useAiStore(s => s.conversations.find(c => c.id === activeId));
  const external = settings.runtime && settings.runtime !== 'kubiki';
  const [draft, setDraft] = useState(normalizeMcpPolicy(settings.mcpPolicy));
  const [serverEnabledDraft, setServerEnabledDraft] = useState(Boolean(settings.mcpServer?.enabled));
  const [requireAuthDraft, setRequireAuthDraft] = useState(Boolean(settings.mcpServer?.requireAuth));
  const [portDraft, setPortDraft] = useState(String(settings.mcpServer?.port ?? DEFAULT_MCP_PORT));
  const [httpStatus, setHttpStatus] = useState<McpHttpStatus | null>(null);
  const [revealToken, setRevealToken] = useState(false);
  const [configuringClient, setConfiguringClient] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const crds = useResourceStore(s => s.resources.CustomResourceDefinition);
  const crdList = crds ? [...crds.values()] : [];
  const hasArgoCd = crdList.some(c => c.name?.includes('argoproj.io'));
  const hasFlux = crdList.some(c => c.name?.includes('toolkit.fluxcd.io') || c.name?.includes('fluxcd.io'));

  useEffect(() => {
    setDraft(normalizeMcpPolicy(settings.mcpPolicy));
  }, [settings.mcpPolicy]);

  useEffect(() => {
    setServerEnabledDraft(Boolean(settings.mcpServer?.enabled));
  }, [settings.mcpServer?.enabled]);

  useEffect(() => {
    setRequireAuthDraft(Boolean(settings.mcpServer?.requireAuth));
  }, [settings.mcpServer?.requireAuth]);

  useEffect(() => {
    setPortDraft(String(settings.mcpServer?.port ?? DEFAULT_MCP_PORT));
  }, [settings.mcpServer?.port]);

  async function refreshHttpStatus(reveal = revealToken) {
    if (!desktopAiAvailable()) return;
    try {
      const next = await agentTransport.mcpHttpStatus(reveal);
      setHttpStatus(next);
    } catch {
      /* desktop status unavailable in browser preview */
    }
  }

  useEffect(() => {
    void refreshHttpStatus(revealToken);
  }, [settings.mcpServer?.enabled, settings.mcpServer?.port, settings.mcpServer?.requireAuth, revealToken]);

  async function persist(next: AgentPolicy, msg = 'Cluster tool access applied live to MCP.') {
    setDraft(next);
    setError('');
    setMessage('');
    if (!desktopAiAvailable()) return;
    try {
      const cur = useAiStore.getState().settings;
      const nextMcp: AgentPolicy = { ...next, alwaysAsk: [], confirmReads: false, rules: [] };
      await useAiStore.getState().save({
        ...cur,
        mcpPolicy: nextMcp,
        policy: syncSharedPolicyFields(nextMcp, cur.policy),
      });
      setMessage(msg);
    } catch (e) {
      setError(agentError(e));
    }
  }

  async function persistIntegration(patch: Partial<Pick<AgentPolicy, 'helm' | 'argocd' | 'flux'>>) {
    setError('');
    setMessage('');
    const nextPolicy = { ...useAiStore.getState().settings.policy, ...patch };
    if (!desktopAiAvailable()) return;
    try {
      const cur = useAiStore.getState().settings;
      await useAiStore.getState().save({ ...cur, policy: nextPolicy });
      setMessage('Integration settings saved.');
    } catch (e) {
      setError(agentError(e));
    }
  }

  async function save() {
    await persist(draft, 'Cluster tool access saved and applied live.');
  }

  async function updateMcpServer(enabled: boolean, requireAuth = requireAuthDraft, portValue = portDraft) {
    setError('');
    setMessage('');
    const parsedPort = Number(portValue);
    if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
      setError('MCP server port must be an integer between 1024 and 65535.');
      return;
    }
    setServerEnabledDraft(enabled);
    setRequireAuthDraft(requireAuth);
    if (!desktopAiAvailable()) return;
    try {
      const cur = useAiStore.getState().settings;
      await useAiStore.getState().save({
        ...cur,
        mcpServer: { enabled, port: parsedPort, requireAuth },
      });
      await refreshHttpStatus(revealToken);
      setMessage(enabled ? `Desktop MCP HTTP server listening on 127.0.0.1:${parsedPort}/mcp.` : 'Desktop MCP HTTP server stopped.');
    } catch (e) {
      setServerEnabledDraft(Boolean(useAiStore.getState().settings.mcpServer?.enabled));
      setRequireAuthDraft(Boolean(useAiStore.getState().settings.mcpServer?.requireAuth));
      await refreshHttpStatus(revealToken);
      setError(agentError(e));
    }
  }

  async function autoConfigure(client: 'opencode' | 'claude' | 'cursor') {
    if (!desktopAiAvailable()) return;
    setError('');
    setMessage('');
    setConfiguringClient(client);
    try {
      const result = await agentTransport.mcpAutoConfigure(client);
      setServerEnabledDraft(true);
      await useAiStore.getState().load();
      await refreshHttpStatus(revealToken);
      const label = client === 'opencode' ? 'OpenCode' : client === 'claude' ? 'Claude Code' : 'Cursor';
      setMessage(`Configured ${label} in ${result.configPath} (${result.url}).`);
    } catch (e) {
      setError(agentError(e));
    } finally {
      setConfiguringClient(null);
    }
  }

  async function regenerateToken() {
    if (!desktopAiAvailable()) return;
    setError('');
    setMessage('');
    try {
      const next = await agentTransport.mcpHttpRegenerateToken();
      setHttpStatus(next);
      setRevealToken(true);
      setMessage('Generated a new MCP bearer token. Re-run Auto-Configure or update external client configs.');
    } catch (e) {
      setError(agentError(e));
    }
  }

  async function copyConfig(kind: 'opencode_json' | 'opencode_cli' | 'claude_cli') {
    if (!desktopAiAvailable()) return;
    setError('');
    try {
      const status = requireAuthDraft
        ? (httpStatus?.token ? httpStatus : await agentTransport.mcpHttpStatus(true))
        : httpStatus;
      if (requireAuthDraft && httpStatus?.token == null && revealToken && status) setHttpStatus(status);
      const url = status?.url ?? displayUrl;
      const token = status?.token ?? '<token>';
      const openCodeEntry: Record<string, unknown> = {
        type: 'remote',
        url,
        enabled: true,
      };
      if (requireAuthDraft) {
        openCodeEntry.headers = { Authorization: `Bearer ${token}` };
        openCodeEntry.oauth = false;
      }
      const text = kind === 'opencode_json'
        ? JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            mcp: { servers: { kubiki: openCodeEntry } },
          }, null, 2)
        : kind === 'opencode_cli'
          ? requireAuthDraft
            ? `opencode mcp add --global --url ${url} --header "Authorization=Bearer ${token}" kubiki`
            : `opencode mcp add --global --url ${url} kubiki`
          : requireAuthDraft
            ? `claude mcp add --transport http --header "Authorization: Bearer ${token}" kubiki ${url}`
            : `claude mcp add --transport http kubiki ${url}`;
      await navigator.clipboard.writeText(text);
      setMessage(kind === 'opencode_json' ? 'Copied OpenCode config JSON to clipboard.' : 'Copied CLI command to clipboard.');
    } catch (e) {
      setError(agentError(e));
    }
  }

  const serverEnabled = serverEnabledDraft;
  const activePhase = (external || serverEnabled) ? (settings.mcpPhase ?? 'plan') : (activeConversation?.phase ?? 'plan');
  const displayPort = httpStatus?.port ?? settings.mcpServer?.port ?? DEFAULT_MCP_PORT;
  const displayUrl = httpStatus?.url ?? `http://127.0.0.1:${displayPort}/mcp`;
  const displayToken = revealToken && httpStatus?.token ? httpStatus.token : '<click Reveal or Copy>';
  const snippetEntry: Record<string, unknown> = {
    type: 'remote',
    url: displayUrl,
    enabled: true,
  };
  if (requireAuthDraft) {
    snippetEntry.headers = { Authorization: `Bearer ${displayToken}` };
    snippetEntry.oauth = false;
  }
  const openCodeSnippet = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: { servers: { kubiki: snippetEntry } },
  }, null, 2);

  const policy = settings.policy;
  const integrationVal = (v: unknown): OptionalToolMode =>
    typeof v === 'string' ? (v as OptionalToolMode) : v ? 'enabled' : 'disabled';

  return (
    <section className="ai-settings-section" aria-label="Kubiki MCP access">
      <div className="ai-section-header">
        <div>
          <h3>Cluster tools (MCP)</h3>
          <p className="ai-help">
            Local MCP server, live tool permissions, and cluster integrations. Applies in real time.
          </p>
        </div>
        <Button size="md" variant="primary" disabled={saving || !desktopAiAvailable()} onClick={() => void save()}>
          Save cluster access
        </Button>
      </div>

      <div className="ai-settings-card flex flex-col gap-3">
        <div className="ai-card-header mb-0">
          <h4>Always-on Desktop MCP Server (Local HTTP)</h4>
          <span
            className={`ai-status-pill ${httpStatus?.running ? 'is-active' : httpStatus?.error ? 'is-error' : ''}`}
            role="status"
          >
            {httpStatus?.running
              ? `Listening · ${displayPort}`
              : serverEnabled
                ? (httpStatus?.error ? 'Error' : 'Starting…')
                : 'Stopped'}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <CheckboxRow
            label="Keep MCP HTTP server running while Kubiki is open"
            checked={serverEnabled}
            disabled={saving || !desktopAiAvailable()}
            onChange={e => void updateMcpServer(e.target.checked)}
          />
          <CheckboxRow
            label="Require Bearer token (optional on 127.0.0.1)"
            checked={requireAuthDraft}
            disabled={saving || !desktopAiAvailable()}
            onChange={e => void updateMcpServer(serverEnabled, e.target.checked)}
          />
        </div>

        <p className="ai-help">
          Binds strictly to <code>127.0.0.1</code> with Host validation and browser <code>Origin</code> rejection, dynamically routing tool calls to whichever cluster &amp; namespace are active in Kubiki without dropping connections.
        </p>

        <div className="ai-field-row">
          <label className="ai-field w-32">
            Localhost port
            <Input
              aria-label="MCP HTTP port"
              type="number"
              min={1024}
              max={65535}
              value={portDraft}
              disabled={saving || !desktopAiAvailable()}
              onChange={e => setPortDraft(e.target.value)}
            />
          </label>
          <Button
            size="md"
            variant="secondary"
            disabled={saving || !desktopAiAvailable()}
            onClick={() => void updateMcpServer(serverEnabled)}
          >
            Apply port
          </Button>
        </div>

        <p className="ai-help font-mono text-[11px]" role="status">
          Status: {httpStatus?.running
            ? `Listening on ${displayUrl} · ${httpStatus.scope.context ? `Cluster: ${httpStatus.scope.context}` : 'No cluster connected yet'}`
            : serverEnabled
              ? (httpStatus?.error ? `Error: ${httpStatus.error}` : 'Starting…')
              : 'Stopped'}
        </p>
        {httpStatus?.error && <p role="alert" className="ai-error">{httpStatus.error}</p>}

        <div className="pt-2.5 border-t border-[var(--border-subtle)] flex flex-col gap-2">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">1-Click Client Auto-Configure</span>
          <div className="ai-form-line">
            <Button
              size="sm"
              variant="secondary"
              disabled={saving || configuringClient !== null || !desktopAiAvailable()}
              onClick={() => void autoConfigure('opencode')}
            >
              Auto-Configure OpenCode
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={saving || configuringClient !== null || !desktopAiAvailable()}
              onClick={() => void autoConfigure('claude')}
            >
              Auto-Configure Claude Code
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={saving || configuringClient !== null || !desktopAiAvailable()}
              onClick={() => void autoConfigure('cursor')}
            >
              Auto-Configure Cursor
            </Button>
          </div>
          <p className="ai-help">
            Safely adds or updates only the <code>kubiki</code> entry in <code>~/.config/opencode/opencode.json</code>, <code>~/.claude.json</code>, or <code>~/.cursor/mcp.json</code> without overwriting your other settings.
          </p>
        </div>

        <details className="pt-2 border-t border-[var(--border-subtle)]">
          <summary>Manual client config &amp; CLI commands</summary>
          <div className="flex flex-col gap-2.5">
            <div className="ai-form-line">
              {requireAuthDraft && (
                <Button size="sm" variant="secondary" disabled={!desktopAiAvailable()} onClick={() => setRevealToken(v => !v)}>
                  {revealToken ? 'Hide token' : 'Reveal token'}
                </Button>
              )}
              <Button size="sm" variant="secondary" disabled={!desktopAiAvailable()} onClick={() => void copyConfig('opencode_json')}>
                Copy OpenCode JSON
              </Button>
              <Button size="sm" variant="secondary" disabled={!desktopAiAvailable()} onClick={() => void copyConfig('opencode_cli')}>
                Copy OpenCode CLI
              </Button>
              <Button size="sm" variant="secondary" disabled={!desktopAiAvailable()} onClick={() => void copyConfig('claude_cli')}>
                Copy Claude CLI
              </Button>
              {requireAuthDraft && (
                <Button size="sm" variant="secondary" disabled={saving || !desktopAiAvailable()} onClick={() => void regenerateToken()}>
                  Regenerate token
                </Button>
              )}
            </div>
            <pre className="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[11px] font-mono overflow-x-auto select-all m-0">
              {openCodeSnippet}
            </pre>
          </div>
        </details>
      </div>

      {(external || serverEnabled) && (
        <div className="ai-settings-card">
          <div className="ai-setting-row">
            <div className="ai-setting-row-label">
              <div className="ai-setting-row-title">MCP server phase</div>
              <p className="ai-help">Enforced by Kubiki across all external MCP clients independently of their own mode.</p>
            </div>
            <div className="ai-setting-row-control">
              <Select
                aria-label="MCP server phase"
                className="ide-select w-36"
                disabled={saving}
                value={activePhase === 'plan' ? 'plan' : 'action'}
                onChange={e => {
                  void useAiStore.getState().save({
                    ...useAiStore.getState().settings,
                    mcpPhase: e.target.value as 'plan' | 'action',
                  }).catch(err => setError(agentError(err)));
                }}
              >
                <option value="plan">Plan</option>
                <option value="action">Action</option>
              </Select>
            </div>
          </div>
        </div>
      )}

      <McpToolsPanel
        policy={draft}
        disabled={saving}
        onChange={next => void persist(next)}
        currentPhase={activePhase}
        title="Live tool permissions"
        subtitle="Configure which tools are permitted during Plan vs Action"
      />

      {!external && (
        <div className="ai-settings-card">
          <div className="ai-card-header">
            <div>
              <h4>Cluster integrations</h4>
              <p className="ai-help">Auto checks for Argo CD and Flux APIs in the selected cluster.</p>
            </div>
          </div>
          <div className="flex flex-col">
            <OptionalToolRow
              title="Helm"
              description="Read releases, values and revision history."
              value={integrationVal(policy.helm)}
              onChange={helm => void persistIntegration({ helm })}
              disabled={saving}
            />
            <OptionalToolRow
              title="Argo CD"
              description="Read applications, sync status and source repositories."
              detected={hasArgoCd}
              value={integrationVal(policy.argocd)}
              onChange={argocd => void persistIntegration({ argocd })}
              disabled={saving}
            />
            <OptionalToolRow
              title="Flux"
              description="Read Kustomizations, HelmReleases and GitRepositories."
              detected={hasFlux}
              value={integrationVal(policy.flux)}
              onChange={flux => void persistIntegration({ flux })}
              disabled={saving}
            />
          </div>
        </div>
      )}

      {external && (
        <>
          <div className="ai-settings-card flex flex-col gap-3">
            <h4 className="mb-0">Detailed Data Access Levels</h4>
            <div className="ai-form-grid-3">
              <DataSelect
                label="Secrets"
                title="Control exposure of Secret keys and payloads to the agent"
                value={draft.secrets}
                onChange={secrets => void persist({ ...draft, secrets })}
              />
              <DataSelect
                label="ConfigMaps"
                title="Control whether ConfigMap data contents or metadata only are readable"
                value={draft.configMaps}
                onChange={configMaps => void persist({ ...draft, configMaps })}
              />
              <DataSelect
                label="Custom resources"
                title="Control access permissions for installed Custom Resource Definitions (CRDs)"
                value={draft.customResources}
                onChange={customResources => void persist({ ...draft, customResources })}
              />
            </div>
            <div className="ai-setting-row">
              <div className="ai-setting-row-label">
                <div className="ai-setting-row-title">Maximum replicas</div>
                <p className="ai-help">Maximum allowed replica count for workload scaling operations.</p>
              </div>
              <div className="ai-setting-row-control">
                <Input
                  type="number"
                  className="w-28"
                  min={0}
                  max={10000}
                  value={draft.maxReplicas}
                  onChange={e => setDraft({ ...draft, maxReplicas: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>

          <details className="ai-settings-card">
            <summary title="Click to expand or collapse cluster context, namespace, and field exclusion rules">
              Cluster context, namespace, and field rules
            </summary>
            <div className="flex flex-col gap-3">
              <div className="ai-form-grid">
                <label className="ai-field" title="One context name per line (* matches any cluster context)">
                  Allowed contexts
                  <textarea
                    className="ide-textarea"
                    rows={3}
                    placeholder={'e.g. minikube\n* (all clusters)'}
                    value={draft.contexts.join('\n')}
                    onChange={e => setDraft({ ...draft, contexts: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
                  />
                </label>
                <label className="ai-field" title="One namespace per line (* matches any namespace)">
                  Allowed namespaces
                  <textarea
                    className="ide-textarea"
                    rows={3}
                    placeholder={'e.g. default\nproduction'}
                    value={draft.namespaces.join('\n')}
                    onChange={e => setDraft({ ...draft, namespaces: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
                  />
                </label>
              </div>
              <label className="ai-field" title="JSON/YAML paths to redact (e.g. /spec/template/spec/containers/0/env)">
                Fields to exclude
                <textarea
                  className="ide-textarea font-mono"
                  rows={3}
                  placeholder={'/spec/template/spec/containers/0/env\n/data/private.key'}
                  value={draft.deniedPaths.join('\n')}
                  onChange={e => setDraft({ ...draft, deniedPaths: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
                />
              </label>
            </div>
          </details>
        </>
      )}

      {message && <p role="status" className="ai-help text-emerald-400">{message}</p>}
      {error && <p role="alert" className="ai-error">{error}</p>}
    </section>
  );
}
