import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
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
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const refresh = () => {
      setPrefs({ ...historyPreferences });
      setError(historyStorageError());
    };
    window.addEventListener('ai-history-state', refresh);
    return () => window.removeEventListener('ai-history-state', refresh);
  }, []);

  async function commit() {
    setError('');
    setSaved(false);
    try {
      await saveHistoryPreferences(prefs);
      setSaved(true);
    } catch (e) {
      setError(agentError(e));
    }
  }

  return (
    <div className="ai-settings-card" aria-label="AI history settings">
      <div className="ai-card-header">
        <div>
          <h4>Conversation history</h4>
          <p className="ai-help">Up to 200 local chats (32 MiB). Tool payloads, plans, credentials and approvals are excluded.</p>
        </div>
        <Button size="sm" onClick={() => void commit()}>
          <Save size={12} aria-hidden="true" />
          Save history settings
        </Button>
      </div>

      <div className="ai-setting-row">
        <div className="ai-setting-row-label">
          <CheckboxRow
            label="Save conversation text locally"
            checked={prefs.enabled}
            onChange={e => { setSaved(false); setPrefs({ ...prefs, enabled: e.target.checked }); }}
          />
          {!prefs.enabled && (
            <p className="ai-help mt-1">Turning off saving removes stored conversations and the search index.</p>
          )}
        </div>
      </div>

      <div className="ai-setting-row">
        <div className="ai-setting-row-label">
          <div className="ai-setting-row-title">Retention (days)</div>
          <p className="ai-help">Older local conversations are pruned automatically.</p>
        </div>
        <div className="ai-setting-row-control">
          <Input
            type="number"
            aria-label="History retention days"
            className="w-24"
            min={1}
            max={365}
            value={prefs.retentionDays}
            onChange={e => { setSaved(false); setPrefs({ ...prefs, retentionDays: Number(e.target.value) }); }}
          />
        </div>
      </div>

      <div className="ai-setting-row">
        <div className="ai-setting-row-label">
          <CheckboxRow
            label="Allow transcript export"
            checked={prefs.allowExport}
            onChange={e => { setSaved(false); setPrefs({ ...prefs, allowExport: e.target.checked }); }}
          />
        </div>
      </div>

      {saved && <p role="status" className="ai-help text-emerald-400 mt-2">History settings saved.</p>}
      {error && <p role="alert" className="ai-error mt-2">{error}</p>}
    </div>
  );
}

export function PolicyPreview({ policy }: { policy: AgentPolicy }) {
  const context = useClusterStore(s => s.currentContext);
  const [target, setTarget] = useState({ group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'default', name: 'web' });
  const [result, setResult] = useState<string>('');
  const [phase, setPhase] = useState<'plan' | 'action'>('plan');
  const [operation, setOperation] = useState<string>('read');

  return (
    <details className="ai-settings-card">
      <summary>Check access</summary>
      <div className="flex flex-col gap-3">
        <div className="ai-form-grid-3">
          {(['group', 'version', 'kind', 'namespace', 'name'] as const).map(key => (
            <label className="ai-field" key={key}>
              {key}
              <Input
                aria-label={`Policy preview ${key}`}
                value={target[key]}
                onChange={e => setTarget({ ...target, [key]: e.target.value })}
                maxLength={253}
              />
            </label>
          ))}
        </div>
        <div className="ai-field-row">
          <label className="ai-field w-40">
            Phase
            <Select
              aria-label="Policy preview phase"
              className="ide-select"
              value={phase}
              onChange={e => setPhase(e.target.value as 'plan' | 'action')}
            >
              <option value="plan">Plan</option>
              <option value="action">Action · Ask</option>
            </Select>
          </label>
          <label className="ai-field w-36">
            Operation
            <Select
              aria-label="Policy preview operation"
              className="ide-select"
              value={operation}
              onChange={e => setOperation(e.target.value)}
            >
              {['read', ...WRITE_OPERATIONS].map(op => <option key={op}>{op}</option>)}
            </Select>
          </label>
          <Button
            size="md"
            disabled={!desktopAiAvailable()}
            onClick={() => {
              void agentTransport.previewPolicy({
                policy,
                scope: { context: context || '', namespaces: target.namespace ? [target.namespace] : [], allNamespaces: false },
                target: { ...target, namespace: target.namespace || null },
                mode: 'ask',
                phase,
                operation: operation === 'read' ? undefined : operation,
              }).then(r => setResult(`${r.explanation.allowed ? 'Allowed' : 'Denied'}: ${r.explanation.explanation}\n${r.issues.map(i => `Rule ${i.ruleIndex + 1}: ${i.message}`).join('\n')}`)).catch(e => setResult(agentError(e)));
            }}
          >
            Check access
          </Button>
        </div>
        {result && (
          <pre className="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] whitespace-pre-wrap text-xs font-mono" role="status">
            {result}
          </pre>
        )}
      </div>
    </details>
  );
}
