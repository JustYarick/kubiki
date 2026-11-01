import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { CheckboxRow } from '../../../components/ui/Checkbox';
import { useClusterStore } from '../../../state/cluster_store';
import { agentError, agentTransport, desktopAiAvailable } from '../transport';
import { WRITE_OPERATIONS, type AgentPolicy } from '../types';
import { historyPreferences, historyStorageError, saveHistoryPreferences } from '../history_storage';

export function HistorySettings() {
  const [prefs, setPrefs] = useState({ ...historyPreferences });
  const [error, setError] = useState(historyStorageError());
  useEffect(() => { const refresh = () => { setPrefs({ ...historyPreferences }); setError(historyStorageError()); }; window.addEventListener('ai-history-state', refresh); return () => window.removeEventListener('ai-history-state', refresh); }, []);
  return <section className="ai-settings-section" aria-label="AI history settings"><h3>Conversation history</h3><p className="ai-help">Local transcript history; up to 200 conversations / 32 MiB. Tool bodies, plans, credentials and approvals are excluded. Restored conversations open in Read only + Plan.</p>
    <CheckboxRow label="Save conversation text locally" checked={prefs.enabled} onChange={e => setPrefs({ ...prefs, enabled: e.target.checked })} />
    <label className="ai-field">Retention (days)<Input type="number" aria-label="History retention days" min={1} max={365} value={prefs.retentionDays} onChange={e => setPrefs({ ...prefs, retentionDays: Number(e.target.value) })} /></label>
    <CheckboxRow label="Allow transcript export" checked={prefs.allowExport} onChange={e => setPrefs({ ...prefs, allowExport: e.target.checked })} />
    <Button size="sm" onClick={() => { void saveHistoryPreferences(prefs).then(() => setError('')).catch(e => setError(agentError(e))); }}>Save history settings</Button>
    {!prefs.enabled && <p className="ai-help">Saving disabled: stored transcripts and search index are removed. The current chat remains in memory.</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function PolicyPreview({ policy }: { policy: AgentPolicy }) {
  const context = useClusterStore(s => s.currentContext);
  const [target, setTarget] = useState({ group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'default', name: 'web' });
  const [result, setResult] = useState<string>('');
  const [phase, setPhase] = useState<'plan' | 'action'>('plan');
  const [operation, setOperation] = useState<string>('read');
  return <details className="ai-settings-card"><summary>Preview effective access and validate rules</summary>
    <div className="ai-form-grid">{(['group', 'version', 'kind', 'namespace', 'name'] as const).map(key => <label className="ai-field" key={key}>{key}<Input aria-label={`Policy preview ${key}`} value={target[key]} onChange={e => setTarget({ ...target, [key]: e.target.value })} maxLength={253} /></label>)}</div>
    <Select aria-label="Policy preview phase" value={phase} onChange={e => setPhase(e.target.value as 'plan' | 'action')}><option value="plan">Plan</option><option value="action">Action · Ask</option></Select>
    <Select aria-label="Policy preview operation" value={operation} onChange={e => setOperation(e.target.value)}>{['read', ...WRITE_OPERATIONS].map(op => <option key={op}>{op}</option>)}</Select>
    <Button size="sm" disabled={!desktopAiAvailable()} onClick={() => { void agentTransport.previewPolicy({ policy, scope: { context: context || '', namespaces: target.namespace ? [target.namespace] : [], allNamespaces: false }, target: { ...target, namespace: target.namespace || null }, mode: phase === 'plan' ? 'read_only' : 'ask', phase, operation: operation === 'read' ? undefined : operation }).then(r => setResult(`${r.explanation.allowed ? 'Allowed' : 'Denied'}: ${r.explanation.explanation}\n${r.issues.map(i => `Rule ${i.ruleIndex + 1}: ${i.message}`).join('\n')}`)).catch(e => setResult(agentError(e))); }}>Preview locally</Button>
    {result && <pre className="whitespace-pre-wrap text-xs" role="status">{result}</pre>}
  </details>;
}
