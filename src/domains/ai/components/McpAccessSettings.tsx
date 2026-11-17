import { useEffect, useRef, useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { CheckboxRow } from '../../../components/ui/Checkbox';
import { Input } from '../../../components/ui/Input';
import { useAiStore } from '../store';
import { agentError, agentTransport, desktopAiAvailable } from '../transport';
import {
  ensureMcpProfiles,
  resolveEffectiveMcpPolicy,
  summarizeMcpPolicy,
  updateAiMcpSettings,
  type AgentPolicy,
  type AgentSettingsResetAction,
  type AgentSettingsSaveAction,
  type McpHttpStatus,
  type McpProfile,
  type OptionalToolMode,
} from '../types';
import { DataSelect, OptionalToolRow } from './AgentSettings';
import { McpToolsPanel } from './McpToolsPanel';
import { useResourceStore } from '../../../state/resource_store';

const DEFAULT_MCP_PORT = 3847;

export function McpAccessSettings({
  onSaveActionChange,
  onResetActionChange,
}: {
  onSaveActionChange?: (action: AgentSettingsSaveAction | null) => void;
  onResetActionChange?: (action: AgentSettingsResetAction | null) => void;
} = {}) {
  const settings = useAiStore(s => s.settings);
  const saving = useAiStore(s => s.saving);
  const { profiles, activeId, activeProfile } = ensureMcpProfiles(settings);
  const effectivePolicy = resolveEffectiveMcpPolicy(settings, activeProfile);
  const effectiveSummary = summarizeMcpPolicy(effectivePolicy);

  const [nameDraft, setNameDraft] = useState(activeProfile.name);
  const [policyDraft, setPolicyDraft] = useState<AgentPolicy>(activeProfile.policy);
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

  const profileSignature = JSON.stringify([activeId, activeProfile.name, activeProfile.inheritShared, activeProfile.policy]);
  const lastProfileSignature = useRef(profileSignature);
  useEffect(() => {
    if (lastProfileSignature.current !== profileSignature) {
      lastProfileSignature.current = profileSignature;
      setNameDraft(activeProfile.name);
      setPolicyDraft(activeProfile.policy);
    }
  }, [profileSignature, activeProfile.name, activeProfile.policy]);

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

  async function persistProfilePolicy(nextPolicy: AgentPolicy, msg = 'MCP profile updated live.') {
    setPolicyDraft(nextPolicy);
    setError('');
    setMessage('');
    if (!desktopAiAvailable()) return;
    try {
      const cur = useAiStore.getState().settings;
      const ensured = ensureMcpProfiles(cur);
      const target = ensured.activeProfile;
      const trimmedName = nameDraft.trim() || target.name;
      const next = target.inheritShared
        ? updateAiMcpSettings(cur, {
            sharedPolicy: nextPolicy,
            profiles: ensured.profiles.map(p => (p.id === target.id ? { ...p, name: trimmedName } : p)),
          })
        : updateAiMcpSettings(cur, {
            profiles: ensured.profiles.map(p =>
              p.id === target.id ? { ...p, name: trimmedName, policy: nextPolicy } : p,
            ),
          });
      await useAiStore.getState().save(next);
      setMessage(msg);
    } catch (e) {
      setError(agentError(e));
    }
  }

  async function saveClusterAccess() {
    await persistProfilePolicy(policyDraft, 'Cluster access and MCP profile saved.');
  }
  const saveClusterAccessRef = useRef(saveClusterAccess);
  saveClusterAccessRef.current = saveClusterAccess;
  const isClusterDirty =
    policyDraft.maxReplicas !== activeProfile.policy.maxReplicas
    || JSON.stringify(policyDraft.contexts) !== JSON.stringify(activeProfile.policy.contexts)
    || JSON.stringify(policyDraft.namespaces) !== JSON.stringify(activeProfile.policy.namespaces)
    || JSON.stringify(policyDraft.deniedPaths) !== JSON.stringify(activeProfile.policy.deniedPaths);

  async function resetMcpDefaults() {
    setError('');
    setMessage('');
    if (!desktopAiAvailable()) return;
    try {
      const cur = useAiStore.getState().settings;
      const resetSeed = { ...cur, mcpProfiles: [], activeMcpProfileId: undefined, mcpServer: { enabled: false, port: DEFAULT_MCP_PORT, requireAuth: false } };
      const ensuredDefaults = ensureMcpProfiles(resetSeed);
      await useAiStore.getState().save({
        ...resetSeed,
        mcpProfiles: ensuredDefaults.profiles,
        activeMcpProfileId: 'read-only',
      });
      setPortDraft(String(DEFAULT_MCP_PORT));
      setServerEnabledDraft(false);
      setRequireAuthDraft(false);
      await refreshHttpStatus(false);
      setMessage('MCP settings and profiles restored to defaults.');
    } catch (e) {
      setError(agentError(e));
    }
  }
  const resetMcpDefaultsRef = useRef(resetMcpDefaults);
  resetMcpDefaultsRef.current = resetMcpDefaults;

  useEffect(() => {
    onSaveActionChange?.({
      label: 'Save cluster access',
      ariaLabel: 'Save cluster access',
      dirty: isClusterDirty,
      disabled: saving || !desktopAiAvailable(),
      loading: saving,
      onSave: () => void saveClusterAccessRef.current(),
    });
    return () => {
      onSaveActionChange?.(null);
    };
  }, [onSaveActionChange, isClusterDirty, saving]);

  useEffect(() => {
    onResetActionChange?.({
      label: 'Reset MCP defaults',
      ariaLabel: 'Reset MCP defaults',
      disabled: saving || !desktopAiAvailable(),
      onReset: () => void resetMcpDefaultsRef.current(),
    });
    return () => {
      onResetActionChange?.(null);
    };
  }, [onResetActionChange, saving]);

  async function selectProfile(profileId: string) {
    setError('');
    setMessage('');
    if (!desktopAiAvailable()) return;
    try {
      const cur = useAiStore.getState().settings;
      await useAiStore.getState().save(updateAiMcpSettings(cur, { activeProfileId: profileId }));
    } catch (e) {
      setError(agentError(e));
    }
  }

  async function updateActiveProfileMeta(patch: Partial<McpProfile>, msg: string) {
    setError('');
    setMessage('');
    if (!desktopAiAvailable()) return;
    try {
      const cur = useAiStore.getState().settings;
      const ensured = ensureMcpProfiles(cur);
      const nextProfiles = ensured.profiles.map(p =>
        p.id === ensured.activeId ? { ...p, ...patch } : p,
      );
      await useAiStore.getState().save(updateAiMcpSettings(cur, { profiles: nextProfiles }));
      setMessage(msg);
    } catch (e) {
      setError(agentError(e));
    }
  }

  async function createProfile(mode: 'blank-readonly' | 'duplicate') {
    setError('');
    setMessage('');
    if (!desktopAiAvailable()) return;
    const cur = useAiStore.getState().settings;
    const ensured = ensureMcpProfiles(cur);
    if (ensured.profiles.length >= 16) {
      setError('Maximum of 16 MCP profiles reached.');
      return;
    }
    const usedIds = new Set(ensured.profiles.map(p => p.id));
    let n = ensured.profiles.length + 1;
    let nextId = mode === 'duplicate' ? `${ensured.activeId}-copy` : `profile-${n}`;
    while (usedIds.has(nextId)) {
      n += 1;
      nextId = `profile-${n}`;
    }
    const nextName = mode === 'duplicate'
      ? `${ensured.activeProfile.name} copy`.slice(0, 64)
      : `Custom ${n}`;
    const nextPolicy: AgentPolicy = mode === 'duplicate'
      ? { ...ensured.activeProfile.policy }
      : {
          ...ensured.activeProfile.policy,
          writes: [],
          readOnly: false,
          confirmReads: false,
          alwaysAsk: [],
        };
    try {
      const next = updateAiMcpSettings(cur, {
        profiles: [
          ...ensured.profiles,
          { id: nextId, name: nextName, inheritShared: false, policy: nextPolicy },
        ],
        activeProfileId: nextId,
      });
      await useAiStore.getState().save(next);
      setMessage(`Created MCP profile "${nextName}".`);
    } catch (e) {
      setError(agentError(e));
    }
  }

  async function deleteActiveProfile() {
    setError('');
    setMessage('');
    if (!desktopAiAvailable()) return;
    const cur = useAiStore.getState().settings;
    const ensured = ensureMcpProfiles(cur);
    if (ensured.profiles.length <= 1) return;
    const remaining = ensured.profiles.filter(p => p.id !== ensured.activeId);
    try {
      await useAiStore.getState().save(
        updateAiMcpSettings(cur, {
          profiles: remaining,
          activeProfileId: remaining.find(p => p.id === 'read-only')?.id ?? remaining[0].id,
        }),
      );
      setMessage(`Removed MCP profile "${ensured.activeProfile.name}".`);
    } catch (e) {
      setError(agentError(e));
    }
  }

  async function updateMcpServer(
    enabled: boolean,
    requireAuth = requireAuthDraft,
    portValue = portDraft,
  ) {
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
      await useAiStore.getState().save(
        updateAiMcpSettings(cur, {
          mcpServer: { enabled, port: parsedPort, requireAuth },
        }),
      );
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

  const integrationVal = (v: unknown): OptionalToolMode =>
    typeof v === 'string' ? (v as OptionalToolMode) : v ? 'enabled' : 'disabled';

  return (
    <section className="ai-settings-section" aria-label="Kubiki MCP access">
      <div className="ai-section-header">
        <div>
          <h3>Cluster tools (MCP)</h3>
          <p className="ai-help">
            Local Desktop MCP server, customizable access profiles, and shared integrations. External clients run without Plan/Action gating.
          </p>
        </div>
      </div>

      <div className="ai-settings-card flex flex-col gap-3">
        <div className="ai-card-header mb-0">
          <h4>Always-on Desktop MCP Server (Local HTTP)</h4>
          <div className="flex items-center gap-1.5">
            <span
              className={`ai-status-pill font-mono ${effectiveSummary.isReadOnly ? 'is-active' : 'is-warn'}`}
              title={effectiveSummary.isReadOnly ? 'Active MCP profile is read-only' : `Permitted writes: ${effectiveSummary.allowedWrites.join(', ')}`}
            >
              {activeProfile.name} · {effectiveSummary.isReadOnly ? 'RO' : 'RW'}
            </span>
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

      <div id="mcp-profiles-section" className="ai-settings-card flex flex-col gap-3">
        <div className="ai-card-header mb-0">
          <div>
            <h4>MCP Access Profiles</h4>
            <p className="ai-help">
              Switch between Shared Action permissions, Read-only, or custom profiles (e.g. Read-only with Restart). Rename and tailor any profile.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="secondary" disabled={saving || !desktopAiAvailable()} onClick={() => void createProfile('blank-readonly')}>
              <Plus size={12} aria-hidden="true" />
              New profile
            </Button>
            <Button size="sm" variant="secondary" disabled={saving || !desktopAiAvailable()} onClick={() => void createProfile('duplicate')}>
              <Copy size={12} aria-hidden="true" />
              Duplicate
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={saving || profiles.length <= 1 || !desktopAiAvailable()}
              onClick={() => void deleteActiveProfile()}
              aria-label="Delete MCP profile"
            >
              <Trash2 size={12} aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="MCP profiles">
          {profiles.map(p => {
            const eff = resolveEffectiveMcpPolicy(settings, p);
            const sum = summarizeMcpPolicy(eff);
            const selected = p.id === activeId;
            return (
              <Button
                key={p.id}
                size="md"
                variant={selected ? 'primary' : 'secondary'}
                role="tab"
                aria-selected={selected}
                disabled={saving}
                onClick={() => void selectProfile(p.id)}
              >
                <span>{p.name}</span>
                <span className="font-mono text-[10px] opacity-90">{sum.isReadOnly ? 'RO' : 'RW'}</span>
              </Button>
            );
          })}
        </div>

        <div className="pt-2.5 border-t border-[var(--border-subtle)] flex flex-wrap items-end gap-3">
          <label className="ai-field w-56">
            Profile name
            <Input
              aria-label="MCP profile name"
              value={nameDraft}
              maxLength={64}
              disabled={saving || !desktopAiAvailable()}
              onChange={e => setNameDraft(e.target.value)}
            />
          </label>
          <Button
            size="md"
            variant="secondary"
            disabled={saving || !desktopAiAvailable() || !nameDraft.trim() || nameDraft.trim() === activeProfile.name}
            onClick={() => void updateActiveProfileMeta({ name: nameDraft.trim() }, 'Renamed MCP profile.')}
          >
            Rename
          </Button>
          <div className="flex-1 min-w-[200px] flex items-center justify-end gap-2">
            <CheckboxRow
              label="Follow shared Permissions & Scope"
              title="When checked, this profile stays synchronized 1:1 with Permissions and Scope & rules"
              checked={activeProfile.inheritShared}
              disabled={saving || !desktopAiAvailable()}
              onChange={e => void updateActiveProfileMeta(
                {
                  inheritShared: e.target.checked,
                  policy: e.target.checked ? settings.policy : policyDraft,
                },
                e.target.checked ? 'Profile now follows shared Permissions.' : 'Profile detached for custom per-profile rules.',
              )}
            />
          </div>
        </div>
      </div>

      <McpToolsPanel
        policy={policyDraft}
        disabled={saving}
        modeScope="general"
        onChange={next => void persistProfilePolicy(next)}
        title={`Tools & permissions · ${activeProfile.name}`}
        subtitle={
          activeProfile.inheritShared
            ? 'Synced with Shared Permissions. Changes apply live to both Kubiki Agent and this MCP profile.'
            : 'Custom profile rules (e.g. allow only Restart). Changes apply live to MCP without altering Shared Permissions.'
        }
      />

      <div className="ai-settings-card flex flex-col gap-3">
        <h4 className="mb-0">Data Access Levels</h4>
        <div className="ai-form-grid-3">
          <DataSelect
            label="Secrets"
            title="Control exposure of Secret keys and payloads to MCP"
            value={policyDraft.secrets}
            onChange={secrets => void persistProfilePolicy({ ...policyDraft, secrets })}
          />
          <DataSelect
            label="ConfigMaps"
            title="Control whether ConfigMap data contents or metadata only are readable"
            value={policyDraft.configMaps}
            onChange={configMaps => void persistProfilePolicy({ ...policyDraft, configMaps })}
          />
          <DataSelect
            label="Custom resources"
            title="Control access permissions for installed Custom Resource Definitions (CRDs)"
            value={policyDraft.customResources}
            onChange={customResources => void persistProfilePolicy({ ...policyDraft, customResources })}
          />
        </div>
        <div className="ai-setting-row">
          <div className="ai-setting-row-label">
            <div className="ai-setting-row-title">Maximum replicas</div>
            <p className="ai-help">Maximum allowed replica count for workload scaling operations.</p>
          </div>
          <div className="ai-setting-row-control">
            <Input
              aria-label="MCP maximum replicas"
              type="number"
              className="w-28"
              min={0}
              max={10000}
              value={policyDraft.maxReplicas}
              onChange={e => setPolicyDraft({ ...policyDraft, maxReplicas: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

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
            value={integrationVal(policyDraft.helm)}
            onChange={helm => void persistProfilePolicy({ ...policyDraft, helm }, 'Integration settings saved.')}
            disabled={saving}
          />
          <OptionalToolRow
            title="Argo CD"
            description="Read applications, sync status and source repositories."
            detected={hasArgoCd}
            value={integrationVal(policyDraft.argocd)}
            onChange={argocd => void persistProfilePolicy({ ...policyDraft, argocd }, 'Integration settings saved.')}
            disabled={saving}
          />
          <OptionalToolRow
            title="Flux"
            description="Read Kustomizations, HelmReleases and GitRepositories."
            detected={hasFlux}
            value={integrationVal(policyDraft.flux)}
            onChange={flux => void persistProfilePolicy({ ...policyDraft, flux }, 'Integration settings saved.')}
            disabled={saving}
          />
        </div>
      </div>

      <details className="ai-settings-card">
        <summary title="Click to expand or collapse cluster context, namespace, and field exclusion rules">
          Cluster context, namespace, and field overrides
        </summary>
        <div className="flex flex-col gap-3">
          <div className="ai-form-grid">
            <label className="ai-field" title="One context name per line (* matches any cluster context)">
              Allowed contexts
              <textarea
                className="ide-textarea"
                rows={3}
                placeholder={'e.g. minikube\n* (all clusters)'}
                value={policyDraft.contexts.join('\n')}
                onChange={e => setPolicyDraft({ ...policyDraft, contexts: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
              />
            </label>
            <label className="ai-field" title="One namespace per line (* matches any namespace)">
              Allowed namespaces
              <textarea
                className="ide-textarea"
                rows={3}
                placeholder={'e.g. default\nproduction'}
                value={policyDraft.namespaces.join('\n')}
                onChange={e => setPolicyDraft({ ...policyDraft, namespaces: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
              />
            </label>
          </div>
          <label className="ai-field" title="JSON/YAML paths to redact (e.g. /spec/template/spec/containers/0/env)">
            Fields to exclude
            <textarea
              className="ide-textarea font-mono"
              rows={3}
              placeholder={'/spec/template/spec/containers/0/env\n/data/private.key'}
              value={policyDraft.deniedPaths.join('\n')}
              onChange={e => setPolicyDraft({ ...policyDraft, deniedPaths: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
            />
          </label>
          <p className="ai-help">
            Click <strong>Save cluster access</strong> next to Done to persist context, namespace, replica limit, or excluded field edits. Resource rules from Scope &amp; rules are also enforced on MCP.
          </p>
        </div>
      </details>

      {message && <p role="status" className="ai-help text-emerald-400">{message}</p>}
      {error && <p role="alert" className="ai-error">{error}</p>}
    </section>
  );
}
