import { performResourceAction } from '../../../../providers/resource_actions';
import { useRef, useState } from 'react';
import { FileCode, Copy, Plus, Trash2, Search, RotateCw } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { Button } from '../../../ui/Button';
import { CodeEditor } from '../../../ui/CodeEditor';
import { codeLanguage } from '../../../../core/code_language';
import { toast } from '../../../../state/notifications_store';
import { k8s } from '../../../../providers/k8s_provider';
import { useClusterStore } from '../../../../state/cluster_store';
import { useResourceStore } from '../../../../state/resource_store';

const field = 'w-full min-w-0 rounded border border-[var(--border-default)] bg-[var(--bg-canvas)] px-2 py-1.5 font-mono text-xs';

export function ConfigMapDataBlock({ item, onRestartConsumers }: { item: ResourceItem; onRestartConsumers?: () => void }) {
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const context = useClusterStore(state => state.currentContext);
  const [baseline, setBaseline] = useState<{ item: ResourceItem; context: string | null }>();
  const changed = editing && !!baseline && (baseline.context !== context || baseline.item.uid !== item.uid || baseline.item.raw?.metadata?.resourceVersion !== item.raw?.metadata?.resourceVersion);
  const immutable = item.raw?.immutable === true;
  const rawData: Record<string, string> = item.raw?.data ?? {};
  const nextId = useRef(0);
  const [draft, setDraft] = useState<Array<{ id: number; key: string; value: string }>>([]);

  const entries = Object.entries(rawData);
  const filtered = entries.filter(([k]) => k.toLowerCase().includes(filter.toLowerCase()));

  const startEdit = () => {
    setBaseline({ item, context });
    setDraft(entries.map(([key, value]) => ({ id: nextId.current++, key, value })));
    setEditing(true);
  };

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success(`Copied ${label}`)).catch(() => toast.error('Clipboard unavailable'));
  };

  const save = async () => {
    if (!baseline || changed || saving || immutable) return;
    try {
      setSaving(true);
      const dataObj: Record<string, string> = {};
      for (const { key, value } of draft) {
        if (key.trim()) dataObj[key.trim()] = value;
      }

      if (k8s.demo) {
        useResourceStore.getState().updateItem('ConfigMap', item.uid, {
          raw: { ...item.raw, data: dataObj },
        });
        setEditing(false);
        toast.success('ConfigMap updated in demo memory');
        return;
      }

      const context = baseline.context;
      if (!context) return;
      const original = baseline.item;
      await performResourceAction(context, original, { type: 'config_map_data', data: dataObj });
      setEditing(false);
      toast.success('ConfigMap saved to cluster');
    } catch (err) {
      toast.error('Failed to save ConfigMap', String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Configuration data" className="details-section">
      <div className="details-section-heading text-[length:calc(11px*var(--ui-factor))] font-medium text-[var(--text-secondary)] bg-[var(--bg-secondary)] flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[var(--text-primary)]">
          <FileCode size="calc(12px * var(--ui-factor))" className="text-blue-400" />
          ConfigMap Data ({entries.length} keys)
        </span>
        <div className="flex items-center gap-1.5">
          {onRestartConsumers && (
            <Button size="sm" onClick={onRestartConsumers} title="Rollout restart workloads using this ConfigMap">
              <RotateCw size="calc(11px * var(--ui-factor))" />
              Restart consumers
            </Button>
          )}
          {!editing && (
            <Button size="sm" disabled={immutable || !context} onClick={startEdit}>
              Edit data
            </Button>
          )}
        </div>
      </div>

      <div className="p-2 bg-[var(--bg-canvas)] flex flex-col gap-3">
        {changed && <p role="alert" className="text-xs text-[var(--status-warn)]">The ConfigMap changed while editing. Cancel and edit again to load the latest version.</p>}
        {entries.length > 3 && !editing && (
          <div className="relative flex items-center">
            <Search size="calc(12px * var(--ui-factor))" className="absolute left-2 text-[var(--text-muted)] pointer-events-none" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter keys…"
              className="h-7 w-full bg-[var(--bg-primary)] text-xs text-[var(--text-primary)] rounded border border-[var(--border-default)] pl-7 pr-2 outline-none focus:border-[var(--accent)]"
            />
          </div>
        )}

        {editing ? (
          <div className="details-stack">
            {draft.map((d, idx) => (
              <div key={d.id} className="p-2 rounded bg-[var(--bg-secondary)]/40 border border-[var(--border-subtle)] space-y-1.5">
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`Key ${idx + 1}`}
                    disabled={saving}
                    className={`${field} py-1 flex-1`}
                    value={d.key}
                    placeholder="Key"
                    onChange={(e) => {
                      const val = e.target.value;
                      setDraft((prev) => prev.map((item, i) => (i === idx ? { ...item, key: val } : item)));
                    }}
                  />
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setDraft((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-rose-400 hover:text-rose-300 p-1 rounded"
                    title="Delete key"
                  >
                    <Trash2 size="calc(12px * var(--ui-factor))" />
                  </button>
                </div>
                <CodeEditor
                  ariaLabel={`Value ${idx + 1}`}
                  language={codeLanguage(d.key, d.value)}
                  readOnly={saving}
                  value={d.value}
                  onChange={(val) => {
                    setDraft((prev) => prev.map((item, i) => (i === idx ? { ...item, value: val } : item)));
                  }}
                />
              </div>
            ))}

            <div className="flex items-center gap-2 pt-2 border-t border-[var(--border-subtle)]">
              <Button size="sm" disabled={saving} onClick={() => { const id = nextId.current++; setDraft((prev) => [...prev, { id, key: '', value: '' }]); }}>
                <Plus size="calc(12px * var(--ui-factor))" /> Add key
              </Button>
              <div className="flex-1" />
              <Button size="sm" variant="primary" disabled={saving || changed || immutable} onClick={save}>
                {saving ? 'Saving…' : 'Save ConfigMap'}
              </Button>
              <Button size="sm" disabled={saving} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="details-stack">
            {filtered.length === 0 && (
              <div className="text-xs text-[var(--text-muted)]">
                {entries.length === 0 ? 'No data keys defined.' : 'No keys match filter.'}
              </div>
            )}
            {filtered.map(([key, value]) => (
              <div key={key} className="space-y-1">
                <div className="flex items-center justify-between text-xs font-mono font-medium text-[var(--text-primary)]">
                  <span>{key}</span>
                  <button
                    type="button"
                    onClick={() => copy(String(value), `value of "${key}"`)}
                    className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-0.5 rounded"
                    title="Copy value"
                  >
                    <Copy size="calc(11px * var(--ui-factor))" />
                  </button>
                </div>
                <CodeEditor ariaLabel={`Value for ${key}`} value={String(value)} language={codeLanguage(key, String(value))} readOnly copyable={false} />
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
