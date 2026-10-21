import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { useClusterStore } from '../../state/cluster_store';
import { useResourceStore } from '../../state/resource_store';
import { resourceRef } from '../../core/resources/identity';
import { decodeBase64, encodeSecretRows, validateSecretRows, encodeText, secretRows, type SecretRow } from '../../core/resources/secret_data';
import { mapK8sResource } from '../../core/utils/k8s_mapper';
import { k8s } from '../../providers/k8s_provider';
import type { ResourceItem } from '../../types/k8s';

const field = 'w-full min-w-0 rounded border border-[var(--border-default)] bg-[var(--bg-canvas)] px-2 py-1.5 font-mono text-xs';
export function SecretDataEditor({ item }: { item: ResourceItem }) {
  const sectionRef = useRef<HTMLElement>(null);
  const fieldPrefix = useId();
  const [validate, setValidate] = useState(false);
  const focusField = (id: number, field: 'key' | 'value' = 'key') => requestAnimationFrame(() => {
    sectionRef.current?.querySelector<HTMLElement>(`[data-secret-field="${id}-${field}"]`)?.focus();
  });
  const context = useClusterStore(s => s.currentContext);
  const [draft, setDraft] = useState<{ rows: SecretRow[]; version: string; context: string; resource: ReturnType<typeof resourceRef> }>();
  const [reveal, setReveal] = useState(false);
  const [encoding, setEncoding] = useState<SecretRow['mode']>('text');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    if (!reveal || draft) return;
    const timer = setTimeout(() => setReveal(false), 60000);
    return () => clearTimeout(timer);
  }, [reveal, draft]);
  const rows = draft?.rows ?? formatRows(secretRows(item.raw?.data ?? {}), encoding);
  const rowErrors = useMemo(() => validate ? validateSecretRows(draft?.rows ?? []) : new Map(), [draft, validate]);
  const changed = !!draft && (draft.version !== item.raw?.metadata?.resourceVersion || draft.context !== context);
  const immutable = item.raw?.immutable === true;
  const update = (id: number, patch: Partial<SecretRow>) => setDraft(d => d && ({ ...d, rows: d.rows.map(row => row.id === id ? { ...row, ...patch } : row) }));
  const edit = () => { setDraft({ rows: formatRows(secretRows(item.raw?.data ?? {}), encoding), version: item.raw?.metadata?.resourceVersion ?? '', context: context ?? '', resource: resourceRef(context ?? '', item) }); setReveal(false); setError(''); setSaved(''); setValidate(false); if (rows[0]) focusField(rows[0].id); };
  async function save() {
    if (!draft || !context || draft.context !== context || changed || saving) return;
    setError(''); setSaved(''); setValidate(true);
    const issues = validateSecretRows(draft.rows);
    const firstId = issues.keys().next().value;
    if (firstId !== undefined) { focusField(firstId, issues.get(firstId)?.key ? 'key' : 'value'); return; }
    try {
      const data = encodeSecretRows(draft.rows);
      setSaving(true);
      const raw = k8s.demo ? { ...item.raw, data } : await k8s.updateSecretData({ resource: draft.resource, resource_version: draft.version, data });
      if (useClusterStore.getState().currentContext !== draft.context) return;
      if (raw?.metadata?.uid !== item.uid || raw?.metadata?.name !== item.name || raw?.metadata?.namespace !== item.namespace) throw new Error('Unexpected Secret identity returned; refresh to verify saved state');
      useResourceStore.getState().updateItem('Secret', item.uid, mapK8sResource(raw, 'Secret'));
      setDraft(undefined); setReveal(false); setSaved(k8s.demo ? 'Saved in demo memory' : 'Secret data saved');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Secret update failed. Refresh to verify saved state'); }
    finally { setSaving(false); }
  }
  return <section ref={sectionRef} aria-label="Secret data" className="details-section p-3 min-w-0">
    <div className="flex flex-wrap items-center gap-2 mb-2"><h3 className="font-medium flex-1">Secret data ({rows.length})</h3><div role="group" aria-label="Secret value encoding" className="inline-flex rounded border border-[var(--border-default)] overflow-hidden shrink-0">{(['text', 'base64'] as const).map(mode => <button key={mode} type="button" aria-pressed={encoding === mode} disabled={saving} className={`px-2 py-1 text-xs ${encoding === mode ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`} onClick={() => {
      try { const converted = formatRows(rows, mode, true); if (draft) setDraft({ ...draft, rows: converted }); setEncoding(mode); setError(''); }
      catch { setError('Invalid base64 value. Fix it before switching to Text.'); if (draft) { setValidate(true); const id = validateSecretRows(rows).keys().next().value; if (id !== undefined) focusField(id, 'value'); } }
    }}>{mode === 'text' ? 'Text' : 'Base64'}</button>)}</div>{!draft && <Button size="sm" onClick={() => setReveal(v => !v)}>{reveal ? 'Hide values' : 'Reveal values'}</Button>}{!draft && <Button size="sm" disabled={immutable || !context || (!k8s.demo && !item.raw?.metadata?.resourceVersion)} onClick={edit}>Edit data</Button>}</div>
    <p className="text-xs text-[var(--text-muted)] mb-2">{item.raw?.type ?? 'Opaque'} · Text is decoded automatically and saved as base64. Binary values use Base64 mode.</p>
    {immutable && <p className="text-xs text-[var(--status-warn)]">This Secret is immutable.</p>}
    {draft && !changed && <p role="status" className="text-xs text-[var(--text-secondary)] mb-2">{saving ? "Saving changes…" : "Editing draft · changes are not saved yet"}</p>}
    {changed && <p role="alert" className="text-xs text-[var(--status-warn)]">The Secret changed while editing. Your draft is preserved. Cancel and edit again to load the latest version.</p>}
    {!rows.length && <p className="text-xs text-[var(--text-muted)]">No data keys</p>}
    <div className="flex flex-col gap-3">{rows.map(row => <div key={row.id} className="border-b border-[var(--border-subtle)] pb-3 min-w-0" aria-label={`Secret key ${row.key}`}>
      <div className="flex flex-wrap gap-2 items-center mb-1.5 min-w-0">{draft ? <input aria-label={`Key ${row.id + 1}`} data-secret-field={`${row.id}-key`} aria-invalid={!!rowErrors.get(row.id)?.key} aria-describedby={rowErrors.get(row.id)?.key ? `${fieldPrefix}-${row.id}-key` : undefined} className={`${field} flex-1 basis-40`} value={row.key} disabled={saving} autoComplete="off" spellCheck={false} onChange={e => update(row.id, { key: e.target.value })} /> : <span className="font-mono text-xs break-all flex-1">{row.key}</span>}
        {row.mode === 'base64' && encoding === 'text' && <span className="text-xs text-[var(--text-muted)] shrink-0" title="Binary value cannot be decoded as UTF-8">Binary · base64</span>}
        {draft && <Button size="sm" disabled={saving} aria-label={`Remove key ${row.id + 1}`} onClick={() => setDraft(d => d && ({ ...d, rows: d.rows.filter(r => r.id !== row.id) }))}>Remove</Button>}
      </div>
      {rowErrors.get(row.id)?.key && <p role="alert" id={`${fieldPrefix}-${row.id}-key`} className="text-xs text-[var(--status-danger)] mb-1.5">{rowErrors.get(row.id)?.key}</p>}
      {draft ? <textarea aria-label={`Value ${row.id + 1}`} data-secret-field={`${row.id}-value`} aria-invalid={!!rowErrors.get(row.id)?.value} aria-describedby={rowErrors.get(row.id)?.value ? `${fieldPrefix}-${row.id}-value` : undefined} className={`${field} resource-data-value kubiki-scrollbar resize-y min-h-20`} value={row.value} disabled={saving} autoComplete="off" spellCheck={false} onChange={e => update(row.id, { value: e.target.value })} /> : <pre tabIndex={0} aria-label={`Value for ${row.key}`} className="resource-data-value kubiki-scrollbar text-xs font-mono whitespace-pre-wrap break-all">{reveal ? row.value || '(empty)' : '••••••••'}</pre>}
      {rowErrors.get(row.id)?.value && <p role="alert" id={`${fieldPrefix}-${row.id}-value`} className="text-xs text-[var(--status-danger)] mt-1">{rowErrors.get(row.id)?.value}</p>}
    </div>)}</div>
    {error && <p role="alert" className="text-xs text-[var(--status-danger)] mt-2">{error}</p>}
    {saved && <p role="status" className="text-xs text-[var(--status-ok)] mt-2">{saved}</p>}
    {draft && <div className="flex flex-wrap gap-2 mt-3"><Button size="sm" disabled={saving} onClick={() => { if (!draft) return; const id = Math.max(-1, ...draft.rows.map(row => row.id)) + 1; setDraft({ ...draft, rows: [...draft.rows, { id, key: '', value: '', mode: encoding }] }); focusField(id); }}>Add key</Button><Button size="sm" disabled={saving || changed} onClick={() => void save()}>{saving ? 'Saving…' : 'Save data'}</Button><Button size="sm" disabled={saving} onClick={() => { setDraft(undefined); setError(''); setReveal(false); }}>Cancel</Button></div>}
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
