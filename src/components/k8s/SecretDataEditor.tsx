import { useState } from 'react';
import { Button } from '../ui/Button';
import { useClusterStore } from '../../state/cluster_store';
import { useResourceStore } from '../../state/resource_store';
import { resourceRef } from '../../core/resources/identity';
import { decodeBase64, encodeSecretRows, encodeText, secretRows, type SecretRow } from '../../core/resources/secret_data';
import { mapK8sResource } from '../../core/utils/k8s_mapper';
import { k8s } from '../../providers/k8s_provider';
import type { ResourceItem } from '../../types/k8s';

const field = 'w-full min-w-0 rounded border border-[var(--border-default)] bg-[var(--bg-canvas)] px-2 py-1.5 font-mono text-xs';
export function SecretDataEditor({ item }: { item: ResourceItem }) {
  const context = useClusterStore(s => s.currentContext);
  const [draft, setDraft] = useState<{ rows: SecretRow[]; version: string; context: string }>();
  const [reveal, setReveal] = useState(false);
  const [encoding, setEncoding] = useState<SecretRow['mode']>('text');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const rows = draft?.rows ?? formatRows(secretRows(item.raw?.data ?? {}), encoding);
  const changed = !!draft && (draft.version !== item.raw?.metadata?.resourceVersion || draft.context !== context);
  const immutable = item.raw?.immutable === true;
  const update = (id: number, patch: Partial<SecretRow>) => setDraft(d => d && ({ ...d, rows: d.rows.map(row => row.id === id ? { ...row, ...patch } : row) }));
  const edit = () => { setDraft({ rows: formatRows(secretRows(item.raw?.data ?? {}), encoding), version: item.raw?.metadata?.resourceVersion ?? '', context: context ?? '' }); setReveal(false); setError(''); setSaved(''); };
  async function save() {
    if (!draft || !context || draft.context !== context) return;
    setError(''); setSaved('');
    try {
      const data = encodeSecretRows(draft.rows);
      setSaving(true);
      const raw = k8s.demo ? { ...item.raw, data } : await k8s.updateSecretData({ resource: resourceRef(draft.context, item), resource_version: draft.version, data });
      if (useClusterStore.getState().currentContext !== draft.context) return;
      if (raw?.metadata?.uid !== item.uid || raw?.metadata?.name !== item.name || raw?.metadata?.namespace !== item.namespace) throw new Error('Unexpected Secret identity returned; refresh to verify saved state');
      useResourceStore.getState().updateItem('Secret', item.uid, mapK8sResource(raw, 'Secret'));
      setDraft(undefined); setReveal(false); setSaved(k8s.demo ? 'Saved in demo memory' : 'Secret data saved');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Secret update failed. Refresh to verify saved state'); }
    finally { setSaving(false); }
  }
  return <section aria-label="Secret data" className="shrink-0 rounded border border-[var(--border-default)] p-3 min-w-0">
    <div className="flex flex-wrap items-center gap-2 mb-2"><h3 className="font-medium flex-1">Secret data ({rows.length})</h3><div role="group" aria-label="Secret value encoding" className="inline-flex rounded border border-[var(--border-default)] overflow-hidden shrink-0">{(['text', 'base64'] as const).map(mode => <button key={mode} type="button" aria-pressed={encoding === mode} disabled={saving} className={`px-2 py-1 text-xs ${encoding === mode ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`} onClick={() => {
      try { const converted = formatRows(rows, mode, true); if (draft) setDraft({ ...draft, rows: converted }); setEncoding(mode); setError(''); }
      catch { setError('Invalid base64 value. Fix it before switching to Text.'); }
    }}>{mode === 'text' ? 'Text' : 'Base64'}</button>)}</div>{!draft && <Button size="sm" onClick={() => setReveal(v => !v)}>{reveal ? 'Hide values' : 'Reveal values'}</Button>}{!draft && <Button size="sm" disabled={immutable || !context || (!k8s.demo && !item.raw?.metadata?.resourceVersion)} onClick={edit}>Edit data</Button>}</div>
    <p className="text-xs text-[var(--text-muted)] mb-2">{item.raw?.type ?? 'Opaque'} · Text is decoded automatically and saved as base64. Binary values use Base64 mode.</p>
    {immutable && <p className="text-xs text-[var(--status-warn)]">This Secret is immutable.</p>}
    {changed && <p role="alert" className="text-xs text-[var(--status-warn)]">The Secret changed while editing. Your draft is preserved. Cancel and edit again to load the latest version.</p>}
    {!rows.length && <p className="text-xs text-[var(--text-muted)]">No data keys</p>}
    <div className="flex flex-col gap-3">{rows.map(row => <div key={row.id} className="border-b border-[var(--border-subtle)] pb-3 min-w-0" aria-label={`Secret key ${row.key}`}>
      <div className="flex flex-wrap gap-2 items-center mb-1.5 min-w-0">{draft ? <input aria-label={`Key ${row.id + 1}`} className={`${field} flex-1 basis-40`} value={row.key} disabled={saving} autoComplete="off" spellCheck={false} onChange={e => update(row.id, { key: e.target.value })} /> : <span className="font-mono text-xs break-all flex-1">{row.key}</span>}
        {row.mode === 'base64' && encoding === 'text' && <span className="text-xs text-[var(--text-muted)] shrink-0" title="Binary value cannot be decoded as UTF-8">Binary · base64</span>}
        {draft && <Button size="sm" disabled={saving} aria-label={`Remove key ${row.id + 1}`} onClick={() => setDraft(d => d && ({ ...d, rows: d.rows.filter(r => r.id !== row.id) }))}>Remove</Button>}
      </div>
      {draft ? <textarea aria-label={`Value ${row.id + 1}`} className={`${field} resource-data-value kubiki-scrollbar resize-y min-h-20`} value={row.value} disabled={saving} autoComplete="off" spellCheck={false} onChange={e => update(row.id, { value: e.target.value })} /> : <pre tabIndex={0} aria-label={`Value for ${row.key}`} className="resource-data-value kubiki-scrollbar text-xs font-mono whitespace-pre-wrap break-all">{reveal ? row.value || '(empty)' : '••••••••'}</pre>}
    </div>)}</div>
    {error && <p role="alert" className="text-xs text-[var(--status-danger)] mt-2">{error}</p>}
    {saved && <p role="status" className="text-xs text-[var(--status-ok)] mt-2">{saved}</p>}
    {draft && <div className="flex flex-wrap gap-2 mt-3"><Button size="sm" disabled={saving} onClick={() => setDraft(d => d && ({ ...d, rows: [...d.rows, { id: Math.max(-1, ...d.rows.map(r => r.id)) + 1, key: '', value: '', mode: encoding }] }))}>Add key</Button><Button size="sm" disabled={saving || changed} onClick={() => void save()}>{saving ? 'Saving…' : 'Save data'}</Button><Button size="sm" disabled={saving} onClick={() => { setDraft(undefined); setError(''); setReveal(false); }}>Cancel</Button></div>}
  </section>;
}

function formatRows(rows: SecretRow[], mode: SecretRow['mode'], strict = false): SecretRow[] {
  return rows.map(row => {
    if (row.mode === mode) return row;
    if (mode === 'base64') return { ...row, mode, value: encodeText(row.value) };
    let bytes: Uint8Array;
    try { bytes = decodeBase64(row.value); } catch (error) { if (strict) throw error; return row; }
    try { return { ...row, mode, value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; }
    catch { return row; }
  });
}
