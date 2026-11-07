import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { CheckboxRow } from '../../../components/ui/Checkbox';
import { useResourceStore } from '../../../state/resource_store';
import { invalidateAiConversations, useAiStore } from '../store';
import { agentError, agentTransport, desktopAiAvailable } from '../transport';
import { PROVIDER_PRESETS, WRITE_OPERATIONS, type AgentPolicy, type AiSettings, type DataAccess, type ModelInfo, type OptionalToolMode, type ProviderProfile, type ProviderProtocol, type WriteOperation } from '../types';
import { PERMISSION_PROFILES, permissionProfile } from '../permission_profiles';
import { HistorySettings, PolicyPreview } from './PreferencePanels';
import { AgentEnvironmentSettings } from './AgentEnvironmentSettings';
import { AgentRuntimeSettings } from './AgentRuntimeSettings';
import { McpAccessSettings } from './McpAccessSettings';
import '../ai.css';

const protocolNames: Record<ProviderProtocol, string> = {
  responses: 'OpenAI Responses', openai_compatible: 'OpenAI-compatible chat', anthropic: 'Anthropic Messages', ollama: 'Ollama',
};
const EMPTY_MODELS: ModelInfo[] = [];

export const AI_SETTINGS_PAGES = [
  { id: 'agent', label: 'Agent' },
  { id: 'mcp', label: 'Cluster tools & data' },
  { id: 'providers', label: 'Connections & models' },
  { id: 'confirmations', label: 'Confirmations' },
  { id: 'access', label: 'Data access' },
  { id: 'scope', label: 'Scope & rules' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'environment', label: 'Skills' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'history', label: 'History' },
] as const;
export type AgentSettingsPage = typeof AI_SETTINGS_PAGES[number]['id'];

export function availableAiSettingsPages(settings: Pick<AiSettings, 'runtime'>) {
  return AI_SETTINGS_PAGES.filter(item => (settings.runtime ?? 'kubiki') !== 'kubiki' ? item.id === 'agent' || item.id === 'mcp' : item.id !== 'mcp');
}

export interface AgentSettingsHandle {
  save: () => Promise<boolean>;
}

export interface AgentSettingsProps {
  section?: 'providers' | 'permissions' | 'all';
  page?: AgentSettingsPage;
  hideNavigation?: boolean;
  onStatusChange?: (status: { message?: string; error?: string; saving?: boolean }) => void;
}

export const AgentSettings = forwardRef<AgentSettingsHandle, AgentSettingsProps>(function AgentSettings(
  { section = 'all', page: controlledPage, hideNavigation = false, onStatusChange },
  ref,
) {
  const [selectedPage, setSelectedPage] = useState<AgentSettingsPage>(section === 'permissions' ? 'access' : 'agent');
  const settings = useAiStore(s=>s.settings);
  const pages = availableAiSettingsPages(settings);
  const requestedPage = controlledPage ?? selectedPage;
  const page = pages.some(item=>item.id===requestedPage) ? requestedPage : 'agent';
  const policyPage = page !== 'providers' && page !== 'history' && page !== 'environment' && page !== 'agent' && page !== 'mcp';
  const loaded = useAiStore(s => s.loaded);
  const loading = useAiStore(s => s.loading);
  const error = useAiStore(s => s.error);
  const load = useAiStore(s => s.load);
  const policyCommitRef = useRef<(() => Promise<boolean>) | null>(null);

  useEffect(() => { void load(); }, [load]);

  useImperativeHandle(ref, () => ({
    save: async () => {
      if (policyCommitRef.current) {
        return policyCommitRef.current();
      }
      return true;
    },
  }), []);

  return <div className="ai-settings">
    {!desktopAiAvailable() && <p className="ai-notice">AI connections and cluster tools require the desktop app. This preview sends no cluster data and stores no API keys.</p>}
    {loading && <p role="status">Loading AI settings…</p>}
    {error && <div role="alert" className="ai-error">{error} <Button size="sm" onClick={() => void load()}>Reload settings</Button></div>}
    {loaded && <div className={hideNavigation ? undefined : "ai-settings-layout"}>
      {!hideNavigation && <nav className="ai-settings-navigation" aria-label="AI settings sections">
        {pages.map(item => <button type="button" key={item.id} aria-current={page === item.id ? 'page' : undefined} onClick={() => setSelectedPage(item.id)}>{item.label}</button>)}
      </nav>}
      <div className="ai-settings-content">
      {page==='agent' && <AgentRuntimeSettings />}
      {page==='mcp' && <McpAccessSettings />}
      {(settings.runtime ?? 'kubiki')==='kubiki' && <>
      <div style={{ display: page === 'providers' ? undefined : 'none' }}><ProviderSettings /></div>
      <div style={{ display: page === 'history' ? undefined : 'none' }}><HistorySettings /></div>
      <div style={{ display: page === 'environment' ? undefined : 'none' }}><AgentEnvironmentSettings /></div>
      <div style={{ display: policyPage ? undefined : 'none' }}><PolicySettings page={page} commitRef={policyCommitRef} onStatusChange={onStatusChange} /></div>
      </>}
      </div>
    </div>}
  </div>;
});

function ProviderSettings() {
  const settings = useAiStore(s => s.settings);
  const credentials = useAiStore(s => s.credentials);
  const saving = useAiStore(s => s.saving);
  const save = useAiStore(s => s.save);
  const load = useAiStore(s => s.load);
  const refresh = useAiStore(s => s.refreshModels);
  const [selected, setSelected] = useState(settings.defaultProvider ?? settings.providers[0]?.id ?? '');
  const [profile, setProfile] = useState<ProviderProfile | null>(settings.providers.find(p => p.id === selected) ?? null);
  const [key, setKey] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [model, setModel] = useState(settings.defaultModel ?? '');
  const [options, setOptions] = useState(settings.options);
  const models = useAiStore(s => s.models[selected] ?? EMPTY_MODELS);
  const modelsLoading = useAiStore(s => s.modelLoading[selected]);
  const modelsError = useAiStore(s => s.modelErrors[selected]);
  const saved = settings.providers.find(p => p.id === selected);
  const dirty = !!profile && (!saved || profile.id !== saved.id || profile.name !== saved.name || profile.protocol !== saved.protocol || profile.baseUrl !== saved.baseUrl);

  function choose(id: string) {
    setSelected(id); setProfile(settings.providers.find(p => p.id === id) ?? null);
    setKey(''); setMessage(''); setError('');
    setModel(settings.defaultProvider === id ? settings.defaultModel ?? '' : '');
  }
  function add(preset = PROVIDER_PRESETS[0]) {
    const next = { ...preset, id: crypto.randomUUID() };
    setSelected(next.id); setProfile(next); setKey(''); setModel(''); setMessage(''); setError('');
  }
  async function commit() {
    if (!profile) return;
    setError(''); setMessage(''); setWorking(true);
    try {
      await save({ ...settings, providers: [...settings.providers.filter(p => p.id !== profile.id), profile], defaultProvider: settings.defaultProvider ?? profile.id,
        defaultModel: dirty && settings.defaultProvider === profile.id ? null : settings.defaultModel });
      if (key) { await agentTransport.credential(profile.id, key); invalidateAiConversations(); setKey(''); await load(); }
      setMessage('Provider saved. Load its models to choose one.');
      await refresh(profile.id);
    } catch (e) { setError(agentError(e)); }
    finally { setWorking(false); }
  }
  async function testConnection() {
    if (!profile) return;
    setError(''); setMessage(''); setWorking(true);
    try {
      const discovered = await agentTransport.testProvider(profile, key || undefined);
      if (!dirty) useAiStore.setState(state => ({ models: { ...state.models, [profile.id]: discovered } }));
      setMessage(`Connected. ${discovered.length} models available.`);
    } catch (e) { setError(agentError(e)); }
    finally { setWorking(false); }
  }
  async function remove() {
    if (!profile) return;
    setError('');
    try {
      await save({ ...settings, providers: settings.providers.filter(p => p.id !== profile.id), defaultProvider: settings.defaultProvider === profile.id ? null : settings.defaultProvider, defaultModel: settings.defaultProvider === profile.id ? null : settings.defaultModel });
      setProfile(null); setSelected(''); setKey(''); setModel('');
    } catch (e) { setError(agentError(e)); }
  }
  async function defaults() {
    setError(''); setMessage('');
    try { await save({ ...settings, defaultProvider: selected, defaultModel: model, options }); setMessage('Default model and options saved.'); }
    catch (e) { setError(agentError(e)); }
  }
  const modelInfo = models.find(m => m.id === model);
  useEffect(() => { if (modelInfo && model) void useAiStore.getState().inspectModel(selected, model); }, [selected, model, modelInfo]);

  return <section aria-label="AI provider connections" className="ai-settings-section">
    <div className="ai-section-header">
      <div>
        <h3>Connections &amp; models</h3>
        <p className="ai-help">Connect a cloud API or local server, then load its models.</p>
      </div>
    </div>
    <div className="ai-form-line">
      <label className="ai-field ai-grow">Saved connection<Select aria-label="Saved AI connection" className="ide-select" value={selected} onChange={e => choose(e.target.value)}>
        <option value="">Choose a connection</option>
        {settings.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        {profile && !saved && <option value={profile.id}>{profile.name} (unsaved)</option>}
      </Select></label>
      <Button size="sm" onClick={() => add()} disabled={saving || working}><Plus size={12} aria-hidden="true" />Add connection</Button>
    </div>
    {!profile && <div className="ai-presets" aria-label="AI provider presets">{PROVIDER_PRESETS.map(preset => <Button key={preset.name} size="sm" onClick={() => add(preset)}>{preset.name}</Button>)}</div>}
    {profile && <fieldset disabled={saving || working} className="ai-fieldset">
      <div className="ai-form-grid">
        <label className="ai-field">Connection preset<Select className="ide-select" aria-label="AI connection preset" value="" onChange={e => { const preset = PROVIDER_PRESETS.find(p => p.name === e.target.value); if (preset) { setProfile({ ...preset, id: profile.id }); setKey(''); setModel(''); } }}>
          <option value="">Choose preset…</option>{PROVIDER_PRESETS.map(p => <option key={p.name}>{p.name}</option>)}
        </Select></label>
        <label className="ai-field">Connection name<Input aria-label="AI connection name" value={profile.name} maxLength={120} onChange={e => setProfile({ ...profile, name: e.target.value })} /></label>
        <label className="ai-field">Protocol<Select className="ide-select" aria-label="AI protocol" value={profile.protocol} onChange={e => { setProfile({ ...profile, protocol: e.target.value as ProviderProtocol }); setModel(''); }}>
          {Object.entries(protocolNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </Select></label>
        <label className="ai-field">API URL<Input aria-label="AI API URL" value={profile.baseUrl} maxLength={2048} spellCheck={false} onChange={e => setProfile({ ...profile, baseUrl: e.target.value })} /></label>
      </div>
      <p className="ai-help">Include /v1 for OpenAI-compatible APIs. Use the server URL for Ollama. HTTP is allowed only on localhost.</p>
      <label className="ai-field">API key {credentials[profile.id] ? '(stored in OS credential store)' : '(optional for local servers)'}
        <Input aria-label="AI API key" type="password" autoComplete="new-password" value={key} placeholder={credentials[profile.id] ? 'Leave empty to keep the stored key' : 'Enter API key if required'} onChange={e => setKey(e.target.value)} />
      </label>
      <div className="ai-form-line">
        <Button size="sm" disabled={!desktopAiAvailable() || !profile.baseUrl.trim()} loading={working} onClick={() => void testConnection()}>Test connection</Button>
        <Button size="sm" variant="primary" disabled={!desktopAiAvailable() || !profile.name.trim()} onClick={() => void commit()}><Save size={12} aria-hidden="true" />Save connection</Button>
        {saved && <Button size="sm" variant="danger" disabled={!desktopAiAvailable()} onClick={() => void remove()}><Trash2 size={12} aria-hidden="true" />Remove connection</Button>}
        {saved && credentials[profile.id] && <Button size="sm" disabled={!desktopAiAvailable()} onClick={() => { setWorking(true); void agentTransport.credential(profile.id, null).then(() => { invalidateAiConversations(); return load(); }).catch(e => setError(agentError(e))).finally(() => setWorking(false)); }}>Remove API key</Button>}
      </div>
    </fieldset>}
    {saved && <fieldset className="ai-fieldset" disabled={saving || working}>
      <div className="ai-form-line">
        <label className="ai-field ai-grow">Available model<Select className="ide-select" aria-label="Default AI model" value={model} onChange={e => setModel(e.target.value)}>
          <option value="">Load models and select one</option>
          {model && !models.some(m => m.id === model) && <option value={model}>{model} (refresh to verify)</option>}
          {models.map(m => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} · ${m.id}`}</option>)}
        </Select></label>
        <Button size="sm" loading={modelsLoading} disabled={dirty || !desktopAiAvailable()} onClick={() => void refresh(selected)}><RefreshCw size={12} aria-hidden="true" />Load models</Button>
      </div>
      {modelsError && <p role="alert" className="ai-error">{modelsError}</p>}
      {modelInfo && <p className="ai-help">{modelInfo.contextWindow ? `${modelInfo.contextWindow.toLocaleString()} context tokens · ` : ''}{modelInfo.maxOutputTokens ? `${modelInfo.maxOutputTokens.toLocaleString()} max output tokens · ` : ''}Tools: {modelInfo.tools == null ? 'unknown' : modelInfo.tools ? 'supported' : 'not supported'}</p>}
      <div className="ai-form-grid">
        <label className="ai-field">Output token limit (optional)<Input aria-label="AI output token limit" type="number" min={128} max={65536} value={options.maxOutputTokens ?? ''} placeholder="Server default" onChange={e => setOptions({ ...options, maxOutputTokens: e.target.value ? Number(e.target.value) : null })} /></label>
        <label className="ai-field">Temperature (optional)<Input aria-label="AI temperature" type="number" min={0} max={2} step={0.1} value={options.temperature ?? ''} placeholder="Server default" onChange={e => setOptions({ ...options, temperature: e.target.value ? Number(e.target.value) : null })} /></label>
        {saved.protocol === 'ollama' && <label className="ai-field">Local context window (optional)<Input aria-label="Ollama context window" type="number" min={1024} max={Math.min(modelInfo?.contextWindow ?? 2097152, 2097152)} value={options.contextTokens ?? ''} placeholder="Server default" onChange={e => setOptions({ ...options, contextTokens: e.target.value ? Number(e.target.value) : null })} /></label>}
      </div>
      <CheckboxRow label="Enable tool use (disable for plain chat models)" checked={options.toolUse !== false} onChange={e => setOptions({ ...options, toolUse: e.target.checked })} />
      <Button size="sm" disabled={!model || !models.some(m => m.id === model) || dirty || !desktopAiAvailable()} onClick={() => void defaults()}><Check size={12} aria-hidden="true" />Use as default</Button>
    </fieldset>}
    {message && <p role="status" className="ai-help text-emerald-400">{message}</p>}
    {error && <p role="alert" className="ai-error">{error}</p>}
  </section>;
}

export function DataSelect({ label, value, onChange }: { label: string; value: DataAccess; onChange: (value: DataAccess) => void }) {
  return <label className="ai-field">{label}<Select aria-label={label} className="ide-select" value={value} onChange={e => onChange(e.target.value as DataAccess)}>
    <option value="none">No access</option><option value="metadata">Metadata only</option><option value="content">Contents</option>
  </Select></label>;
}

export function Writes({ value, onChange, label = 'Allowed AI changes' }: { value: WriteOperation[]; onChange: (value: WriteOperation[]) => void; label?: string }) {
  return <div role="group" aria-label={label} className="ai-permission-checks">{WRITE_OPERATIONS.map(op => <CheckboxRow key={op} label={op[0].toUpperCase() + op.slice(1)} checked={value.includes(op)} onChange={e => onChange(e.target.checked ? [...value, op] : value.filter(v => v !== op))} />)}</div>;
}

const tokens = (text: string) => text.split(/[\n,]/).map(s => s.trim()).filter(Boolean);

function PolicySettings({
  page,
  commitRef,
  onStatusChange,
}: {
  page: AgentSettingsPage;
  commitRef?: React.MutableRefObject<(() => Promise<boolean>) | null>;
  onStatusChange?: (status: { message?: string; error?: string; saving?: boolean }) => void;
}) {
  const settings = useAiStore(s => s.settings);
  const saving = useAiStore(s => s.saving);
  const save = useAiStore(s => s.save);
  const [draft, setDraft] = useState<AiSettings>(settings);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const savedPolicy = useRef(JSON.stringify([settings.policy, settings.instructions]));
  useEffect(() => {
    const signature = JSON.stringify([settings.policy, settings.instructions]);
    if (signature !== savedPolicy.current) {
      savedPolicy.current = signature;
      setDraft(d => ({ ...d, policy: settings.policy, instructions: settings.instructions }));
    }
  }, [settings]);

  const policy = draft.policy;
  const patch = (change: Partial<AgentPolicy>) => {
    setMessage('');
    setError('');
    onStatusChange?.({ message: '', error: '' });
    setDraft(d => ({ ...d, policy: { ...d.policy, ...change } }));
  };

  function reorder(index: number, offset: number) {
    const rules = [...policy.rules];
    [rules[index], rules[index + offset]] = [rules[index + offset], rules[index]];
    patch({ rules });
  }

  async function commit(): Promise<boolean> {
    setError('');
    setMessage('');
    onStatusChange?.({ saving: true, message: '', error: '' });
    try {
      await save({ ...useAiStore.getState().settings, policy: draft.policy, instructions: draft.instructions });
      const msg = 'Permissions saved successfully.';
      setMessage(msg);
      onStatusChange?.({ saving: false, message: msg, error: '' });
      return true;
    } catch (e) {
      const err = agentError(e);
      setError(err);
      onStatusChange?.({ saving: false, message: '', error: err });
      return false;
    }
  }

  useEffect(() => {
    if (commitRef) commitRef.current = commit;
    return () => { if (commitRef?.current === commit) commitRef.current = null; };
  });

  const crds = useResourceStore(s => s.resources.CustomResourceDefinition);
  const crdList = crds ? [...crds.values()] : [];
  const hasArgoCd = crdList.some(c => c.name?.includes('argoproj.io'));
  const hasFlux = crdList.some(c => c.name?.includes('toolkit.fluxcd.io') || c.name?.includes('fluxcd.io'));

  return <section className="ai-settings-section" aria-label="AI access policy">
    <div className="ai-section-header">
      <div>
        <h3>{AI_SETTINGS_PAGES.find(item => item.id === page)?.label}</h3>
        {page === 'access' && <p className="ai-help">Choose which data the agent can read and which changes it may make.</p>}
      </div>
      <Button size="sm" variant="primary" aria-label="Save agent permissions" disabled={!desktopAiAvailable() || saving} loading={saving} onClick={() => void commit()}>
        <Save size={12} aria-hidden="true" />Save changes
      </Button>
    </div>

    <div style={{ display: page === 'confirmations' ? undefined : 'none' }}>
      <div className="ai-settings-card">
        <CheckboxRow label="Ask permission for reads" checked={policy.confirmReads ?? false} onChange={e => patch({ confirmReads: e.target.checked })} />
        <p className="ai-help">When off, Ask mode confirms changes only. Tools selected below still require confirmation in Auto accept.</p>
      </div>
    <details className="ai-settings-card">
      <summary>Always ask</summary>
      <p className="ai-help">These tools require confirmation in both Ask and Auto accept. Access restrictions still apply.</p>
      <div className="ai-always-ask-list">{[
        ['read_skill', 'Read skill files'],
        ['propose_manifests', 'Propose manifests'],
        ['get_plan', 'Get plan'],
        ['propose_plan', 'Propose plan'],
        ['verify_workload', 'Verify workload'],
        ['get_evidence', 'Get evidence'],
        ['set_working_scope', 'Set working scope'],
        ['list_namespaces', 'List namespaces'],
        ['summarize_resources', 'Summarize resources'],
        ['list_resources', 'List resources'],
        ['get_resource', 'Get resource'],
        ['get_pod_diagnostics', 'Get pod diagnostics'],
        ['get_workload_diagnostics', 'Get workload diagnostics'],
        ['get_service_diagnostics', 'Get service diagnostics'],
        ['get_pvc_diagnostics', 'Get PVC diagnostics'],
        ['get_node_diagnostics', 'Get node diagnostics'],
        ['get_config_diagnostics', 'Get config diagnostics'],
        ['resource_catalog', 'Resource catalog'],
        ['get_events', 'Get events'],
        ['get_events_timeline', 'Get events timeline'],
        ['get_logs', 'Get logs'],
        ['get_metrics', 'Get metrics'],
        ['list_helm_releases', 'List Helm releases'],
        ['get_helm_release', 'Get Helm release'],
        ['list_argocd_apps', 'List Argo CD applications'],
        ['get_argocd_app', 'Get Argo CD application'],
        ['list_flux_resources', 'List flux resources'],
        ['get_flux_resource', 'Get flux resource'],
        ['apply_manifest', 'Apply manifest'],
        ['scale_workload', 'Scale workload'],
        ['restart_workload', 'Restart workload'],
        ['delete_resource', 'Delete resource'],
      ].map(([tool, label]) => <CheckboxRow key={tool} label={label} checked={(policy.alwaysAsk ?? []).includes(tool)} disabled={saving} onChange={e => patch({ alwaysAsk: e.target.checked ? [...(policy.alwaysAsk ?? []), tool] : (policy.alwaysAsk ?? []).filter(name => name !== tool) })} />)}</div>
    </details>
    </div>
    <div style={{ display: page === 'scope' ? undefined : 'none' }}><PolicyPreview policy={policy} /></div>
    <details style={{ display: page === 'access' ? undefined : 'none' }} className="ai-settings-card"><summary>Permission presets</summary><p className="ai-help">Replaces the current access rules.</p>{PERMISSION_PROFILES.map(profile=><Button key={profile} size="sm" onClick={()=>patch(permissionProfile(policy,profile))}>{profile}</Button>)}</details>
    <fieldset className="ai-fieldset" disabled={saving}>
      <div className="ai-settings-card" style={{ display: page === 'integrations' ? undefined : 'none' }}>
        <p className="ai-help mb-2">Auto checks for Argo CD and Flux APIs in the selected cluster.</p>
        <div className="flex flex-col">
          <OptionalToolRow
            title="Helm"
            description="Read releases, values and revision history."
            value={typeof policy.helm === 'string' ? policy.helm : policy.helm ? 'enabled' : 'disabled'}
            onChange={helm => patch({ helm })}
            disabled={saving}
          />
          <OptionalToolRow
            title="Argo CD"
            description="Read applications, sync status and source repositories."
            detected={hasArgoCd}
            value={typeof policy.argocd === 'string' ? policy.argocd : policy.argocd ? 'enabled' : 'disabled'}
            onChange={argocd => patch({ argocd })}
            disabled={saving}
          />
          <OptionalToolRow
            title="Flux"
            description="Read Kustomizations, HelmReleases and GitRepositories."
            detected={hasFlux}
            value={typeof policy.flux === 'string' ? policy.flux : policy.flux ? 'enabled' : 'disabled'}
            onChange={flux => patch({ flux })}
            disabled={saving}
          />
        </div>
      </div>

      <div className="ai-settings-card" style={{ display: page === 'access' ? undefined : 'none' }}>
        <h4>Read access</h4>
        <div className="ai-permission-checks">
          {([
            ['resources', 'Read resources'], ['events', 'Read Events'], ['logs', 'Read Pod logs'], ['metrics', 'Read metrics'],
            ['clusterResources', 'Read cluster-scoped resources'], ['workloadConfiguration', 'Read inline env & commands'], ['annotations', 'Read annotations'],
          ] as const).map(([key, label]) => <CheckboxRow key={key} label={label} checked={policy[key]} onChange={e => patch({ [key]: e.target.checked })} />)}
        </div>
      </div>

      <div className="ai-settings-card" style={{ display: page === 'access' ? undefined : 'none' }}>
        <h4>Resource contents</h4>
        <div className="ai-form-grid">
          <DataSelect label="Secret access" value={policy.secrets} onChange={secrets => patch({ secrets })} />
          <DataSelect label="ConfigMap access" value={policy.configMaps} onChange={configMaps => patch({ configMaps })} />
          <DataSelect label="Custom resources" value={policy.customResources} onChange={customResources => patch({ customResources })} />
        </div>
        <p className="ai-help mt-2">Secret and ConfigMap contents are only read if explicitly permitted. Metadata-only reads omit bodies.</p>
      </div>

      <div className="ai-settings-card" style={{ display: page === 'scope' ? undefined : 'none' }}>
        <h4>Allowed clusters and namespaces</h4>
        <div className="ai-form-grid">
          <label className="ai-field">Allowed contexts (* matches any)<textarea aria-label="Allowed AI contexts" className="ide-textarea" rows={2} value={policy.contexts.join('\n')} onChange={e => patch({ contexts: tokens(e.target.value) })} /></label>
          <label className="ai-field">Allowed namespaces (* matches any)<textarea aria-label="Allowed AI namespaces" className="ide-textarea" rows={2} value={policy.namespaces.join('\n')} onChange={e => patch({ namespaces: tokens(e.target.value) })} /></label>
        </div>
      </div>

      <div className="ai-settings-card" style={{ display: page === 'access' ? undefined : 'none' }}>
        <h4>Allowed changes</h4>
        <Writes value={policy.writes} onChange={writes => patch({ writes })} />
        <label className="ai-field">Maximum replicas<Input aria-label="Maximum AI replicas" type="number" min={0} max={10000} value={policy.maxReplicas} onChange={e => patch({ maxReplicas: Number(e.target.value) })} /></label>

        <p className="ai-help mt-2">Changes are available only in Action.</p>
      </div>

      <div className="ai-settings-card" style={{ display: page === 'scope' ? undefined : 'none' }}>
        <div className="ai-form-line">
          <div>
            <h4>Resource rules</h4>
            <label className="ai-field">Rule matching<Select aria-label="AI rule matching" value={policy.ruleResolution??'first_match'} onChange={e=>patch({schemaVersion:e.target.value==='deny_overrides'?2:1,ruleResolution:e.target.value as 'first_match'|'deny_overrides'})}><option value="first_match">First match</option><option value="deny_overrides">Deny rules take priority</option></Select></label>
            {policy.ruleResolution==='deny_overrides'&&<p className="ai-help">Rules that deny both reading and changes take priority over other matching rules.</p>}
            {policy.ruleResolution !== 'deny_overrides' && <p className="ai-help">The first matching rule applies. Put specific exceptions before broad rules.</p>}
          </div>
          <span className="ai-grow" />
          <Button size="sm" aria-label="Add resource rule" disabled={policy.rules.length >= 100} onClick={() => patch({ rules: [...policy.rules, { group: '*', kind: '*', namespace: '*', name: '*', read: 'none', writes: [] }] })}>
            <Plus size={12} aria-hidden="true" />Add rule
          </Button>
        </div>
        {policy.rules.map((rule, index) => <div key={index} className="ai-rule mt-3" role="group" aria-label={`Resource rule ${index + 1}`}>
          <div className="ai-form-line">
            <strong>Rule {index + 1}</strong>
            <span className="ai-grow" />
            <Button size="sm" aria-label={`Move rule ${index + 1} up`} disabled={index === 0} onClick={() => reorder(index, -1)}><ArrowUp size={12} aria-hidden="true" /></Button>
            <Button size="sm" aria-label={`Move rule ${index + 1} down`} disabled={index === policy.rules.length - 1} onClick={() => reorder(index, 1)}><ArrowDown size={12} aria-hidden="true" /></Button>
            <Button size="sm" aria-label={`Remove rule ${index + 1}`} onClick={() => patch({ rules: policy.rules.filter((_, i) => i !== index) })}><Trash2 size={12} aria-hidden="true" /></Button>
          </div>
          <div className="ai-form-grid">
            {(['group', 'kind', 'namespace', 'name'] as const).map(key => <label className="ai-field" key={key}>{key}<Input aria-label={`Rule ${index + 1} ${key}`} value={rule[key]} maxLength={253} onChange={e => patch({ rules: policy.rules.map((r, i) => i === index ? { ...r, [key]: e.target.value } : r) })} /></label>)}
          </div>
          <DataSelect label={`Rule ${index + 1} read access`} value={rule.read} onChange={read => patch({ rules: policy.rules.map((r, i) => i === index ? { ...r, read } : r) })} />
          <Writes label={`Rule ${index + 1} writes`} value={rule.writes} onChange={writes => patch({ rules: policy.rules.map((r, i) => i === index ? { ...r, writes } : r) })} />
        </div>)}
      </div>

      <div className="ai-settings-card" style={{ display: page === 'scope' ? undefined : 'none' }}>
        <h4>Field filters</h4>
        <label className="ai-field">Fields to include<textarea aria-label="Allowed AI fields" className="ide-textarea font-mono" rows={3} value={policy.allowedFields?.join('\n')??''} placeholder="spec.containers[*].image" onChange={e=>patch({allowedFields:e.target.value.split('\n').map(s=>s.trim()).filter(Boolean)})}/></label>
        <p className="ai-help">Leave empty to include all permitted fields. Excluded fields stay hidden. Include metadata.labels to allow label filtering.</p>
        <label className="ai-field">Fields to exclude<textarea aria-label="Excluded AI field paths" className="ide-textarea font-mono" rows={3} value={policy.deniedPaths.join('\n')} placeholder={'/spec/template/spec/containers/0/env\n/data/private.conf'} onChange={e => patch({ deniedPaths: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })} /></label>

      </div>
      <div className="ai-settings-card" style={{ display: page === 'instructions' ? undefined : 'none' }}>
        <p className="ai-help">Set a response language or add investigation instructions. These do not change permissions.</p>
        <label className="ai-field mt-3">Agent instructions<textarea aria-label="Integrated agent instructions" className="ide-textarea" rows={3} maxLength={8000} value={draft.instructions} placeholder="For example: answer in Russian and check Pod events first." onChange={e => setDraft(d => ({ ...d, instructions: e.target.value }))} /></label>
      </div>
    </fieldset>

    {error && <p role="alert" className="ai-error mt-2">{error}</p>}
    {message && <p role="status" className="ai-help text-emerald-400 mt-2">{message}</p>}
  </section>;
}

function ToolModeSelector({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: OptionalToolMode;
  onChange: (val: OptionalToolMode) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex items-center rounded border border-[var(--border-default)] bg-[var(--bg-surface)] p-0.5 shrink-0">
      {(['auto', 'enabled', 'disabled'] as const).map(mode => {
        const active = value === mode;
        const labels: Record<OptionalToolMode, string> = {
          auto: 'Auto',
          enabled: 'Enabled',
          disabled: 'Disabled',
        };
        return (
          <button
            key={mode}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
              active
                ? 'bg-[var(--accent)] text-white shadow-xs font-semibold'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            }`}
            onClick={() => onChange(mode)}
          >
            {labels[mode]}
          </button>
        );
      })}
    </div>
  );
}

function OptionalToolRow({
  title,
  description,
  detected,
  value,
  onChange,
  disabled,
}: {
  title: string;
  description: string;
  detected?: boolean;
  value: OptionalToolMode;
  onChange: (val: OptionalToolMode) => void;
  disabled?: boolean;
}) {
  return <div className="ai-integration-row">
    <div className="ai-integration-info">
      <div className="ai-integration-title"><span>{title}</span>
        {detected !== undefined && value === 'auto' && <span className="ai-integration-status">{detected ? 'Detected' : 'Not detected'}</span>}
      </div>
      <p className="ai-help">{description}</p>
    </div>
    <ToolModeSelector value={value} onChange={onChange} disabled={disabled} ariaLabel={`${title} access`} />
  </div>;
}
