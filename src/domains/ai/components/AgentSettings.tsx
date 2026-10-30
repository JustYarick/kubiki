import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { CheckboxRow } from '../../../components/ui/Checkbox';
import { invalidateAiConversations, useAiStore } from '../store';
import { agentError, agentTransport, desktopAiAvailable } from '../transport';
import { PROVIDER_PRESETS, WRITE_OPERATIONS, type AgentPolicy, type AiSettings, type DataAccess, type ModelInfo, type ProviderProfile, type ProviderProtocol, type WriteOperation } from '../types';
import '../ai.css';

const protocolNames: Record<ProviderProtocol, string> = {
  responses: 'OpenAI Responses', openai_compatible: 'OpenAI-compatible chat', anthropic: 'Anthropic Messages', ollama: 'Ollama',
};
const EMPTY_MODELS: ModelInfo[] = [];

export interface AgentSettingsHandle {
  save: () => Promise<boolean>;
}

export interface AgentSettingsProps {
  section?: 'providers' | 'permissions' | 'all';
  onStatusChange?: (status: { message?: string; error?: string; saving?: boolean }) => void;
}

export const AgentSettings = forwardRef<AgentSettingsHandle, AgentSettingsProps>(function AgentSettings(
  { section = 'all', onStatusChange },
  ref,
) {
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
    {!desktopAiAvailable() && <p className="ai-notice">Configure AI providers and use cluster tools in the desktop app. This preview does not send cluster data or store API keys.</p>}
    {loading && <p role="status">Loading AI settings…</p>}
    {error && <div role="alert" className="ai-error">{error} <Button size="sm" onClick={() => void load()}>Reload settings</Button></div>}
    {loaded && <>
      {section !== 'permissions' && <ProviderSettings />}
      {section !== 'providers' && <PolicySettings commitRef={policyCommitRef} onStatusChange={onStatusChange} />}
    </>}
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
    try { await save({ ...settings, defaultProvider: selected, defaultModel: model, options }); setMessage('Default provider, model and generation options saved.'); }
    catch (e) { setError(agentError(e)); }
  }
  const modelInfo = models.find(m => m.id === model);
  useEffect(() => { if (modelInfo && model) void useAiStore.getState().inspectModel(selected, model); }, [selected, model, modelInfo]);

  return <section aria-label="AI provider connections" className="ai-settings-section">
    <div className="ai-section-header">
      <div>
        <h3>Providers and models</h3>
        <p className="ai-help">Connect cloud APIs or a local server. Model IDs and capabilities are discovered dynamically from the endpoint.</p>
      </div>
    </div>
    <div className="ai-form-line">
      <label className="ai-field ai-grow">Saved connection<Select aria-label="Saved AI connection" className="ide-select" value={selected} onChange={e => choose(e.target.value)}>
        <option value="">Choose a connection</option>
        {settings.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        {profile && !saved && <option value={profile.id}>{profile.name} (unsaved)</option>}
      </Select></label>
      <Button size="sm" onClick={() => add()} disabled={saving || working}><Plus size={12} aria-hidden="true" />Add provider</Button>
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
        <label className="ai-field">API root<Input aria-label="AI API root" value={profile.baseUrl} maxLength={2048} spellCheck={false} onChange={e => setProfile({ ...profile, baseUrl: e.target.value })} /></label>
      </div>
      <p className="ai-help">Include /v1 for OpenAI-compatible APIs; use server root for Ollama. HTTPS is required except on localhost.</p>
      <label className="ai-field">API key {credentials[profile.id] ? '(stored in OS credential store)' : '(optional for local servers)'}
        <Input aria-label="AI API key" type="password" autoComplete="new-password" value={key} placeholder={credentials[profile.id] ? 'Leave empty to keep the stored key' : 'Enter API key if required'} onChange={e => setKey(e.target.value)} />
      </label>
      <div className="ai-form-line">
        <Button size="sm" variant="primary" disabled={!desktopAiAvailable() || !profile.name.trim()} onClick={() => void commit()}><Save size={12} aria-hidden="true" />Save provider</Button>
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
      {modelInfo && <p className="ai-help">{modelInfo.contextWindow ? `${modelInfo.contextWindow.toLocaleString()} context tokens · ` : ''}{modelInfo.maxOutputTokens ? `${modelInfo.maxOutputTokens.toLocaleString()} max output tokens · ` : ''}Tools: {modelInfo.tools == null ? 'not advertised' : modelInfo.tools ? 'supported' : 'not supported'}</p>}
      <div className="ai-form-grid">
        <label className="ai-field">Output token limit (optional)<Input aria-label="AI output token limit" type="number" min={128} max={65536} value={options.maxOutputTokens ?? ''} placeholder="Provider default" onChange={e => setOptions({ ...options, maxOutputTokens: e.target.value ? Number(e.target.value) : null })} /></label>
        <label className="ai-field">Temperature (optional)<Input aria-label="AI temperature" type="number" min={0} max={2} step={0.1} value={options.temperature ?? ''} placeholder="Provider default" onChange={e => setOptions({ ...options, temperature: e.target.value ? Number(e.target.value) : null })} /></label>
        {saved.protocol === 'ollama' && <label className="ai-field">Local context window (optional)<Input aria-label="Ollama context window" type="number" min={1024} max={Math.min(modelInfo?.contextWindow ?? 262144, 262144)} value={options.contextTokens ?? ''} placeholder="Server default" onChange={e => setOptions({ ...options, contextTokens: e.target.value ? Number(e.target.value) : null })} /></label>}
      </div>
      <CheckboxRow label="Enable tool use (disable for plain chat models)" checked={options.toolUse !== false} onChange={e => setOptions({ ...options, toolUse: e.target.checked })} />
      <Button size="sm" disabled={!model || !models.some(m => m.id === model) || dirty || !desktopAiAvailable()} onClick={() => void defaults()}><Check size={12} aria-hidden="true" />Use as default</Button>
    </fieldset>}
    {message && <p role="status" className="ai-help text-emerald-400">{message}</p>}
    {error && <p role="alert" className="ai-error">{error}</p>}
  </section>;
}

function DataSelect({ label, value, onChange }: { label: string; value: DataAccess; onChange: (value: DataAccess) => void }) {
  return <label className="ai-field">{label}<Select aria-label={label} className="ide-select" value={value} onChange={e => onChange(e.target.value as DataAccess)}>
    <option value="none">No access</option><option value="metadata">Metadata only</option><option value="content">Contents</option>
  </Select></label>;
}

function Writes({ value, onChange, label = 'Allowed AI changes' }: { value: WriteOperation[]; onChange: (value: WriteOperation[]) => void; label?: string }) {
  return <div role="group" aria-label={label} className="ai-permission-checks">{WRITE_OPERATIONS.map(op => <CheckboxRow key={op} label={op[0].toUpperCase() + op.slice(1)} checked={value.includes(op)} onChange={e => onChange(e.target.checked ? [...value, op] : value.filter(v => v !== op))} />)}</div>;
}

const tokens = (text: string) => text.split(/[\n,]/).map(s => s.trim()).filter(Boolean);

function PolicySettings({
  commitRef,
  onStatusChange,
}: {
  commitRef?: React.MutableRefObject<(() => Promise<boolean>) | null>;
  onStatusChange?: (status: { message?: string; error?: string; saving?: boolean }) => void;
}) {
  const settings = useAiStore(s => s.settings);
  const saving = useAiStore(s => s.saving);
  const save = useAiStore(s => s.save);
  const [draft, setDraft] = useState<AiSettings>(settings);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => { setDraft(settings); }, [settings]);

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
    if (commitRef) {
      commitRef.current = commit;
    }
  });

  return <section className="ai-settings-section" aria-label="AI access policy">
    <div className="ai-section-header">
      <div>
        <h3>Agent permissions & data access</h3>
        <p className="ai-help">Backend-enforced restrictions. Plan phase strictly forbids cluster writes; Ask requires explicit confirmation; Accept executes permitted operations automatically.</p>
      </div>
      <Button size="sm" variant="primary" aria-label="Save agent permissions" disabled={!desktopAiAvailable() || saving} loading={saving} onClick={() => void commit()}>
        <Save size={12} aria-hidden="true" />Save permissions
      </Button>
    </div>

    <fieldset className="ai-fieldset" disabled={saving}>
      <div className="ai-settings-card">
        <h4>Telemetry & Read Access</h4>
        <div className="ai-permission-checks">
          {([
            ['resources', 'Read resources'], ['events', 'Read Events'], ['logs', 'Read Pod logs'], ['metrics', 'Read metrics'],
            ['clusterResources', 'Read cluster-scoped resources'], ['workloadConfiguration', 'Read inline env & commands'], ['annotations', 'Read annotations'],
          ] as const).map(([key, label]) => <CheckboxRow key={key} label={label} checked={policy[key]} onChange={e => patch({ [key]: e.target.checked })} />)}
        </div>
      </div>

      <div className="ai-settings-card">
        <h4>Sensitive Resources & Limits</h4>
        <div className="ai-form-grid">
          <DataSelect label="Secret access" value={policy.secrets} onChange={secrets => patch({ secrets })} />
          <DataSelect label="ConfigMap access" value={policy.configMaps} onChange={configMaps => patch({ configMaps })} />
          <DataSelect label="Custom resources" value={policy.customResources} onChange={customResources => patch({ customResources })} />
          <label className="ai-field">Maximum replicas<Input aria-label="Maximum AI replicas" type="number" min={0} max={10000} value={policy.maxReplicas} onChange={e => patch({ maxReplicas: Number(e.target.value) })} /></label>
        </div>
        <p className="ai-help mt-2">Secret and ConfigMap contents are only read if explicitly permitted. Metadata-only reads omit bodies.</p>
      </div>

      <div className="ai-settings-card">
        <h4>Scope Boundaries</h4>
        <div className="ai-form-grid">
          <label className="ai-field">Allowed contexts (* matches any)<textarea aria-label="Allowed AI contexts" className="ide-textarea" rows={2} value={policy.contexts.join('\n')} onChange={e => patch({ contexts: tokens(e.target.value) })} /></label>
          <label className="ai-field">Allowed namespaces (* matches any)<textarea aria-label="Allowed AI namespaces" className="ide-textarea" rows={2} value={policy.namespaces.join('\n')} onChange={e => patch({ namespaces: tokens(e.target.value) })} /></label>
        </div>
      </div>

      <div className="ai-settings-card">
        <h4>Default Write Permissions</h4>
        <Writes value={policy.writes} onChange={writes => patch({ writes })} />
        <p className="ai-help mt-2">Active only when session is in Action phase and mode is Ask or Accept. In Plan phase, all write operations are completely blocked.</p>
      </div>

      <div className="ai-settings-card">
        <div className="ai-form-line">
          <div>
            <h4>Resource Rules</h4>
            <p className="ai-help">First matching rule overrides defaults. Specific exceptions take precedence.</p>
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

      <div className="ai-settings-card">
        <h4>Excluded Field Paths & Custom Instructions</h4>
        <label className="ai-field">Excluded JSON pointer paths<textarea aria-label="Excluded AI field paths" className="ide-textarea font-mono" rows={3} value={policy.deniedPaths.join('\n')} placeholder={'/spec/template/spec/containers/0/env\n/data/private.conf'} onChange={e => patch({ deniedPaths: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })} /></label>
        <label className="ai-field mt-3">Agent instructions<textarea aria-label="Integrated agent instructions" className="ide-textarea" rows={3} maxLength={8000} value={draft.instructions} placeholder="Preferred response style, diagnostic conventions, language preferences…" onChange={e => setDraft(d => ({ ...d, instructions: e.target.value }))} /></label>
      </div>
    </fieldset>

    {error && <p role="alert" className="ai-error mt-2">{error}</p>}
    {message && <p role="status" className="ai-help text-emerald-400 mt-2">{message}</p>}
  </section>;
}
